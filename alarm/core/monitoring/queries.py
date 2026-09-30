"""Higher-level Prometheus query adapters.

Thin functions that run one or a few PromQL queries via prometheus_client and
parse the response into `{instance: value}` / `{instance: [(ts, 0|1)]}` maps.
No caching or failover logic of their own — that all lives in
prometheus_client. Nothing imports app.

The single mock seam for these and for prometheus_client is
`prometheus_client.fetch_prometheus_json` (call it as a module attribute).
"""
import time
from urllib.parse import quote

try:
    from . import client as _pc
except (ImportError, ValueError):
    try:
        from core.monitoring import client as _pc
    except ImportError:
        from alarm.core.monitoring import client as _pc

_SHARED_EXECUTOR = _pc._SHARED_EXECUTOR


def job_selector(job):
    """PromQL label matcher (no braces) scoping a query to one job view — the
    same job -> rows mapping AvailabilityBucketRepository.get_bucket_records
    applies to stored buckets, so a live query and a stored row for the same
    view always describe the same series. "" for the all-jobs view."""
    if not job or job == "all":
        return ""
    j = job.lower()
    if j == "blackbox":
        return 'job=~"blackbox.*"'
    if j == "node":
        return 'job=~"node.*"'
    return 'job="%s"' % job.replace("\\", "\\\\").replace('"', '\\"')


def with_job(metric, job):
    """`metric{job...}` for a job view, bare `metric` for all jobs."""
    sel = job_selector(job)
    return f"{metric}{{{sel}}}" if sel else metric


def pick_series(store, inst, labels, value, prefer_job=None):
    """One value per instance from a result that may hold several series for
    it (e.g. `up` of four gitlab jobs). The series of the instance's own job
    (`prefer_job[inst]`) wins; without one, the last series wins as before.
    Every availability query goes through this, so the headline, the Trend and
    the Calendar can never price the same host from different series."""
    want = (prefer_job or {}).get(inst)
    job = labels.get("job")
    if want and inst in store and store[inst][0] == want and job != want:
        return
    store[inst] = (job, value)


def fetch_prom_query_map(query_expr, cache_ttl=5.0, timeout=None, source=None, prefer_job=None):
    raw, base = _pc.fetch_prometheus_json(f"/api/v1/query?query={quote(query_expr)}", use_cache=True, cache_ttl=cache_ttl, timeout=timeout, source=source)
    picked = {}
    if raw and raw.get('status') == 'success':
        results = raw.get('data', {}).get('result', [])
        for r in results:
            labels = r.get('metric', {})
            inst = labels.get('instance') or labels.get('target') or labels.get('url')
            val = r.get('value', [None, None])[1]
            if inst and val is not None:
                pick_series(picked, inst, labels, val, prefer_job)
    return {inst: v for inst, (_, v) in picked.items()}


def fetch_prom_range_map(query_expr, start_ts, end_ts, step_sec, cache_ttl=5.0, timeout=None, source=None, prefer_job=None,
                         strict=False):
    """Range query -> {instance: [(ts_float, 0|1), ...]} sorted by ts.

    Used by the availability aggregator to feed raw probe samples straight
    into reconstruct_time_series_intervals() (the exact engine) instead of
    approximating from avg_over_time(). Values are coerced to 0/1 the same
    way reconstruct_time_series_intervals does. Returns {} on any failure so
    callers can fall back to the scalar path per-instance — or None with
    `strict`, for a caller that must tell a failed fetch from "no series".

    Raw TSDB samples via a range-vector instant query (`expr[Ns] @ end`), NOT
    query_range: query_range resamples at `step`, so a failed scrape between
    two steps vanished and outage edges were quantized to the step — the
    stored buckets then disagreed with Prometheus. `step_sec` is only the
    lead-in kept before `start_ts` so the first hour has a preceding sample.
    """
    lead = max(1, int(round(step_sec)))
    dur = max(1, int(end_ts) - int(start_ts) + lead)
    path = (
        f"/api/v1/query?query={quote(f'{query_expr}[{dur}s]')}"
        f"&time={int(end_ts)}"
    )
    raw, _ = _pc.fetch_prometheus_json(path, use_cache=True, cache_ttl=cache_ttl, timeout=timeout, source=source)
    picked = {}
    if not raw or raw.get('status') != 'success':
        return None if strict else {}
    for r in raw.get('data', {}).get('result', []):
        labels = r.get('metric', {})
        inst = labels.get('instance') or labels.get('target') or labels.get('url')
        if not inst:
            continue
        pts = []
        for pair in r.get('values', []):
            try:
                ts = float(pair[0])
                v = 1 if str(pair[1]) in ('1', '1.0', 'up', 'true', 'True') else 0
                pts.append((ts, v))
            except (ValueError, TypeError, IndexError):
                continue
        if pts:
            pts.sort(key=lambda p: p[0])
            pick_series(picked, inst, labels, pts, prefer_job)
    return {inst: v for inst, (_, v) in picked.items()}


