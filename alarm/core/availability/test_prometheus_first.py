"""Essential tests for Prometheus-first Availability architecture.

Guards:
1. Empty SQLite + Prometheus history produces complete daily dataset.
2. Fallback daily availability exactly matches canonical summarize_entries output.
3. Partial SQLite cache + Prometheus fallback has no gaps or duplicate dates.
4. Maintenance exclusion semantics are preserved identically.
5. Mixed fleets (probe_success + up) are correctly routed and weighted.

Run: python -m alarm.core.availability.test_prometheus_first
"""
from datetime import datetime, timezone
from urllib.parse import unquote

from alarm.core.availability.helpers import (
    _build_daily_downtime,
    WIB_OFFSET_SEC,
    _DAILY_PROMETHEUS_CACHE,
)
from alarm.core.availability.fleet import (
    derive_bucket_inputs,
    merge_hybrid_target_availability,
    summarize_entries,
)
import alarm.core.availability.helpers as helpers_module

HOUR = 3600.0
DAY = 86400.0
DAY0 = 1710028800.0 - WIB_OFFSET_SEC  # 2024-03-10 00:00:00 WIB


class MockPrometheusClient:
    def __init__(self, data_by_metric):
        self.data_by_metric = data_by_metric
        self._SHARED_EXECUTOR = None

    def fetch_prometheus_json(self, path, use_cache=True, cache_ttl=0, timeout=10.0, source=None):
        # Extract query from path; match longer query expressions first before base metric names
        decoded_path = unquote(path)
        for metric_name in sorted(self.data_by_metric.keys(), key=len, reverse=True):
            if metric_name in decoded_path:
                return {
                    "status": "success",
                    "data": {
                        "resultType": "matrix",
                        "result": self.data_by_metric[metric_name],
                    },
                }, "http://localhost:9090"
        return {"status": "success", "data": {"result": []}}, "http://localhost:9090"


def _make_matrix_result(instance, metric_name, day_values, start_ts=DAY0):
    """day_values: list of float values, one per day ending at start_ts + (i+1)*DAY."""
    values = []
    for i, val in enumerate(day_values):
        ts = start_ts + (i + 1) * DAY
        values.append([ts, str(val)])
    return {
        "metric": {"instance": instance, "job": "blackbox" if "probe" in metric_name else "node"},
        "values": values,
    }


def test_empty_sqlite_with_prometheus_history():
    """Empty SQLite + Prometheus history produces complete daily dataset matching summarize_entries."""
    _DAILY_PROMETHEUS_CACHE.clear()

    # 3 days: day 1: 100%, day 2: 95%, day 3: 100% for h1
    # For h2 (node): day 1: 100%, day 2: 100%, day 3: 90%
    data = {
        "probe_success": [_make_matrix_result("h1", "probe_success", [100.0, 95.0, 100.0])],
        "up": [_make_matrix_result("h2", "up", [100.0, 100.0, 90.0])],
        "count_over_time(probe_success": [_make_matrix_result("h1", "probe_count", [1440, 1440, 1440])],
        "count_over_time(up": [_make_matrix_result("h2", "up_count", [1440, 1440, 1440])],
        "changes(probe_success": [_make_matrix_result("h1", "probe_inc", [0, 2, 0])],
        "changes(up": [_make_matrix_result("h2", "up_inc", [0, 0, 2])],
        "probe_duration_seconds": [_make_matrix_result("h1", "duration", [5.0, 6.0, 5.0])],
    }

    orig_client = helpers_module.promclient
    helpers_module.promclient = MockPrometheusClient(data)
    try:
        req_start = DAY0
        req_end = DAY0 + 3 * DAY
        instances = ["h1", "h2"]

        daily = _build_daily_downtime(
            db_bucket_records=[],
            req_start=req_start,
            req_end=req_end,
            instances=instances,
            job="all",
            source="http://prom-a:9090",
        )

        assert len(daily) == 3, f"Expected 3 days, got {len(daily)}"
        expected_dates = ["2024-03-10", "2024-03-11", "2024-03-12"]
        assert [d["date"] for d in daily] == expected_dates

        # Day 1: both 100% -> 100.0% fleet
        assert daily[0]["availability_pct"] == 100.0
        assert daily[0]["hosts_down"] == 0
        assert daily[0]["events"] is None
        assert daily[0]["events_unavailable"] is True

        # Day 2: h1 has downtime -> hosts_down is 1
        assert daily[1]["hosts_down"] == 1
        assert daily[1]["availability_pct"] < 100.0

        # Day 3: h2 has downtime -> hosts_down is 1
        assert daily[2]["hosts_down"] == 1
        assert daily[2]["availability_pct"] < 100.0

        # Compare directly against canonical summarize_entries calculation for day 2
        d2_start = DAY0 + DAY
        d2_end = DAY0 + 2 * DAY
        d2_probe = {"avail": {"h1": 95.0}, "count": {"h1": 1440}, "incidents": {"h1": 2}}
        d2_up = {"avail": {"h2": 100.0}, "count": {"h2": 1440}, "incidents": {"h2": 0}}
        merged = derive_bucket_inputs(instances, d2_probe, d2_up)

        e1 = merge_hybrid_target_availability(
            d2_start, d2_end, "h1", "h1", "blackbox", [],
            {"avail": merged["avail"]["h1"], "count": merged["count"]["h1"], "incidents": merged["incidents"]["h1"], "duration": 6.0},
        )
        e2 = merge_hybrid_target_availability(
            d2_start, d2_end, "h2", "h2", "node", [],
            {"avail": merged["avail"]["h2"], "count": merged["count"]["h2"], "incidents": merged["incidents"]["h2"], "duration": 0.0},
        )
        canonical_summary = summarize_entries([e1, e2], period_minutes=1440.0)
        expected_pct = canonical_summary["fleet_aggregate"]["value"]

        assert daily[1]["availability_pct"] == expected_pct, (
            f"Daily fallback pct {daily[1]['availability_pct']} != canonical summarize_entries {expected_pct}"
        )
    finally:
        helpers_module.promclient = orig_client


