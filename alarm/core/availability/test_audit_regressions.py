"""Regression checks for the availability audit (backfill false-completion,
fabricated uptime/intervals, calendar/trend consistency).

Run: python -m pytest alarm/core/availability/test_audit_regressions.py
"""
import json
import math
import os
import tempfile
import time
from unittest.mock import patch

from alarm.storage.schema import init_db
from alarm.storage.repositories import availability as repo_mod
from alarm.storage.repositories.availability import AvailabilityBucketRepository as Repo
from alarm.core.availability import engine as engine_mod
from alarm.core.availability.engine import (
    AvailabilityEngine,
    AVAIL_BACKFILL_CHUNK_SECONDS,
    AVAIL_BACKFILL_MAX_CHUNK_FAILURES,
    AVAIL_BACKFILL_RETRY_SECONDS,
    AVAIL_BACKFILL_SECONDS,
    _parse_prom_duration,
)
from alarm.core.availability.helpers import (
    WIB_OFFSET_SEC,
    _build_daily_downtime,
    _build_fleet_incidents,
    _build_fleet_trend,
)

H = 3600.0
DAY = 86400.0
SRC = "http://prom-a:9090"


def _incidents(value):
    """Patch the IncidentRepository _build_fleet_incidents actually imports
    (`storage.` when alarm/ is on sys.path, else `alarm.storage.`)."""
    try:
        from storage.repositories.alerts import IncidentRepository
    except (ImportError, ValueError):
        from alarm.storage.repositories.alerts import IncidentRepository
    return patch.object(IncidentRepository, "get_active_incidents", return_value=value)


class DbRepo:
    """The real SQLite repository, bound to a throwaway database."""

    def __init__(self):
        self.db = os.path.join(tempfile.mkdtemp(), "t.db")
        init_db(self.db)

    def __getattr__(self, name):
        fn = getattr(Repo, name)
        return lambda *a, **k: fn(*a, db_path=self.db, **k)


class Client:
    _SHARED_EXECUTOR = None

    @staticmethod
    def load_endpoints():
        return {"active": SRC}

    @staticmethod
    def fetch_prometheus_json(*a, **k):
        return None, None


class Prom:
    """h1 is 90% up over the window; the raw-sample fetch can be made to fail."""

    def __init__(self, raw=None, avail_ok=True):
        self.raw = raw or {}
        self.avail_ok = avail_ok

    def fetch_prom_query_map(self, q, *a, **k):
        if "avg_over_time(probe_success" in q:
            return {"h1": "90", "h2": "100"} if self.avail_ok else {}
        if "count_over_time(probe_success" in q:
            return {"h1": "1800", "h2": "1800"}
        if "changes(probe_success" in q:
            return {"h1": "2", "h2": "0"}
        return {}

    def fetch_prom_range_map(self, expr, *a, **k):
        return self.raw if expr == "probe_success" else {}


def _agg_engine(prom, windows=(), depth=None):
    eng = AvailabilityEngine(prom_client=Client, prom_queries=prom, bucket_repo=DbRepo())
    eng._scoped_job_map = lambda job, src: {"h1": "blackbox", "h2": "blackbox"}
    eng._validate_whitelist = lambda src: None
    eng._availability_aggregation_windows = lambda *a, **k: list(windows)
    eng._next_depth_backfill_window = lambda *a: depth
    return eng


def _now():
    return math.floor(1_790_000_000 / H) * H + 120.0


def _row(inst, start, down=0.0, outage=None, cov=H):
    return {"instance": inst, "job": "blackbox", "bucket_start": start, "bucket_end": start + H,
            "uptime_seconds": cov - down, "downtime_seconds": down, "unknown_seconds": H - cov,
            "coverage_seconds": cov, "sample_count": 1800, "availability_pct": 100.0 * (cov - down) / cov,
            "updated_at": 1.0, "outage_json": outage}


# ── backfill: materialization is judged by quality, not row count ──