def fetch_recent_samples(selector, lookback_sec, source=None, timeout=10.0):
    """Raw samples of `selector` over the last `lookback_sec`, evaluated at
    PROMETHEUS' own "now" (no `time=`): an app host whose clock lags the
    server would otherwise cut off the newest samples — the very edge a
    just-detected transition is about. [(ts, 0|1)] sorted, or None on failure."""
    path = f"/api/v1/query?query={quote(f'{selector}[{int(lookback_sec)}s]')}"
    raw, _ = _pc.fetch_prometheus_json(path, use_cache=False, timeout=timeout, source=source)
    if not raw or raw.get('status') != 'success':
        return None
    pts = []
    for r in raw.get('data', {}).get('result', []):
        for pair in r.get('values', []):
            try:
                pts.append((float(pair[0]), 1 if str(pair[1]) in ('1', '1.0') else 0))
            except (ValueError, TypeError, IndexError):
                continue
    return sorted(pts)


def fetch_prom_matrix_map(query_expr, start_ts, end_ts, step_sec, timeout=None, source=None, prefer_job=None):
    """query_range -> {instance: {eval_ts: float}}, or None when the request
    failed (a caller must not read "failed" as "no series"). Used for small
    per-hour aggregates (changes/min/max/count_over_time), never raw samples."""
    path = (
        f"/api/v1/query_range?query={quote(query_expr)}"
        f"&start={start_ts:.3f}&end={end_ts:.3f}&step={int(step_sec)}"
    )
    raw, _ = _pc.fetch_prometheus_json(path, use_cache=False, timeout=timeout, source=source)
    if not raw or raw.get('status') != 'success':
        return None
    picked = {}
    for r in raw.get('data', {}).get('result', []):
        labels = r.get('metric', {})
        inst = labels.get('instance') or labels.get('target') or labels.get('url')
        if not inst:
            continue
        vals = {}
        for pair in r.get('values', []):
            try:
                vals[round(float(pair[0]), 3)] = float(pair[1])
            except (ValueError, TypeError, IndexError):
                continue
        pick_series(picked, inst, labels, vals, prefer_job)
    return {inst: v for inst, (_, v) in picked.items()}


# Widest lookback of the down-since queries below ([32d:1h]). A target never
# UP inside it gets the window's first DOWN sample, which slides forward as
# time passes: a lower bound, not the outage start.
DOWN_SINCE_LOOKBACK_SEC = 32 * 86400


def down_since_is_window_bound(down_since, now=None):
    """True when `down_since` sits on the lookback edge (±1h subquery step)."""
    if not down_since:
        return False
    edge = (time.time() if now is None else now) - DOWN_SINCE_LOOKBACK_SEC
    return abs(float(down_since) - edge) <= 3600.0


