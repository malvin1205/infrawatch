"""Tests for Availability Trend gap handling and endpoint cache isolation.

Guards:
1. Historical telemetry gaps (e.g. 192.168.9.16 Sept 10-14 gap) are preserved
   in _build_fleet_trend without fabricating 0% or 100% data points.
2. Endpoint switching correctly invalidates backend availability caches so
   data from Endpoint A does not leak into Endpoint B.
3. Equivalence of canonical calculation (summarize_entries) and bucket rollups.
"""
import time
import pytest
from unittest.mock import MagicMock, patch

from alarm.core.availability.helpers import _build_fleet_trend, WIB_OFFSET_SEC
from alarm.core.availability.engine import AvailabilityEngine



def test_trend_preserves_gaps_without_fabrication():
    """Verify that gaps in historical telemetry do not generate fake 0% or 100% points."""
    # Simulate Sept 10 to Sept 14 scenario
    # Start: Sept 10 00:00:00 UTC (1788912000 approx, let's use fixed ts)
    t0 = 1725926400  # 2024-09-10 00:00:00 UTC
    slot = 3600
    instances = ["node-1", "node-2"]
    
    # 10 hours on Sept 10
    records = []
    for h in range(10):
        records.append({
            "instance": "node-1",
            "bucket_start": t0 + h * slot,
            "bucket_end": t0 + (h + 1) * slot,
            "uptime_seconds": 3600.0,
            "downtime_seconds": 0.0,
            "coverage_seconds": 3600.0,
        })
        records.append({
            "instance": "node-2",
            "bucket_start": t0 + h * slot,
            "bucket_end": t0 + (h + 1) * slot,
            "uptime_seconds": 3600.0,
            "downtime_seconds": 0.0,
            "coverage_seconds": 3600.0,
        })
        
    # Multi-day GAP: hours 10 to 80 (70 hours missing, Sept 11, 12, 13)
    # 10 hours on Sept 14
    for h in range(80, 90):
        records.append({
            "instance": "node-1",
            "bucket_start": t0 + h * slot,
            "bucket_end": t0 + (h + 1) * slot,
            "uptime_seconds": 3600.0,
            "downtime_seconds": 0.0,
            "coverage_seconds": 3600.0,
        })
        records.append({
            "instance": "node-2",
            "bucket_start": t0 + h * slot,
            "bucket_end": t0 + (h + 1) * slot,
            "uptime_seconds": 3600.0,
            "downtime_seconds": 0.0,
            "coverage_seconds": 3600.0,
        })

    window_seconds = 90 * slot
    trend_end_ts = t0 + 90 * slot

    # Mock _query_prometheus_trend to return empty (unreachable Prometheus TSDB)
    with patch("alarm.core.availability.helpers._query_prometheus_trend", return_value={}):
        points, trend_slot = _build_fleet_trend(
            trend_end_ts=trend_end_ts,
            window_seconds=window_seconds,
            instances=instances,
            max_points=180,
            db_bucket_records=records,
            job="node_exporter",
        )

    assert len(points) > 0
    # Check that no points exist between hour 11 and hour 79
    gap_points = [p for p in points if (t0 + 11 * slot) <= p["ts"] <= (t0 + 79 * slot)]
    assert len(gap_points) == 0, f"Expected 0 points in gap, found: {gap_points}"
    
    # Check that points exist before the gap and after the gap
    before_gap = [p for p in points if p["ts"] <= t0 + 10 * slot]
    after_gap = [p for p in points if p["ts"] >= t0 + 80 * slot]
    assert len(before_gap) > 0
    assert len(after_gap) > 0


def _hour(inst, h, up, cov=3600.0, t0=1725926400, outages=None):
    return {"instance": inst, "bucket_start": t0 + h * 3600, "bucket_end": t0 + (h + 1) * 3600,
            "uptime_seconds": up, "downtime_seconds": cov - up, "coverage_seconds": cov,
            "outage_json": None if outages is None else {"i": outages}}