def test_failed_raw_fetch_is_not_marked_materialized():
    now = _now()
    w = (now - 120 - H, now - 120)
    eng = _agg_engine(Prom(raw={}), depth=w)
    eng._deep_cursor = w[0]
    with patch.object(repo_mod, "AVAIL_TARGET_WHITELIST", None):
        for attempt in range(1, AVAIL_BACKFILL_MAX_CHUNK_FAILURES):
            eng.aggregate_hourly_buckets(now=now)
            assert eng.bucket_repo.get_bucket_records("all", *w, source=SRC) == [], "nothing persisted on failure"
            assert eng._deep_cursor == w[1], "cursor rewound so the same chunk is retried"
        # Give up after N failures: fallback is stored, but still NOT materialized.
        eng.aggregate_hourly_buckets(now=now)
        rows = eng.bucket_repo.get_bucket_records("all", *w, source=SRC)
        assert rows and any(r["downtime_seconds"] > 0 and not r["outage_json"] for r in rows)
        assert not eng._chunk_materialized(["h1", "h2"], w[0], w[1], SRC)
        assert "h1" not in eng.bucket_repo.get_instance_bucket_coverage(["h1"], source=SRC)


def test_downtime_without_outage_json_counts_as_hole():
    eng = AvailabilityEngine(prom_client=Client, bucket_repo=DbRepo())
    t0 = 1_790_000_000 // 3600 * 3600.0
    rows = [_row("h1", t0 + i * H) for i in range(6)]
    for i in (2, 3):  # downtime, no intervals (scalar fallback / legacy rows)
        rows[i] = _row("h1", t0 + i * H, down=60.0)
    with patch.object(repo_mod, "AVAIL_TARGET_WHITELIST", None):
        eng.bucket_repo.save_buckets(rows, SRC)
        span = eng.bucket_repo.get_instance_bucket_coverage(["h1"], source=SRC)["h1"]
        assert span == (t0, 4)
        assert not eng._chunk_materialized(["h1"], t0, t0 + 6 * H, SRC)
        assert eng._is_under_materialized(span, t0 + 6 * H, t0), "2 hours without intervals = hole"

        for i in (2, 3):
            rows[i] = _row("h1", t0 + i * H, down=60.0, outage={"i": [[t0 + i * H, t0 + i * H + 60]]})
        eng.bucket_repo.save_buckets(rows, SRC)
        assert eng.bucket_repo.get_instance_bucket_coverage(["h1"], source=SRC)["h1"] == (t0, 6)
        assert eng._chunk_materialized(["h1"], t0, t0 + 6 * H, SRC)


def test_single_host_hole_in_large_fleet_is_swept():
    now = time.time()
    hour_end = math.floor(now / H) * H
    floor = hour_end - AVAIL_BACKFILL_SECONDS
    hosts = [f"h{i}" for i in range(20)]
    hole = {hour_end - 10 * DAY, hour_end - 10 * DAY + H}  # host h7 misses 2h

    class Repo20:
        def get_instance_bucket_coverage(self, instances=None, source=None, since=None):
            full = int(round((hour_end - floor) / H))
            return {i: (floor, full - (2 if i == "h7" else 0)) for i in instances}

        def get_bucket_records(self, job, start, end, instances=None, source=None):
            return [{"instance": i, "bucket_start": h, "downtime_seconds": 0, "outage_json": None}
                    for i in instances for h in range(int(start), int(end), int(H))
                    if not (i == "h7" and h in hole)]

    eng = AvailabilityEngine(bucket_repo=Repo20())
    swept = set()
    for _ in range(int(AVAIL_BACKFILL_SECONDS / AVAIL_BACKFILL_CHUNK_SECONDS) + 10):
        w = eng._next_depth_backfill_window(hosts, now, SRC)
        if w is None:
            break
        swept.update(range(int(w[0]), int(w[1]), int(H)))
    assert hole <= swept, "a 2h hole on 1 of 20 hosts must be swept (no fleet-wide 95%)"
    assert len(swept) < 10 * H / H * 24, "complete chunks are skipped, not re-fetched"


