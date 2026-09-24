"""Higher-level Prometheus query adapters.

Thin functions that run one or a few PromQL queries via prometheus_client and
parse the response into `{instance: value}` / `{instance: [(ts, 0|1)]}` maps.
No caching or failover logic of their own — that all lives in
prometheus_client. Nothing imports app.

The single mock seam for these and for prometheus_client is
`prometheus_client.fetch_prometheus_json` (call it as a module attribute).
"""
from urllib.parse import quote

try:
    from . import client as _pc
except (ImportError, ValueError):
    try:
        from core.monitoring import client as _pc
    except ImportError:
        from alarm.core.monitoring import client as _pc

_SHARED_EXECUTOR = _pc._SHARED_EXECUTOR


def fetch_prom_query_map(query_expr, cache_ttl=5.0, timeout=None, source=None):
    raw, base = _pc.fetch_prometheus_json(f"/api/v1/query?query={quote(query_expr)}", use_cache=True, cache_ttl=cache_ttl, timeout=timeout, source=source)
    val_map = {}
    if raw and raw.get('status') == 'success':
        results = raw.get('data', {}).get('result', [])
        for r in results:
            labels = r.get('metric', {})
            inst = labels.get('instance') or labels.get('target') or labels.get('url')
            val = r.get('value', [None, None])[1]
            if inst and val is not None:
                val_map[inst] = val
    return val_map


def fetch_prom_range_map(query_expr, start_ts, end_ts, step_sec, cache_ttl=5.0, timeout=None, source=None):
    """Range query -> {instance: [(ts_float, 0|1), ...]} sorted by ts.

    Used by the availability aggregator to feed raw probe samples straight
    into reconstruct_time_series_intervals() (the exact engine) instead of
    approximating from avg_over_time(). Values are coerced to 0/1 the same
    way reconstruct_time_series_intervals does. Returns {} on any failure so
    callers can fall back to the scalar path per-instance.

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
    series = {}
    if not raw or raw.get('status') != 'success':
        return series
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
            series[inst] = pts
    return series


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


def fetch_up_since_prom_map(cache_ttl=300.0, source=None):
    """Maps instance -> timestamp (epoch seconds) when current continuous UP state started."""
    up_since_map = {}

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

    # 2. Targets with no DOWN sample in the last day: outage ended at the last DOWN sample in 32d
    query_down_wide = 'max_over_time(timestamp(probe_success == 0)[32d:1h])'
    raw_down_wide, _ = _pc.fetch_prometheus_json(f"/api/v1/query?query={quote(query_down_wide)}", use_cache=True, cache_ttl=cache_ttl, source=source)
    if not raw_down_wide or not raw_down_wide.get('data', {}).get('result'):
        query_down_wide = 'max_over_time(timestamp(up == 0)[32d:1h])'
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
                except ValueError:
                    pass

    return up_since_map


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
