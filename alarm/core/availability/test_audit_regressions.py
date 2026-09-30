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
    """h1 is 90% up over the window; the raw-sample fetch can be made to fail.

    The depth path's per-hour aggregates (changes/min/max/count_over_time and
    the lead sample) are computed from `raw` like Prometheus would, so what the
    classifier sees always agrees with the samples. `raw_fail`: instances whose
    raw fetch fails. `force_raw`: report every hour as changed (the pure raw
    path, for comparing against). `raw_calls`: raw fetches made."""

    def __init__(self, raw=None, avail_ok=True, raw_fail=(), force_raw=False):
        self.raw = raw or {}
        self.avail_ok = avail_ok
        self.raw_fail = set(raw_fail)
        self.force_raw = force_raw
        self.raw_calls = []
        self.raw_requests = 0

    def fetch_prom_matrix_map(self, expr, start_ts, end_ts, step_sec, **k):
        import re
        m = re.match(r"(\w+)\((\w+)\[(\d+)s\]\)$", expr)
        fn, metric, rng = (m.group(1), m.group(2), int(m.group(3))) if m else ("last", expr, 300)
        if metric != "probe_success":
            return {}
        stamps, t = [], start_ts
        while t <= end_ts + 1e-6:
            stamps.append(round(t, 3))
            t += step_sec
        import bisect
        out = {}
        for inst, samples in self.raw.items():
            ts_list = [ts for ts, _ in samples]
            vals = {}
            for t in stamps:
                pts = [v for _, v in samples[bisect.bisect_right(ts_list, t - rng):bisect.bisect_right(ts_list, t)]]
                if not pts:
                    continue
                if fn == "last":
                    vals[t] = float(pts[-1])
                elif fn == "changes":
                    vals[t] = 1.0 if self.force_raw else float(sum(a != b for a, b in zip(pts, pts[1:])))
                else:
                    vals[t] = float({"min_over_time": min, "max_over_time": max, "count_over_time": len}[fn](pts))
            if vals:
                out[inst] = vals
        return out

    def fetch_prom_query_map(self, q, *a, **k):
        if "avg_over_time(probe_success" in q:
            return {"h1": "90", "h2": "100"} if self.avail_ok else {}
        if "count_over_time(probe_success" in q:
            return {"h1": "1800", "h2": "1800"}
        if "changes(probe_success" in q:
            return {"h1": "2", "h2": "0"}
        return {}

    def fetch_prom_range_map(self, expr, start_ts=None, end_ts=None, lead=0.0, **k):
        if expr.startswith('probe_success{instance'):
            import re
            self.raw_requests += 1
            pat = expr.split('"')[1]
            insts = [pat] if '{instance="' in expr else [i for i in self.raw if re.fullmatch(pat, i)]
            for inst in insts:
                self.raw_calls.append((inst, start_ts, end_ts))
            if set(insts) & self.raw_fail:
                return None
            return {inst: [(ts, v) for ts, v in self.raw.get(inst, []) if start_ts - lead <= ts <= end_ts]
                    for inst in insts}
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

def _series(start, end, step=15.0, down=()):
    """0/1 samples every `step` s over [start, end); `down`: [(lo, hi)) spans of 0."""
    out, t = [], start
    while t < end:
        out.append((t, 0 if any(lo <= t < hi for lo, hi in down) else 1))
        t += step
    return out