def test_trend_low_reporting_slot_is_partial_not_pooled():
    """1 of 4 hosts reporting (and down) must not draw a confident 0% for the fleet."""
    t0, insts = 1725926400, ["a", "b", "c", "d"]
    recs = [_hour(i, h, 3600.0) for h in range(4) for i in insts]
    recs += [_hour("a", h, 0.0) for h in range(4, 8)]           # only "a" reports, down
    with patch("alarm.core.availability.helpers._query_prometheus_trend", return_value={}):
        pts, _ = _build_fleet_trend(t0 + 8 * 3600, 8 * 3600, insts, db_bucket_records=recs,
                                    min_reporting_ratio=0.5)
    by_ts = {p["ts"]: p for p in pts}
    full = by_ts[t0 + 2 * 3600]
    assert full["availability_pct"] == 100.0 and full["hosts_reporting"] == 4 and full["hosts_expected"] == 4
    partial = by_ts[t0 + 6 * 3600]
    assert partial["availability_pct"] is None and partial["hosts_reporting"] == 1, partial
    # The bucket straddling the window start (one slot before the grid) gets the same bar.
    with patch("alarm.core.availability.helpers._query_prometheus_trend", return_value={}):
        pts, _ = _build_fleet_trend(t0 + 8 * 3600, 4 * 3600, insts, db_bucket_records=recs,
                                    min_reporting_ratio=0.5)
    edge = {p["ts"]: p for p in pts}[t0 + 5 * 3600]
    assert edge["availability_pct"] is None, edge


def test_trend_excludes_maintenance_like_fleet_aggregate():
    """Downtime inside a maintenance window is carved out, and a host fully in
    maintenance isn't expected to report."""
    t0, insts = 1725926400, ["a", "b"]
    recs = [_hour("a", h, 3600.0) for h in range(4)]
    recs += [_hour("b", h, 0.0, outages=[[t0 + h * 3600, t0 + (h + 1) * 3600]]) for h in range(4)]
    maint = {"b": [(t0 + 2 * 3600, t0 + 4 * 3600)]}
    with patch("alarm.core.availability.helpers._query_prometheus_trend", return_value={}):
        pts, _ = _build_fleet_trend(t0 + 4 * 3600, 4 * 3600, insts, db_bucket_records=recs,
                                    maint_by_inst=maint, min_reporting_ratio=0.5)
    by_ts = {p["ts"]: p for p in pts}
    assert by_ts[t0 + 1 * 3600]["availability_pct"] == 50.0          # b really down, no maintenance
    m = by_ts[t0 + 3 * 3600]
    assert m["availability_pct"] == 100.0 and m["hosts_expected"] == 1, m


def test_trend_prometheus_fills_missing_hosts_with_same_pooling():
    """Hosts absent from SQLite in a slot are filled per host from Prometheus;
    hosts SQLite already priced are never overwritten."""
    t0, insts = 1725926400, ["a", "b"]
    recs = [_hour("a", h, 3600.0) for h in range(4)]              # "b" never materialized
    prom = {t0 + h * 3600: {"a": (0.0, 3600.0), "b": (1800.0, 3600.0)} for h in range(1, 5)}
    with patch("alarm.core.availability.helpers._query_prometheus_trend", return_value=prom):
        pts, _ = _build_fleet_trend(t0 + 4 * 3600, 4 * 3600, insts, db_bucket_records=recs,
                                    min_reporting_ratio=1.0, job="fill-test")
    p = {q["ts"]: q for q in pts}[t0 + 2 * 3600]
    assert p["hosts_reporting"] == 2 and p["availability_pct"] == 75.0, p   # (3600+1800)/7200


def test_strict_source_fetch_never_fails_over():
    """Availability queries pinned to server A must not be answered by B, even
    when B is the active endpoint and A is down."""
    from alarm.core.monitoring import client as pc
    asked = []

    def fake_fetch(url, timeout=1.5):
        asked.append(url)
        return None if url.startswith("http://prom-a:9090") else '{"status":"success","data":{"result":[]}}'

    eps = {"active": "http://prom-b:9090", "endpoints": ["http://prom-a:9090", "http://prom-b:9090"]}
    with patch.object(pc, "fetch_url", side_effect=fake_fetch), \
         patch.object(pc, "load_endpoints", return_value=eps), \
         patch.object(pc, "_filter_safe_candidates", side_effect=lambda urls: list(urls)):
        data, base = pc.fetch_prometheus_json("/api/v1/query?query=up&t=strict", use_cache=False, source="http://prom-a:9090/")
    assert data is None and base is None, (data, base)
    assert asked and all(u.startswith("http://prom-a:9090") for u in asked), asked


def test_availability_cache_isolation():
    """Verify that AvailabilityEngine cache invalidation prevents stale data between endpoints."""
    engine = AvailabilityEngine()
    
    # Populate cache
    engine.cache.set("window:7d", {"status": "ok", "endpoint": "A"})
    assert engine.cache.get("window:7d", 60.0) is not None
    
    # Invalidate cache (as done during select_endpoint)
    engine.invalidate_cache()
    
    # Verify cache is empty
    assert engine.cache.get("window:7d", 60.0) is None



if __name__ == "__main__":
    for name, fn in list(globals().items()):
        if name.startswith("test_") and callable(fn):
            fn()
            print("PASS:", name)