def fetch_down_since_prom_map(cache_ttl=300.0, source=None):
    last_up_map = {}

    # 1. PromQL query for exact last UP timestamp for targets that were previously UP
    query_up = 'max_over_time(timestamp(probe_success == 1)[1d:1m])'
    raw_up, _ = _pc.fetch_prometheus_json(f"/api/v1/query?query={quote(query_up)}", use_cache=True, cache_ttl=cache_ttl, source=source)
    if not raw_up or not raw_up.get('data', {}).get('result'):
        query_up = 'max_over_time(timestamp(up == 1)[1d:1m])'
        raw_up, _ = _pc.fetch_prometheus_json(f"/api/v1/query?query={quote(query_up)}", use_cache=True, cache_ttl=cache_ttl, source=source)

    if raw_up and raw_up.get('status') == 'success':
        for r in raw_up.get('data', {}).get('result', []):
            metric = r.get('metric', {})
            inst = metric.get('instance') or metric.get('target') or metric.get('url')
            val = r.get('value', [None, None])[1]
            if inst and val is not None:
                try:
                    last_up_map[inst] = float(val)
                except ValueError:
                    pass

    # 2. Targets with no UP sample in the last day: the outage began at the last
    #    UP sample within 32d (1h step keeps the subquery affordable and the
    #    estimate accurate to ±1h). Using the FIRST `== 0` sample instead would
    #    date the outage from the earliest failure in the window even when the
    #    target flapped/recovered since, overstating "Down for X" by days.
    query_up_wide = 'max_over_time(timestamp(probe_success == 1)[32d:1h])'
    raw_up_wide, _ = _pc.fetch_prometheus_json(f"/api/v1/query?query={quote(query_up_wide)}", use_cache=True, cache_ttl=cache_ttl, source=source)
    if not raw_up_wide or not raw_up_wide.get('data', {}).get('result'):
        query_up_wide = 'max_over_time(timestamp(up == 1)[32d:1h])'
        raw_up_wide, _ = _pc.fetch_prometheus_json(f"/api/v1/query?query={quote(query_up_wide)}", use_cache=True, cache_ttl=cache_ttl, source=source)
    if raw_up_wide and raw_up_wide.get('status') == 'success':
        for r in raw_up_wide.get('data', {}).get('result', []):
            metric = r.get('metric', {})
            inst = metric.get('instance') or metric.get('target') or metric.get('url')
            val = r.get('value', [None, None])[1]
            if inst and val is not None and inst not in last_up_map:
                try:
                    last_up_map[inst] = float(val)
                except ValueError:
                    pass

    # 3. Initial DOWN timestamp for targets never UP in the 32d window (continuously
    #    DOWN since monitoring began). Falls back to `up == 0` the same way query 1 does.
    query_down = 'min_over_time(timestamp(probe_success == 0)[32d:1h])'
    raw_down, _ = _pc.fetch_prometheus_json(f"/api/v1/query?query={quote(query_down)}", use_cache=True, cache_ttl=cache_ttl, source=source)
    if not raw_down or not raw_down.get('data', {}).get('result'):
        query_down = 'min_over_time(timestamp(up == 0)[32d:1h])'
        raw_down, _ = _pc.fetch_prometheus_json(f"/api/v1/query?query={quote(query_down)}", use_cache=True, cache_ttl=cache_ttl, source=source)
    if raw_down and raw_down.get('status') == 'success':
        for r in raw_down.get('data', {}).get('result', []):
            metric = r.get('metric', {})
            inst = metric.get('instance') or metric.get('target') or metric.get('url')
            val = r.get('value', [None, None])[1]
            if inst and val is not None and inst not in last_up_map:
                try:
                    last_up_map[inst] = float(val)
                except ValueError:
                    pass

    return last_up_map