def test_failed_raw_fetch_is_not_marked_materialized():
    now = _now()
    w = (now - 120 - H, now - 120)
    raw = {"h1": _series(w[0] - 300, w[1], down=[(w[0] + 600, w[0] + 900)]),  # flaps: needs raw
           "h2": _series(w[0] - 300, w[1])}                                     # stable: doesn't
    eng = _agg_engine(Prom(raw=raw, raw_fail={"h1"}), depth=w)
    eng._deep_cursor = w[0]
    with patch.object(repo_mod, "AVAIL_TARGET_WHITELIST", None):
        for attempt in range(1, AVAIL_BACKFILL_MAX_CHUNK_FAILURES):
            eng.aggregate_hourly_buckets(now=now)
            assert eng.bucket_repo.get_bucket_records("all", *w, source=SRC) == [], "nothing persisted on failure"
            assert eng._deep_cursor == w[1], "cursor rewound so the same chunk is retried"
        # Give up after N failures: what could be built is stored, the host
        # whose raw fetch failed stays a hole — never a scalar guess.
        eng.aggregate_hourly_buckets(now=now)
        rows = eng.bucket_repo.get_bucket_records("all", *w, source=SRC)
        assert [r["instance"] for r in rows] == ["h2"], rows
        assert not eng._chunk_materialized(["h1", "h2"], w[0], w[1], SRC)
        assert "h1" not in eng.bucket_repo.get_instance_bucket_coverage(["h1"], source=SRC)


def _depth_rows(prom, w, now):
    eng = _agg_engine(prom)
    todo = [w]
    eng._next_depth_backfill_window = lambda *a: todo.pop() if todo else None
    with patch.object(repo_mod, "AVAIL_TARGET_WHITELIST", None):
        eng.aggregate_hourly_buckets(now=now)
        rows = eng.bucket_repo.get_bucket_records("all", *w, source=SRC)
    return {(r["instance"], r["bucket_start"]): {k: r[k] for k in (
        "uptime_seconds", "downtime_seconds", "unknown_seconds", "coverage_seconds", "sample_count",
        "availability_pct", "incident_count", "outage_json")} for r in rows}


def test_stable_hours_skip_raw_and_match_the_raw_path():
    """Full-UP and full-DOWN hours are written from aggregates alone, and the
    rows are exactly what reconstructing the raw samples gives."""
    now = _now()
    top = math.floor(now / H) * H
    w = (top - 3 * H, top)
    raw = {"h1": _series(w[0] - 300, w[1]),                                    # UP throughout
           "h2": _series(w[0] - 300, w[1], down=[(w[0] - 300, w[1])])}         # DOWN throughout
    prom = Prom(raw=raw)
    fast = _depth_rows(prom, w, now)
    assert prom.raw_calls == [], "stable hosts must not fetch raw samples"
    exact = _depth_rows(Prom(raw=raw, force_raw=True), w, now)
    assert fast == exact
    assert len(fast) == 6
    down = json.loads(fast[("h2", w[0] + H)]["outage_json"])
    assert down == {"d": [3600.0], "i": [[w[0] + H, w[0] + 2 * H]], "ongoing_start": True, "ongoing_end": True}
    up = json.loads(fast[("h1", w[0])]["outage_json"])
    assert up == {"d": [], "i": [], "ongoing_start": False, "ongoing_end": False}


def test_flapping_host_fetches_raw_only_for_its_hours_and_keeps_short_outage():
    """A 4s outage at a 2s scrape survives: that hour is rebuilt from raw
    samples (no 15s resampling), the other hours and hosts are not fetched."""
    now = _now()
    top = math.floor(now / H) * H
    w = (top - 3 * H, top)
    blip = (w[0] + H + 1000.0, w[0] + H + 1004.0)
    raw = {"h1": _series(w[0] - 300, w[1], step=2.0, down=[blip]),
           "h2": _series(w[0] - 300, w[1], step=2.0)}
    prom = Prom(raw=raw)
    rows = _depth_rows(prom, w, now)
    assert [c[0] for c in prom.raw_calls] == ["h1"] and prom.raw_calls[0][1:] == (w[0] + H, w[0] + 2 * H)
    oj = json.loads(rows[("h1", w[0] + H)]["outage_json"])
    assert oj["i"] == [[blip[0], blip[1]]] and oj["d"] == [4.0], oj
    assert rows[("h1", w[0] + H)]["downtime_seconds"] == 4.0
    assert rows == _depth_rows(Prom(raw=raw, force_raw=True), w, now)