def test_partial_sqlite_cache_with_prometheus_fallback():
    """Partial SQLite cache + Prometheus fallback produces seamless chronological dataset with no gaps or duplicates."""
    _DAILY_PROMETHEUS_CACHE.clear()

    # Day 1 is missing from SQLite.
    # Day 2 and Day 3 have SQLite rows.
    sqlite_rows = [
        # Day 2 (hour 0..23) for h1
        {
            "instance": "h1", "job": "blackbox",
            "bucket_start": DAY0 + DAY + h * HOUR,
            "bucket_end": DAY0 + DAY + (h + 1) * HOUR,
            "uptime_seconds": 3600.0 if h != 5 else 3300.0,
            "downtime_seconds": 0.0 if h != 5 else 300.0,
            "coverage_seconds": 3600.0,
            "outage_json": {"i": [[DAY0 + DAY + 5 * HOUR, DAY0 + DAY + 5 * HOUR + 300]]} if h == 5 else None,
        }
        for h in range(24)
    ] + [
        # Day 3 (hour 0..23) for h1
        {
            "instance": "h1", "job": "blackbox",
            "bucket_start": DAY0 + 2 * DAY + h * HOUR,
            "bucket_end": DAY0 + 2 * DAY + (h + 1) * HOUR,
            "uptime_seconds": 3600.0,
            "downtime_seconds": 0.0,
            "coverage_seconds": 3600.0,
            "outage_json": None,
        }
        for h in range(24)
    ]

    # Prometheus has data for day 1
    data = {
        "probe_success": [_make_matrix_result("h1", "probe_success", [99.0])],
        "count_over_time(probe_success": [_make_matrix_result("h1", "probe_count", [1440])],
        "changes(probe_success": [_make_matrix_result("h1", "probe_inc", [1])],
        "probe_duration_seconds": [_make_matrix_result("h1", "duration", [5.0])],
    }

    orig_client = helpers_module.promclient
    helpers_module.promclient = MockPrometheusClient(data)
    try:
        req_start = DAY0
        req_end = DAY0 + 3 * DAY
        daily = _build_daily_downtime(
            db_bucket_records=sqlite_rows,
            req_start=req_start,
            req_end=req_end,
            instances=["h1"],
            job="blackbox",
            source="http://prom-a:9090",
        )

        assert len(daily) == 3, f"Expected 3 days, got {len(daily)}"
        assert [d["date"] for d in daily] == ["2024-03-10", "2024-03-11", "2024-03-12"]

        # Day 1: reconstructed from Prometheus
        assert daily[0]["events"] is None
        assert daily[0]["events_unavailable"] is True
        assert daily[0]["availability_pct"] == 99.0

        # Day 2: cached in SQLite -> preserves exact outage interval!
        assert daily[1]["hosts_down"] == 1
        assert daily[1]["events"] is not None
        assert len(daily[1]["events"]) == 1
        assert daily[1]["events"][0]["duration_sec"] == 300.0

        # Day 3: cached in SQLite -> healthy
        assert daily[2]["availability_pct"] == 100.0
        assert daily[2]["hosts_down"] == 0
    finally:
        helpers_module.promclient = orig_client