def fetch_up_since_prom_map(cache_ttl=300.0, source=None, with_basis=False):
    """Maps instance -> timestamp (epoch seconds) when current continuous UP state started.

    Never older than the start of the instance's current unbroken run of
    telemetry: "no DOWN sample seen" across a stretch Prometheus has no data
    for is not "up". with_basis=True also returns {instance: "telemetry"} for
    instances whose value is bounded by that (uptime is at LEAST this long;
    what happened before is unknown) rather than by an observed DOWN.
    """
    up_since_map = {}
    basis = {}

    # 1. PromQL query for exact last DOWN timestamp for targets that were previously DOWN
    query_down = 'max_over_time(timestamp(probe_success == 0)[1d:1m])'
    raw_down, _ = _pc.fetch_prometheus_json(f"/api/v1/query?query={quote(query_down)}", use_cache=True, cache_ttl=cache_ttl, source=source)
    if not raw_down or not raw_down.get('data', {}).get('result'):
        query_down = 'max_over_time(timestamp(up == 0)[1d:1m])'
        raw_down, _ = _pc.fetch_prometheus_json(f"/api/v1/query?query={quote(query_down)}", use_cache=True, cache_ttl=cache_ttl, source=source)

    if raw_down and raw_down.get('status') == 'success':
        for r in raw_down.get('data', {}).get('result', []):
            metric = r.get('metric', {})
            inst = metric.get('instance') or metric.get('target') or metric.get('url')
            val = r.get('value', [None, None])[1]
            if inst and val is not None:
                try:
                    up_since_map[inst] = float(val)
                except ValueError:
                    pass

    # 2. Targets with no DOWN sample in the last day: outage ended at the last DOWN sample in 32d.
    #    1m resolution: at 1h an outage ending at 17:58 was dated 17:00 (and a
    #    short one between two hour marks missed entirely). ~0.6s, cached.
    query_down_wide = 'max_over_time(timestamp(probe_success == 0)[32d:1m])'
    raw_down_wide, _ = _pc.fetch_prometheus_json(f"/api/v1/query?query={quote(query_down_wide)}", use_cache=True, cache_ttl=cache_ttl, source=source)
    if not raw_down_wide or not raw_down_wide.get('data', {}).get('result'):
        query_down_wide = 'max_over_time(timestamp(up == 0)[32d:1m])'
        raw_down_wide, _ = _pc.fetch_prometheus_json(f"/api/v1/query?query={quote(query_down_wide)}", use_cache=True, cache_ttl=cache_ttl, source=source)
    if raw_down_wide and raw_down_wide.get('status') == 'success':
        for r in raw_down_wide.get('data', {}).get('result', []):
            metric = r.get('metric', {})
            inst = metric.get('instance') or metric.get('target') or metric.get('url')
            val = r.get('value', [None, None])[1]
            if inst and val is not None and inst not in up_since_map:
                try:
                    up_since_map[inst] = float(val)
                except ValueError:
                    pass

    # 3. Initial UP timestamp for targets continuously UP throughout the 32d window
    query_up_earliest = 'min_over_time(timestamp(probe_success == 1)[32d:1h])'
    raw_up, _ = _pc.fetch_prometheus_json(f"/api/v1/query?query={quote(query_up_earliest)}", use_cache=True, cache_ttl=cache_ttl, source=source)
    if not raw_up or not raw_up.get('data', {}).get('result'):
        query_up_earliest = 'min_over_time(timestamp(up == 1)[32d:1h])'
        raw_up, _ = _pc.fetch_prometheus_json(f"/api/v1/query?query={quote(query_up_earliest)}", use_cache=True, cache_ttl=cache_ttl, source=source)
    if raw_up and raw_up.get('status') == 'success':
        for r in raw_up.get('data', {}).get('result', []):
            metric = r.get('metric', {})
            inst = metric.get('instance') or metric.get('target') or metric.get('url')
            val = r.get('value', [None, None])[1]
            if inst and val is not None and inst not in up_since_map:
                try:
                    up_since_map[inst] = float(val)
                    basis[inst] = "telemetry"  # up since monitoring began: at least
                except ValueError:
                    pass

    # 4. Start of the current unbroken telemetry run (series present, but not
    #    15m earlier). Uptime can't be claimed across that gap.
    query_run = 'max_over_time(timestamp(probe_success unless probe_success offset 15m)[32d:5m])'
    raw_run, _ = _pc.fetch_prometheus_json(f"/api/v1/query?query={quote(query_run)}", use_cache=True, cache_ttl=cache_ttl, source=source)
    if not raw_run or not raw_run.get('data', {}).get('result'):
        query_run = 'max_over_time(timestamp(up unless up offset 15m)[32d:5m])'
        raw_run, _ = _pc.fetch_prometheus_json(f"/api/v1/query?query={quote(query_run)}", use_cache=True, cache_ttl=cache_ttl, source=source)
    if raw_run and raw_run.get('status') == 'success':
        for r in raw_run.get('data', {}).get('result', []):
            metric = r.get('metric', {})
            inst = metric.get('instance') or metric.get('target') or metric.get('url')
            try:
                run_start = float(r.get('value', [None, None])[1])
            except (TypeError, ValueError):
                continue
            if inst in up_since_map and run_start > up_since_map[inst]:
                up_since_map[inst] = run_start
                basis[inst] = "telemetry"

    return (up_since_map, basis) if with_basis else up_since_map


def fetch_all_probe_metrics(cache_ttl=3.0, timeout=None):
    f_succ = _SHARED_EXECUTOR.submit(fetch_prom_query_map, "probe_success", cache_ttl, timeout)
    f_dur = _SHARED_EXECUTOR.submit(fetch_prom_query_map, "probe_duration_seconds", cache_ttl, timeout)
    f_code = _SHARED_EXECUTOR.submit(fetch_prom_query_map, "probe_http_status_code", cache_ttl, timeout)

    success_map = f_succ.result()
    duration_map = f_dur.result()
    status_code_map = f_code.result()

    if not success_map:
        success_map = fetch_prom_query_map("up", cache_ttl=cache_ttl, timeout=timeout)

    return success_map, duration_map, status_code_map