def test_gappy_hour_is_not_classified_stable():
    """Two missed scrapes in a row is a gap over the reconstruction tolerance:
    the hour must go raw so the gap is booked unknown, not up."""
    now = _now()
    top = math.floor(now / H) * H
    w = (top - 2 * H, top)
    series = [p for p in _series(w[0] - 300, w[1]) if not (w[0] + 1200 < p[0] < w[0] + 1260)]
    prom = Prom(raw={"h1": series, "h2": _series(w[0] - 300, w[1])})
    rows = _depth_rows(prom, w, now)
    assert [c[0] for c in prom.raw_calls] == ["h1"]
    assert rows[("h1", w[0])]["unknown_seconds"] > 0
    assert rows == _depth_rows(Prom(raw=prom.raw, force_raw=True), w, now)


def test_fresh_db_backfills_newest_first_and_restart_resumes():
    """Fresh DB: the walk starts at the newest hour. A restart (new engine,
    same DB) resumes below what is stored instead of rebuilding it, and the
    walk ends exactly at the detected retention floor."""
    now = _now()
    top = math.floor(now / H) * H
    depth = 2 * DAY
    raw = {i: _series(top - depth - 600, top) for i in ("h1", "h2")}
    repo = DbRepo()

    def engine():
        eng = AvailabilityEngine(prom_client=Client, prom_queries=Prom(raw=raw), bucket_repo=repo)
        eng._scoped_job_map = lambda job, src: {"h1": "blackbox", "h2": "blackbox"}
        eng._validate_whitelist = lambda src: None
        eng._availability_aggregation_windows = lambda *a, **k: []
        eng._backfill_depth = lambda src: depth
        return eng

    with patch.object(repo_mod, "AVAIL_TARGET_WHITELIST", None), \
            patch.object(engine_mod, "AVAIL_BACKFILL_CHUNK_SECONDS", 12 * H), \
            patch.object(engine_mod, "AVAIL_BACKFILL_CYCLE_BUDGET_SECONDS", 0.0):
        eng = engine()
        eng._backfill_depth_sec = depth
        assert eng._next_depth_backfill_window(["h1", "h2"], now, SRC) == (top - 12 * H, top), "newest first"
        eng = engine()
        eng.aggregate_hourly_buckets(now=now)           # one chunk: the newest 12h
        stored = {r["bucket_start"] for r in repo.get_bucket_records("all", top - depth, top, source=SRC)}
        assert stored == {top - k * H for k in range(1, 13)}, sorted(stored)
        eng = engine()                                  # restart
        eng._backfill_depth_sec = depth
        assert eng._next_depth_backfill_window(["h1", "h2"], now, SRC) == (top - 24 * H, top - 12 * H)
        eng = engine()                                  # (that call moved the cursor; start clean)
        for _ in range(10):
            eng.aggregate_hourly_buckets(now=now)
        stored = {r["bucket_start"] for r in repo.get_bucket_records("all", top - 3 * DAY, top, source=SRC)}
        assert stored == {top - k * H for k in range(1, 49)}, "walks exactly to the floor, no further"
        assert not eng.backfill_in_progress


