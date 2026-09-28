"""Regression checks for the Availability Trend / Downtime Calendar audit
(round 2). Every test names the audit finding it guards.

Run: python -m pytest alarm/core/availability/test_trend_calendar_audit.py
"""
import datetime as _dt
from unittest.mock import patch

import pytest

from alarm.core.availability import helpers
from alarm.core.availability.engine import AvailabilityEngine
from alarm.core.availability.fleet import merge_hybrid_fleet_availability
from alarm.core.availability.helpers import (
    WIB_OFFSET_SEC,
    _build_daily_downtime,
    _build_fleet_incidents,
    _build_fleet_trend,
)
from alarm.core.availability.models import AvailabilityQuery
from alarm.storage.repositories import availability as repo_mod

from alarm.core.availability.test_audit_regressions import DbRepo, Client, _incidents

H = 3600.0
DAY = 86400.0
SRC = "http://prom-a:9090"
# 2026-09-01 00:00 WIB
DAY0 = _dt.datetime(2026, 9, 1, tzinfo=_dt.timezone.utc).timestamp() - WIB_OFFSET_SEC


@pytest.fixture(autouse=True)
def _fresh_caches():
    """Module-level Prometheus caches must not leak one test's fake data into another."""
    helpers.clear_helpers_caches()
    yield
    helpers.clear_helpers_caches()


def row(inst, start, up=H, down=0.0, outages=None, job="blackbox", cov=None, ongoing_start=False, ongoing_end=False):
    cov = (up + down) if cov is None else cov
    oj = None
    if outages is not None:
        oj = {"i": outages, "ongoing_start": ongoing_start, "ongoing_end": ongoing_end}
    return {"instance": inst, "job": job, "bucket_start": start, "bucket_end": start + H,
            "uptime_seconds": up, "downtime_seconds": down, "coverage_seconds": cov,
            "unknown_seconds": H - cov, "sample_count": 240, "incident_count": 1 if down else 0,
            "availability_pct": 100.0 * up / cov if cov else None, "updated_at": 1.0, "outage_json": oj}


def no_prom():
    return [
        patch.object(helpers, "_query_prometheus_trend", return_value={}),
        patch.object(helpers, "_query_prometheus_daily_matrix", return_value={}),
        patch.object(helpers, "_query_prometheus_partial_day", return_value={}),
        _incidents([]),
    ]


class _Ctx:
    def __init__(self, patches):
        self.p = patches

    def __enter__(self):
        for p in self.p:
            p.__enter__()

    def __exit__(self, *a):
        for p in reversed(self.p):
            p.__exit__(*a)


class RecordingProm:
    """Prometheus query double: every instant query is recorded; h1/h2 are 100% up."""

    def __init__(self):
        self.exprs = []

    def fetch_prom_query_map(self, q, *a, **k):
        self.exprs.append(q)
        if "avg_over_time(probe_success" in q:
            return {"h1": "100", "h2": "100"}
        if "count_over_time(probe_success" in q:
            import re
            mins = int(re.search(r"\[(\d+)m\]", q).group(1))
            n = str(mins * 4)  # one sample every 15s for the whole queried range
            return {"h1": n, "h2": n}
        return {}

    def fetch_prom_range_map(self, *a, **k):
        return {}


def _engine(bucket_repo, job_map, prom=None):
    eng = AvailabilityEngine(prom_client=Client, prom_queries=prom or RecordingProm(), bucket_repo=bucket_repo)
    eng._scoped_job_map = lambda job, src: dict(job_map)
    eng._validate_whitelist = lambda src: None
    return eng


# ── H0: headline must not drop history SQLite hasn't materialized yet ──