def test_maintenance_semantics_preserved_in_fallback():
    """Maintenance windows are respected identically in the fallback path."""
    _DAILY_PROMETHEUS_CACHE.clear()

    # Day 1: h1 has 90% availability in Prometheus (10% downtime = 8640s)
    data = {
        "probe_success": [_make_matrix_result("h1", "probe_success", [90.0])],
        "count_over_time(probe_success": [_make_matrix_result("h1", "probe_count", [1440])],
        "changes(probe_success": [_make_matrix_result("h1", "probe_inc", [2])],
        "probe_duration_seconds": [_make_matrix_result("h1", "duration", [5.0])],
    }

    # Maintenance window covering the entire day: DAY0 to DAY0 + DAY
    maint_windows = [(DAY0, DAY0 + DAY)]

    orig_client = helpers_module.promclient
    helpers_module.promclient = MockPrometheusClient(data)
    try:
        daily_with_maint = _build_daily_downtime(
            db_bucket_records=[],
            req_start=DAY0,
            req_end=DAY0 + DAY,
            instances=["h1"],
            job="blackbox",
            source="http://prom-a:9090",
            maint_by_inst={"h1": maint_windows},
        )

        # Compare directly against canonical summarize_entries with maintenance
        e = merge_hybrid_target_availability(
            DAY0, DAY0 + DAY, "h1", "h1", "blackbox", [],
            {"avail": 90.0, "count": 1440, "incidents": 2, "duration": 5.0},
            maintenance_windows=maint_windows,
        )
        canonical = summarize_entries([e], period_minutes=1440.0)
        expected_pct = canonical["fleet_aggregate"]["value"]

        # Downtime in maintenance is carved out of SLA denominator
        assert daily_with_maint[0]["availability_pct"] == expected_pct, (
            f"Fallback maint pct {daily_with_maint[0]['availability_pct']} != canonical {expected_pct}"
        )
    finally:
        helpers_module.promclient = orig_client


if __name__ == "__main__":
    for name, fn in list(globals().items()):
        if name.startswith("test_") and callable(fn):
            fn()
            print(f"ok  {name}")
    print("all checks passed")


def test_partly_materialized_day_is_priced_from_prometheus():
    """SQLite holds 2 of 24 hours (backfill in progress): the day's % must be
    Prometheus's whole-day value, not those 2 hours; stored events are kept."""
    _DAILY_PROMETHEUS_CACHE.clear()
    data = {
        "probe_success": [_make_matrix_result("h1", "probe_success", [90.0])],
        "count_over_time(probe_success": [_make_matrix_result("h1", "probe_count", [5760])],
        "changes(probe_success": [_make_matrix_result("h1", "probe_inc", [2])],
    }
    rows = [{
        "instance": "h1", "job": "blackbox", "bucket_start": DAY0 + h * HOUR, "bucket_end": DAY0 + (h + 1) * HOUR,
        "coverage_seconds": 3600.0, "uptime_seconds": 1800.0, "downtime_seconds": 1800.0,
        "outage_json": {"i": [[DAY0 + h * HOUR, DAY0 + h * HOUR + 1800]]},
    } for h in (20, 21)]
    orig_client = helpers_module.promclient
    helpers_module.promclient = MockPrometheusClient(data)
    try:
        daily = _build_daily_downtime(rows, DAY0, DAY0 + DAY, instances=["h1"], job="all",
                                      cadence_map={"h1": 15.0}, source="http://prom-a:9090")
    finally:
        helpers_module.promclient = orig_client
    assert len(daily) == 1
    assert daily[0]["availability_pct"] != 50.0, daily[0]
    assert daily[0]["events_unavailable"] == "partial"
    assert daily[0]["events"], "stored per-host intervals must be kept"