def test_invalidate_range_evicts_only_overlapping_reports():
    from alarm.core.availability._cache import AvailabilityCache
    now = 1_790_000_000.0
    cache = AvailabilityCache()
    keys = {}
    for name, minutes, end in (("24h", 1440, None), ("7d", 10080, None), ("30d", 43200, None),
                               ("old", 1440, now - 20 * DAY)):
        k, _ = AvailabilityCache.derive_cache_key(SRC, "all", minutes, end, 99.9, 30, 0, now)
        cache.set(k, name, now=now)
        keys[name] = k
    # History materialized 10-9 days ago: the 30d report shows it, 24h/7d don't.
    assert cache.invalidate_range(now - 10 * DAY, now - 9 * DAY) == 1
    assert cache.get(keys["30d"], 900, now=now) is None
    assert cache.get(keys["7d"], 900, now=now) == "7d" and cache.get(keys["24h"], 900, now=now) == "24h"
    assert cache.get(keys["old"], 900, now=now) == "old"

    eng = AvailabilityEngine(prom_client=Client, bucket_repo=DbRepo())
    eng._last_live = {"a": (now, 43200, {}), "b": (now, 1440, {})}
    eng.invalidate_range(now - 10 * DAY, now - 9 * DAY)
    assert set(eng._last_live) == {"b"}, "stale-serve copy of an affected report is dropped too"


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

        def get_materialized_hour_counts(self, instances, start, end, source=None):
            return {float(h): len(instances) - (h in hole)
                    for h in range(int(math.ceil(start / H) * H), int(end), int(H))}

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
    assert eng._backfill_depth(SRC) == 15 * DAY
    assert AVAIL_BACKFILL_CHUNK_SECONDS == 12 * H

    # Longer than the 35d fallback: follow Prometheus, not the fallback.
    class Flags60(Client):
        @staticmethod
        def fetch_prometheus_json(path, **k):
            return {"status": "success", "data": {"storage.tsdb.retention.time": "60d"}}, SRC

    assert AvailabilityEngine(prom_client=Flags60, bucket_repo=DbRepo())._backfill_depth(SRC) == 60 * DAY

    # Unknown retention (unreachable / size-based): the configured fallback.
    class NoFlags(Client):
        @staticmethod
        def fetch_prometheus_json(path, **k):
            return None, None

    assert AvailabilityEngine(prom_client=NoFlags, bucket_repo=DbRepo())._backfill_depth(SRC) == AVAIL_BACKFILL_SECONDS

    # Default retention: /flags says 0s, runtimeinfo has the effective value.
    class DefaultRetention(Client):
        @staticmethod
        def fetch_prometheus_json(path, **k):
            if path.endswith("runtimeinfo"):
                return {"status": "success", "data": {"storageRetention": "15d or 10GiB"}}, SRC
            return {"status": "success", "data": {"storage.tsdb.retention.time": "0s"}}, SRC

    assert AvailabilityEngine(prom_client=DefaultRetention, bucket_repo=DbRepo())._backfill_depth(SRC) == 15 * DAY

    # Server goes unreachable after a good read: keep the last known depth
    # (the prune follows it), don't fall back to 35d on a network blip.
    eng = AvailabilityEngine(prom_client=Flags60, bucket_repo=DbRepo())
    assert eng._backfill_depth(SRC) == 60 * DAY
    eng.prom_client = NoFlags
    eng._retention_cache[SRC] = (0.0, eng._retention_cache[SRC][1])  # expire the cache
    assert eng._backfill_depth(SRC) == 60 * DAY


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


def test_several_depth_chunks_per_cycle():
    now = _now()
    top = math.floor(now / H) * H
    chunks = [(top - (k + 1) * H, top - k * H) for k in range(1, 4)]
    raw = {i: _series(chunks[-1][0] - 300, top) for i in ("h1", "h2")}
    eng = _agg_engine(Prom(raw=raw))
    todo = iter(chunks)
    eng._next_depth_backfill_window = lambda *a: next(todo, None)
    evicted = []
    eng.invalidate_range = lambda lo, hi: evicted.append((lo, hi))
    with patch.object(repo_mod, "AVAIL_TARGET_WHITELIST", None):
        eng.aggregate_hourly_buckets(now=now)
        for w in chunks:
            assert eng.bucket_repo.get_bucket_records("all", *w, source=SRC), w
        assert evicted == [(chunks[-1][0], chunks[0][1])], "evicts exactly the span it materialized"
        # Zero budget: only the first chunk runs (the old one-per-cycle pace).
        todo = iter(chunks)
        eng.bucket_repo = DbRepo()
        with patch.object(engine_mod, "AVAIL_BACKFILL_CYCLE_BUDGET_SECONDS", 0.0):
            eng.aggregate_hourly_buckets(now=now)
        assert eng.bucket_repo.get_bucket_records("all", *chunks[0], source=SRC)
        assert not eng.bucket_repo.get_bucket_records("all", *chunks[1], source=SRC)