def test_h0_headline_queries_prometheus_for_unmaterialized_history():
    end = DAY0 + 30 * DAY
    repo = DbRepo()
    rows = [row(i, end - (18 - h) * H) for h in range(18) for i in ("h1", "h2")]
    prom = RecordingProm()
    eng = _engine(repo, {"h1": "blackbox", "h2": "blackbox"}, prom)
    with patch.object(repo_mod, "AVAIL_TARGET_WHITELIST", None), _Ctx(no_prom()), \
         patch.object(AvailabilityEngine, "_resolve_maintenance_windows", return_value=None), \
         patch("alarm.core.availability.engine.get_instance_cadence_map", return_value={"h1": 15.0, "h2": 15.0}):
        repo.save_buckets(rows, SRC)
        rep = eng.get_availability(AvailabilityQuery(job="all", minutes=43200, end_ts=end)).to_dict()
    avail_q = [q for q in prom.exprs if q.startswith("avg_over_time(probe_success")]
    assert avail_q and all("[43200m]" in q for q in avail_q), avail_q
    assert rep["coverage_percent"] > 95.0, rep["coverage_percent"]


# ── H1 + S3: removed targets are in the headline AND in Trend/Calendar ──

def test_h1_removed_target_in_trend_calendar_and_headline():
    end = DAY0 + DAY
    repo = DbRepo()
    rows = [row("a", DAY0 + h * H) for h in range(24)]
    rows += [row("gone", DAY0 + h * H, up=0.0, down=H, outages=[[DAY0 + h * H, DAY0 + (h + 1) * H]],
                 ongoing_start=h > 0, ongoing_end=h < 23) for h in range(24)]
    eng = _engine(repo, {"a": "blackbox"})
    seen = []

    def maint(self, lo, hi, job, insts, src):
        seen.append(sorted(insts))
        return None

    with patch.object(repo_mod, "AVAIL_TARGET_WHITELIST", None), _Ctx(no_prom()), \
         patch.object(AvailabilityEngine, "_resolve_maintenance_windows", maint):
        repo.save_buckets(rows, SRC)
        rep = eng.get_availability(AvailabilityQuery(job="all", minutes=1440, end_ts=end)).to_dict()
    assert rep["overall"] == 50.0
    assert rep["daily"][0]["availability_pct"] == 50.0 and rep["daily"][0]["hosts_down"] == 1
    priced = [p["availability_pct"] for p in rep["trend"] if p["availability_pct"] is not None]
    assert priced and max(priced) == 50.0 and min(priced) == 50.0, rep["trend"]
    assert any(i["instance"] == "gone" for i in rep["trend_incidents"])
    assert any("gone" in s for s in seen), "S3: maintenance must be resolved for removed hosts too"


# ── H2 / S2: maintenance excluded the same way everywhere ──

def test_h2_maintenance_downtime_not_counted_in_calendar_or_ticks():
    lo, hi = DAY0, DAY0 + DAY
    rows = [row("h1", DAY0 + h * H) for h in range(24) if h not in (2, 3, 4)]
    rows.append(row("h1", DAY0 + 2 * H, up=0, down=H, outages=[[DAY0 + 2 * H, DAY0 + 3 * H]], ongoing_end=True))
    rows.append(row("h1", DAY0 + 3 * H, up=0, down=H, outages=[[DAY0 + 3 * H, DAY0 + 4 * H]], ongoing_start=True, ongoing_end=True))
    # down 04:00-04:30, maintenance only until 04:00 -> 30 min real downtime
    rows.append(row("h1", DAY0 + 4 * H, up=1800, down=1800, outages=[[DAY0 + 4 * H, DAY0 + 4.5 * H]], ongoing_start=True))
    maint = {"h1": [(DAY0 + 1 * H, DAY0 + 4 * H)]}
    with _Ctx(no_prom()):
        _, summ = merge_hybrid_fleet_availability(lo, hi, ["h1"], rows, {}, maintenance_by_instance=maint)
        daily = _build_daily_downtime(rows, lo, hi, instances=["h1"], maint_by_inst=maint)
        trend, _ = _build_fleet_trend(hi, DAY, ["h1"], db_bucket_records=rows, maint_by_inst=maint)
        inc = _build_fleet_incidents(rows, lo, hi, instances=["h1"], maint_by_inst=maint)
    d = daily[0]
    assert d["hosts_down"] == 1
    ivs = d["events"][0]["intervals"]
    assert ivs == [{"start_ts": int(DAY0 + 4 * H), "end_ts": int(DAY0 + 4.5 * H), "duration_sec": 1800.0,
                    "carried_in": True, "still_down": False}], ivs
    assert d["events"][0]["duration_sec"] == 1800.0
    # the one exact-interval source for the Trend ticks says the same thing
    assert [(i["start_ts"], i["carried_in"]) for i in inc[0]["intervals"]] == [(int(DAY0 + 4 * H), True)]
    # the three numbers agree: 1800s down over (24h - 3h maintenance)
    expected = round(100.0 * (21 * H - 1800) / (21 * H), 2)
    assert summ["fleet_aggregate"]["value"] == expected
    assert d["availability_pct"] == expected
    slot = {p["ts"]: p for p in trend}[DAY0 + 5 * H]
    assert slot["availability_pct"] == 50.0