def test_stale_sweep_retries_after_backoff():
    now = time.time()
    hour_end = math.floor(now / H) * H

    class Ghost:
        def get_instance_bucket_coverage(self, instances=None, source=None, since=None):
            return {"ghost": (hour_end - H, 1)}  # Prometheus has nothing older

    eng = AvailabilityEngine(bucket_repo=Ghost())
    assert eng._next_depth_backfill_window(["ghost"], now, SRC) is not None
    assert eng._deep_swept_stale == frozenset(), "a sweep is committed when it ENDS, not when it starts"
    while eng._next_depth_backfill_window(["ghost"], now, SRC) is not None:
        pass
    assert eng._deep_swept_stale == {"ghost"}
    assert eng._next_depth_backfill_window(["ghost"], now + 60, SRC) is None, "no retry storm"
    later = now + AVAIL_BACKFILL_RETRY_SECONDS + H
    assert eng._next_depth_backfill_window(["ghost"], later, SRC) is not None, "retried after backoff"


def test_missing_avail_query_never_fabricates_uptime():
    now = _now()
    w = (now - 120 - H, now - 120)
    eng = _agg_engine(Prom(raw={}, avail_ok=False), windows=[w])
    with patch.object(repo_mod, "AVAIL_TARGET_WHITELIST", None):
        eng.aggregate_hourly_buckets(now=now)
        rows = eng.bucket_repo.get_bucket_records("all", *w, instances=["h1"], source=SRC)
    assert rows
    for r in rows:
        assert r["uptime_seconds"] == 0 and r["coverage_seconds"] == 0, r
        assert r["availability_pct"] is None


def test_ongoing_start_uses_lead_in_sample():
    now = _now()
    h0 = math.floor((now - 3 * H) / H) * H
    w = (h0, h0 + H)
    # Up right before the hour, down from the hour's first scrape: a NEW outage.
    raw = {"h1": [(h0 - 15, 1), (h0 + 1, 0), (h0 + 600, 0), (h0 + 900, 1), (h0 + 3599, 1)]}
    eng = _agg_engine(Prom(raw=raw), windows=[w])
    with patch.object(repo_mod, "AVAIL_TARGET_WHITELIST", None):
        eng.aggregate_hourly_buckets(now=now)
        r = eng.bucket_repo.get_bucket_records("all", *w, instances=["h1"], source=SRC)[0]
    assert json.loads(r["outage_json"])["ongoing_start"] is False

    raw["h1"][0] = (h0 - 15, 0)  # already down before the hour: carried in
    eng = _agg_engine(Prom(raw=raw), windows=[w])
    with patch.object(repo_mod, "AVAIL_TARGET_WHITELIST", None):
        eng.aggregate_hourly_buckets(now=now)
        r = eng.bucket_repo.get_bucket_records("all", *w, instances=["h1"], source=SRC)[0]
    assert json.loads(r["outage_json"])["ongoing_start"] is True


def test_backfill_floor_follows_prometheus_retention():
    assert _parse_prom_duration("15d") == 15 * DAY
    assert _parse_prom_duration("1w2d12h") == 9.5 * DAY
    assert _parse_prom_duration("0s") is None and _parse_prom_duration(None) is None

    class Flags(Client):
        @staticmethod
        def fetch_prometheus_json(path, **k):
            return {"status": "success", "data": {"storage.tsdb.retention.time": "15d"}}, SRC

    eng = AvailabilityEngine(prom_client=Flags, bucket_repo=DbRepo())
    assert eng._backfill_depth(SRC) == min(AVAIL_BACKFILL_SECONDS, 15 * DAY)
    assert AVAIL_BACKFILL_CHUNK_SECONDS == H


# ── calendar / trend consistency ──

def _wib_day_start(ts):
    return math.floor((ts + WIB_OFFSET_SEC) / DAY) * DAY - WIB_OFFSET_SEC


def test_calendar_day_excludes_maintenance_like_trend():
    d0 = _wib_day_start(1_790_000_000)
    down_h = d0 + 5 * H
    rows = [_row("h1", d0 + i * H) for i in range(24)]
    rows[5] = _row("h1", down_h, down=H, outage=json.dumps({"i": [[down_h, down_h + H]]}))
    maint = {"h1": [(down_h, down_h + H)]}

    day = _build_daily_downtime(rows, d0, d0 + DAY, maint_by_inst=maint)[0]
    trend, _ = _build_fleet_trend(d0 + DAY, DAY, ["h1"], db_bucket_records=rows, maint_by_inst=maint)
    trend_up = sum(p["availability_pct"] for p in trend if p["availability_pct"] is not None)
    assert day["availability_pct"] == 100.0, day
    assert all(p["availability_pct"] == 100.0 for p in trend), "trend already excluded maintenance"
    assert trend_up / len(trend) == day["availability_pct"]