def test_flapping_hosts_with_the_same_hours_share_one_raw_request():
    now = _now()
    top = math.floor(now / H) * H
    w = (top - 2 * H, top)
    flap = [(w[0] + 600, w[0] + 630)]
    raw = {"h1": _series(w[0] - 300, w[1], down=flap), "h2": _series(w[0] - 300, w[1], down=flap)}
    prom = Prom(raw=raw)
    rows = _depth_rows(prom, w, now)
    assert sorted(c[0] for c in prom.raw_calls) == ["h1", "h2"]
    assert prom.raw_requests == 1, "one request for both hosts"
    assert rows == _depth_rows(Prom(raw=raw, force_raw=True), w, now)


def test_backfill_status_reports_filling_then_complete():
    now = _now()
    top = math.floor(now / H) * H
    eng = AvailabilityEngine(prom_client=Client, bucket_repo=DbRepo())
    eng._backfill_depth = lambda src: 10 * H
    with patch.object(repo_mod, "AVAIL_TARGET_WHITELIST", None):
        # Newest 4 hours stored for both hosts, the rest not yet.
        eng.bucket_repo.save_buckets([_row(i, top - k * H) for i in ("h1", "h2") for k in range(1, 5)], SRC)
        st = eng.backfill_status(SRC, ["h1", "h2"], now=now)
        assert st["state"] == "filling" and st["materialized_from_ts"] == top - 4 * H
        assert st["complete_hours"] == 4 and st["total_hours"] == 10 and st["progress_pct"] == 40.0
        eng.bucket_repo.save_buckets([_row(i, top - k * H) for i in ("h1", "h2") for k in range(5, 11)], SRC)
        assert eng.backfill_status(SRC, ["h1", "h2"], now=now)["state"] == "filling", "cached 30s"
        eng.invalidate_range(top - 10 * H, top)
        st = eng.backfill_status(SRC, ["h1", "h2"], now=now)
        assert st["state"] == "complete" and st["materialized_from_ts"] == top - 10 * H == st["floor_ts"]


def test_host_without_telemetry_for_part_of_window_keeps_the_fast_path():
    """A host added mid-window has zero-coverage "no data" rows before it
    existed. They are materialized history (Prometheus has nothing there
    either), so the report must stay on SQLite instead of re-querying the
    whole window from Prometheus."""
    now = _now()
    top = math.floor(now / H) * H
    hours = [top - k * H for k in range(1, 25)]
    rows = [dict(_row("h1", h), updated_at=now) for h in hours]
    rows += [dict(_row("h2", h), updated_at=now) if h >= top - 6 * H else
             dict(_row("h2", h), uptime_seconds=0.0, coverage_seconds=0.0, unknown_seconds=H,
                  availability_pct=None, updated_at=now)
             for h in hours]
    eng = AvailabilityEngine(prom_client=Client, bucket_repo=DbRepo())
    assert eng._check_sqlite_coverage(rows, ["h1", "h2"], top - 24 * H, top, None, now)
    assert not eng._check_sqlite_coverage(rows[:-3], ["h1", "h2"], top - 24 * H, top, None, now), \
        "a host missing rows is still a hole"


def test_whole_hour_slice_is_memoized_but_partial_clips_are_not():
    from alarm.core.availability.fleet import slice_bucket
    h0 = 1_790_000_000.0 // H * H
    row = _row("h1", h0, down=600.0, outage=json.dumps({"d": [600.0], "i": [[h0 + 60, h0 + 660]],
                                                        "ongoing_start": False, "ongoing_end": False}))
    whole = slice_bucket(row, h0, h0 + H, None, now=h0 + 2 * H)
    assert slice_bucket(row, h0 - H, h0 + 2 * H, None, now=h0 + 2 * H) is whole
    half = slice_bucket(row, h0 + 1800, h0 + H, None, now=h0 + 2 * H)
    assert half is not whole and half["coverage_seconds"] == 1800.0 and half["downtime_seconds"] == 0.0
    maint = slice_bucket(row, h0, h0 + H, [(h0, h0 + 300)], now=h0 + 2 * H)
    assert maint is not whole and maint["maint_down"] == 240.0
    live = slice_bucket(row, h0, h0 + H, None, now=h0 + 1800)
    assert live is not whole, "an hour still in progress is not the cached whole hour"