def test_h2_fully_excused_outage_leaves_no_trace():
    lo, hi = DAY0, DAY0 + DAY
    rows = [row("h1", DAY0 + h * H) for h in range(24) if h != 2]
    rows.append(row("h1", DAY0 + 2 * H, up=0, down=H, outages=[[DAY0 + 2 * H, DAY0 + 3 * H]]))
    maint = {"h1": [(DAY0 + 1 * H, DAY0 + 4 * H)]}
    with _Ctx(no_prom()):
        daily = _build_daily_downtime(rows, lo, hi, instances=["h1"], maint_by_inst=maint)
        inc = _build_fleet_incidents(rows, lo, hi, instances=["h1"], maint_by_inst=maint)
    assert daily[0]["availability_pct"] == 100.0
    assert daily[0]["hosts_down"] == 0 and daily[0]["events"] == []
    assert inc == []


def test_h2_live_incident_inside_maintenance_not_drawn():
    lo, hi = DAY0, DAY0 + 6 * H
    rows = [row("h1", DAY0 + h * H) for h in range(6)]
    live = [{"instance": "h1", "name": "InstanceDown", "time": DAY0 + 5 * H, "job": "blackbox"}]
    maint = {"h1": [(DAY0 + 4 * H, DAY0 + 7 * H)]}
    with _incidents(live), patch.object(helpers, "DOWN_ALERTNAMES", frozenset({"InstanceDown"})):
        inc = _build_fleet_incidents(rows, lo, hi, instances=["h1"], maint_by_inst=maint)
    assert inc == []


def test_s2_prometheus_priced_day_hosts_down_excludes_maintenance():
    lo, hi = DAY0, DAY0 + DAY
    d_str = "2026-09-01"
    matrix = {"probe_avail": {d_str: {"h1": 50.0}}, "probe_count": {d_str: {"h1": 5760.0}},
              "probe_incidents": {d_str: {"h1": 2.0}}}
    maint = {"h1": [(lo, hi)]}
    with patch.object(helpers, "_query_prometheus_daily_matrix", return_value=matrix), \
         patch.object(helpers, "_query_prometheus_partial_day", return_value={}):
        daily = _build_daily_downtime([], lo, hi, instances=["h1"], maint_by_inst=maint, cadence_map={"h1": 15.0})
    assert daily[0]["hosts_down"] == 0, daily


# ── H3 / S1: zoom detail never discards stored history ──

def _trend_engine(records):
    class Repo:
        called = False

        def get_bucket_records(self, *a, **k):
            Repo.called = True
            return records

    eng = AvailabilityEngine(prom_client=Client, bucket_repo=Repo())
    eng._scoped_job_map = lambda job, src: {"h1": "blackbox"}
    return eng, Repo