def test_trend_incidents_skip_rows_without_outage_json():
    t0 = 1_790_000_000 // 3600 * 3600.0
    rows = [_row("h1", t0, down=600.0),  # no intervals: must NOT invent one
            _row("h2", t0, down=60.0, outage=json.dumps({"i": [[t0 + 100, t0 + 160]]}))]
    with _incidents([]):
        out = _build_fleet_incidents(rows, t0, t0 + H, source=SRC)
    assert [e["instance"] for e in out] == ["h2"]
    assert out[0]["intervals"][0]["start_ts"] == int(t0 + 100)


def test_non_down_alerts_not_in_sweep():
    t0 = 1_790_000_000 // 3600 * 3600.0
    incs = [{"instance": "h1", "name": "SlowResponse", "time": t0 + 10, "job": "blackbox"},
            {"instance": "h2", "name": "TargetDown", "time": t0 + 20, "job": "blackbox"}]
    with _incidents(incs):
        out = _build_fleet_incidents([], t0, t0 + H, source=SRC)
    assert [e["instance"] for e in out] == ["h2"]


def test_30d_trend_slots_align_to_wib_midnight():
    for days in (30, 31, 35):
        end = 1_790_000_000
        rows = [_row("h1", float(h)) for h in range(int(end - days * DAY) // 3600 * 3600, end, 3600)]
        series, slot = _build_fleet_trend(end, days * DAY, ["h1"], db_bucket_records=rows)
        assert DAY % slot == 0, f"{days}d: slot {slot}s does not divide a day"
        assert len(series) <= 181
        for p in series[:-1]:  # the last point is clipped to `end`
            assert (p["ts"] + WIB_OFFSET_SEC) % slot == 0, (days, p["ts"])


# ── zoomed trend: finer slots for the zoomed window only ──

def test_zoom_trend_uses_subhour_slots_from_prometheus():
    from alarm.core.availability import helpers as helpers_mod
    end = 1_790_000_000 // 3600 * 3600.0
    calls = []

    def fake_prom(job, instances, start, stop, slot, timeout, source=None):
        calls.append(slot)
        return {int(t): {"h1": (slot * 0.5, float(slot))} for t in range(int(start), int(stop) + 1, slot)}

    rows = [_row("h1", end - DAY + i * H) for i in range(24)]  # hourly, 100% up
    with patch.object(helpers_mod, "_query_prometheus_trend", fake_prom):
        series, slot = _build_fleet_trend(end, DAY, ["h1"], db_bucket_records=rows,
                                          source=SRC, allow_subhour=True)
    assert slot == 600, slot  # 1 day / 180 points -> 10 min slots
    assert calls == [600]
    assert len(series) == 144 and all(p["availability_pct"] == 50.0 for p in series), \
        "sub-hour series comes from Prometheus, never from splitting hourly buckets"
    # Without the zoom flag the same call keeps hourly slots (the report path).
    _, slot = _build_fleet_trend(end, DAY, ["h1"], db_bucket_records=rows)
    assert slot == 3600


def test_get_trend_falls_back_to_hourly_beyond_prometheus():
    from alarm.core.availability import helpers as helpers_mod
    end = 1_790_000_000 // 3600 * 3600.0
    eng = AvailabilityEngine(prom_client=Client, bucket_repo=DbRepo())
    eng._scoped_job_map = lambda job, src: {"h1": "blackbox"}
    eng._resolve_maintenance_windows = lambda *a: None
    with patch.object(repo_mod, "AVAIL_TARGET_WHITELIST", None):
        eng.bucket_repo.save_buckets([_row("h1", end - DAY + i * H) for i in range(24)], SRC)
        with patch.object(helpers_mod, "_query_prometheus_trend", lambda *a, **k: {}), \
                patch.object(engine_mod.time, "time", lambda: end + 60):
            out = eng.get_trend("all", end - DAY, end)
    assert out["trend_bucket_seconds"] == 3600, "no Prometheus data -> hourly stored buckets"
    assert len(out["trend"]) == 24 and all(p["availability_pct"] == 100.0 for p in out["trend"])


def test_open_end_at_hour_edge_closes_when_next_hour_is_up():
    """Live audit: 12:59:33-13:00:00 flagged ongoing_end, 13:00 hour clean.
    The host was back at 13:00 — not "ongoing" with no recovery drawn."""
    t0 = 1_790_000_000 // 3600 * 3600.0
    blip = json.dumps({"i": [[t0 + H - 27, t0 + H]], "ongoing_end": True})
    rows = [_row("h1", t0, down=27.0, outage=blip), _row("h1", t0 + H)]
    with _incidents([]):
        iv = _build_fleet_incidents(rows, t0, t0 + 2 * H, source=SRC)[0]["intervals"][0]
    assert iv["still_down"] is False
    day = _build_daily_downtime(rows, t0, t0 + 2 * H)[0]
    assert day["events"][0]["intervals"][0]["still_down"] is False

    # No row for the next hour (telemetry gap): we don't know, stays open.
    with _incidents([]):
        iv = _build_fleet_incidents(rows[:1], t0, t0 + 2 * H, source=SRC)[0]["intervals"][0]
    assert iv["still_down"] is True

    # Next hour continues the outage: stays one open outage.
    cont = json.dumps({"i": [[t0 + H, t0 + H + 600]], "ongoing_start": True})
    rows2 = [rows[0], _row("h1", t0 + H, down=600.0, outage=cont)]
    with _incidents([]):
        ivs = _build_fleet_incidents(rows2, t0, t0 + 2 * H, source=SRC)[0]["intervals"]
    assert len(ivs) == 1 and ivs[0]["end_ts"] == int(t0 + H + 600)


# ── a failed probe_success fetch must never be filled in from `up` ──

class ProbeDown(Prom):
    """Prometheus flaky: every probe_success query fails, `up` (the blackbox
    exporter's own scrape, 1 while the probe itself fails) answers."""

    def fetch_prom_query_map(self, q, *a, **k):
        return {"h1": "100", "h2": "100"} if "(up[" in q else {}

    def fetch_prom_range_map(self, expr, start, end, *a, **k):
        if expr == "probe_success":
            return None if k.get("strict") else {}
        return {i: [(start - 15, 1)] + [(t, 1) for t in range(int(start), int(end), 60)] for i in ("h1", "h2")}


def test_failed_probe_fetch_never_books_up_as_uptime():
    now = _now()
    h0 = math.floor((now - 3 * H) / H) * H
    down = _row("h1", h0, down=H, outage={"i": [[h0, h0 + H]]})
    eng = _agg_engine(ProbeDown(), windows=[(h0, h0 + H), (h0 + H, h0 + 2 * H)])
    with patch.object(repo_mod, "AVAIL_TARGET_WHITELIST", None):
        eng.bucket_repo.save_buckets([down], SRC)
        eng.aggregate_hourly_buckets(now=now)
        kept = eng.bucket_repo.get_bucket_records("all", h0, h0 + H, instances=["h1"], source=SRC)
        later = eng.bucket_repo.get_bucket_records("all", h0 + H, h0 + 2 * H, source=SRC)
    assert kept and kept[0]["downtime_seconds"] == H and kept[0]["uptime_seconds"] == 0, kept
    assert later == [], "no later window may move the watermark past the failed one"


def test_live_trend_failed_probe_fetch_is_no_data_not_up():
    from alarm.core.availability import helpers as helpers_mod

    def fake(path, *a, **k):
        if "probe_success" in path:
            return None, None
        return {"status": "success", "data": {"result": [
            {"metric": {"instance": "h1", "job": "blackbox"}, "values": [[1000, "1"], [1060, "1"]]}]}}, SRC

    with patch.object(helpers_mod.promclient, "fetch_prometheus_json", side_effect=fake):
        assert helpers_mod._query_prometheus_trend("blackbox", ["h1"], 1000, 1060, 60, 5.0, source=SRC) == {}