def test_h3_zoom_over_180h_uses_sqlite_when_prometheus_lacks_it():
    start = DAY0 - 30 * DAY
    end = start + 10 * DAY
    recs = [row("h1", start + h * H, up=0.0, down=H, outages=[[start + h * H, start + (h + 1) * H]]) for h in range(240)]
    eng, Repo = _trend_engine(recs)
    with patch.object(AvailabilityEngine, "_resolve_maintenance_windows", return_value=None), \
         patch.object(helpers, "_query_prometheus_trend", return_value={}), \
         patch("alarm.core.availability.engine.time.time", return_value=DAY0):
        out = eng.get_trend("all", start, end)
    priced = [p for p in out["trend"] if p["availability_pct"] is not None]
    assert Repo.called and len(priced) == 120 and all(p["availability_pct"] == 0.0 for p in priced), out


def test_s1_zoom_detail_prefers_hourly_when_subhour_leaves_holes():
    start = DAY0
    end = start + 24 * H
    recs = [row("h1", start + h * H) for h in range(24)]

    def prom(job, instances, s, e, slot, timeout, source=None, **k):
        if slot >= 3600:
            return {}
        # Prometheus only still holds the last 15 hours (>50%, so the old rule kept the holes)
        return {int(t): {"h1": (float(slot), float(slot))}
                for t in range(int(s), int(e) + 1, int(slot)) if t > end - 15 * H}

    eng, _ = _trend_engine(recs)
    with patch.object(AvailabilityEngine, "_resolve_maintenance_windows", return_value=None), \
         patch.object(helpers, "_query_prometheus_trend", side_effect=prom), \
         patch("alarm.core.availability.engine.time.time", return_value=end + 60):
        out = eng.get_trend("all", start, end)
    priced = [p for p in out["trend"] if p["availability_pct"] is not None]
    assert out["trend_bucket_seconds"] == 3600 and len(priced) == 24, (out["trend_bucket_seconds"], len(priced))


# ── H4: a mostly-unobserved day is never a clean 100% ──

def test_h4_mostly_unobserved_day_carries_coverage_and_limited_flag():
    lo, hi = DAY0, DAY0 + DAY
    rows = [row("h1", DAY0 + h * H) for h in (0, 1)]
    with _Ctx(no_prom()):
        d = _build_daily_downtime(rows, lo, hi, instances=["h1"])[0]
    assert d["availability_pct"] == 100.0
    assert round(d["coverage_pct"], 1) == 8.3 and d["limited_data"] is True, d


def test_h4_full_day_not_flagged():
    lo, hi = DAY0, DAY0 + DAY
    rows = [row("h1", DAY0 + h * H) for h in range(24)]
    with _Ctx(no_prom()):
        d = _build_daily_downtime(rows, lo, hi, instances=["h1"])[0]
    assert d["coverage_pct"] == 100.0 and d["limited_data"] is False


# ── M1: a bucket straddling the window edge is clipped with its exact intervals ──

def test_m1_edge_bucket_outage_outside_window_counts_nowhere():
    lo = DAY0 + 9.5 * H
    hi = lo + 24 * H
    rows = [row("h1", DAY0 + 9 * H, up=2400.0, down=1200.0, outages=[[DAY0 + 9 * H, DAY0 + 9 * H + 1200]])]
    rows += [row("h1", DAY0 + h * H) for h in range(10, 34)]
    with _Ctx(no_prom()):
        _, summ = merge_hybrid_fleet_availability(lo, hi, ["h1"], rows, {})
        daily = _build_daily_downtime(rows, lo, hi, instances=["h1"])
        trend, _ = _build_fleet_trend(hi, 24 * H, ["h1"], db_bucket_records=rows)
        inc = _build_fleet_incidents(rows, lo, hi, instances=["h1"])
    assert summ["fleet_aggregate"]["value"] == 100.0
    assert daily[0]["availability_pct"] == 100.0 and daily[0]["hosts_down"] == 0
    assert all(p["availability_pct"] == 100.0 for p in trend if p["availability_pct"] is not None)
    assert inc == []


def test_m1_edge_bucket_outage_inside_window_clipped_exactly():
    lo = DAY0 + 9.5 * H
    hi = lo + 24 * H
    # down 09:40-09:50: fully inside the window though the bucket starts at 09:00
    rows = [row("h1", DAY0 + 9 * H, up=3000.0, down=600.0, outages=[[DAY0 + 9 * H + 2400, DAY0 + 9 * H + 3000]])]
    rows += [row("h1", DAY0 + h * H) for h in range(10, 34)]
    with _Ctx(no_prom()):
        entries, summ = merge_hybrid_fleet_availability(lo, hi, ["h1"], rows, {})
        daily = _build_daily_downtime(rows, lo, hi, instances=["h1"])
    assert entries[0]["downtime_seconds"] == 600.0
    assert daily[0]["hosts_down"] == 1 and daily[0]["events"][0]["duration_sec"] == 600.0


# ── M2 / S4: the in-progress slot is priced, never held from the previous one ──

def test_m2_inprogress_slot_filled_from_prometheus_at_unaligned_end():
    end = DAY0 + 10.5 * H
    rows = [row(i, DAY0 + h * H) for h in range(10) for i in ("a", "b")]
    calls = []

    def prom(job, instances, s, e, slot, timeout, source=None, window=None, **k):
        calls.append((s, e, slot, window))
        if s == e == end:
            w = window or slot
            return {int(end): {"a": (0.0, float(w)), "b": (0.0, float(w))}}
        return {}

    with patch.object(helpers, "_query_prometheus_trend", side_effect=prom):
        trend, _ = _build_fleet_trend(end, 24 * H, ["a", "b"], db_bucket_records=rows, source=SRC)
    last = trend[-1]
    assert last["ts"] == end and last["availability_pct"] == 0.0, (trend[-2:], calls)
    assert any(c[3] == 1800 for c in calls), calls


# ── M3: every Prometheus query is scoped to the view's job and picks the host's own series ──

def test_m3_trend_fill_filters_job_and_prefers_own_series():
    exprs = []

    def fake(path, **kw):
        from urllib.parse import unquote
        q = unquote(path.split("query=")[1].split("&")[0])
        exprs.append(q)
        if "probe_success" in q:
            return ({"status": "success", "data": {"result": [
                {"metric": {"instance": "h1", "job": "ping"}, "values": [[1000, "0"]]},
                {"metric": {"instance": "h1", "job": "http"}, "values": [[1000, "1"]]},
            ]}}, None)
        return ({"status": "success", "data": {"result": []}}, None)

    with patch.object(helpers.promclient, "fetch_prometheus_json", side_effect=fake):
        out = helpers._query_prometheus_trend("ping", ["h1"], 1000, 1000, 3600, 5, source=SRC,
                                              prefer_job={"h1": "ping"})
    assert all('job="ping"' in e for e in exprs), exprs
    assert out[1000]["h1"][0] == 0.0, out


def test_m3_query_map_prefers_instance_job():
    from alarm.core.monitoring import queries

    res = {"status": "success", "data": {"result": [
        {"metric": {"instance": "g", "job": "gitlab-rails"}, "value": [0, "1"]},
        {"metric": {"instance": "g", "job": "node"}, "value": [0, "0"]},
    ]}}
    with patch.object(queries._pc, "fetch_prometheus_json", return_value=(res, None)):
        assert queries.fetch_prom_query_map("up", prefer_job={"g": "gitlab-rails"})["g"] == "1"
        assert queries.fetch_prom_query_map("up", prefer_job={"g": "node"})["g"] == "0"


def test_m3_headline_queries_carry_job_filter():
    end = DAY0 + DAY
    prom = RecordingProm()
    eng = _engine(DbRepo(), {"h1": "gitlab-rails"}, prom)
    with patch.object(repo_mod, "AVAIL_TARGET_WHITELIST", None), _Ctx(no_prom()), \
         patch.object(AvailabilityEngine, "_resolve_maintenance_windows", return_value=None):
        eng.get_availability(AvailabilityQuery(job="gitlab-rails", minutes=1440, end_ts=end))
    metric_q = [q for q in prom.exprs if "probe_success" in q or "up" in q]
    assert metric_q and all('job="gitlab-rails"' in q for q in metric_q), metric_q


# ── P1: a correct 30d/MTD report costs ~70s cold; polls must never wait on it ──

def test_p1_long_window_cache_survives_pruning_and_is_minute_stable():
    from alarm.core.availability._cache import AvailabilityCache
    k1, ttl = AvailabilityCache.derive_cache_key("http://p", "all", 43200, None, 99.9, 30, 0, now=1_000_000.0)
    k2, _ = AvailabilityCache.derive_cache_key("http://p", "all", 43200, None, 99.9, 30, 0, now=1_000_000.0 + 240)
    assert k1 == k2 and ttl >= 900, (k1, k2, ttl)
    # MTD grows a minute per minute: consecutive polls share one key
    m1, _ = AvailabilityCache.derive_cache_key("http://p", "all", 38000, None, 99.9, 30, 0, now=1_000_000.0)
    m2, _ = AvailabilityCache.derive_cache_key("http://p", "all", 38003, None, 99.9, 30, 0, now=1_000_000.0 + 180)
    assert m1 == m2, (m1, m2)
    c = AvailabilityCache()
    c.set(k1, {"x": 1}, now=0.0)
    c.get("other", ttl, now=500.0)  # triggers a prune pass
    assert c.get(k1, ttl, now=500.0) == {"x": 1}, "an entry inside its TTL must not be pruned"


def test_p1_live_long_window_serves_previous_report_while_refreshing():
    import threading
    import time as _time
    end = DAY0 + 30 * DAY
    repo = DbRepo()
    rows = [row(i, DAY0 + h * H) for h in range(int(30 * 24)) for i in ("h1",)]
    eng = _engine(repo, {"h1": "blackbox"})
    computed = []

    def slowed(real):
        def slow(self, *a, **k):
            computed.append(threading.current_thread().name)
            if len(computed) > 1:
                _time.sleep(0.5)
            return real(self, *a, **k)
        return slow

    clock = {"t": end}
    with patch.object(repo_mod, "AVAIL_TARGET_WHITELIST", None), _Ctx(no_prom()), \
         patch.object(AvailabilityEngine, "_resolve_maintenance_windows", return_value=None), \
         patch.object(AvailabilityEngine, "_compute_fast_path_payload",
                      slowed(AvailabilityEngine._compute_fast_path_payload)), \
         patch.object(AvailabilityEngine, "_compute_hybrid_path_payload",
                      slowed(AvailabilityEngine._compute_hybrid_path_payload)), \
         patch("alarm.core.availability.engine.time.time", side_effect=lambda: clock["t"]):
        repo.save_buckets(rows, SRC)
        first = eng.get_availability(AvailabilityQuery(job="all", minutes=43200))
        clock["t"] = end + 1000  # next 15-min cache bucket: cold again
        t0 = _time.perf_counter()
        second = eng.get_availability(AvailabilityQuery(job="all", minutes=43200))
        waited = _time.perf_counter() - t0
        for th in threading.enumerate():
            if th.name.startswith("avail-refresh"):
                th.join(5)
    assert waited < 0.4, f"poll waited {waited:.2f}s on a cold recompute"
    assert second.to_dict()["overall"] == first.to_dict()["overall"]
    assert len(computed) == 2 and computed[1].startswith("avail-refresh"), computed
