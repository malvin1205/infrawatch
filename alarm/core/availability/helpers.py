"""Availability response helpers — SLA error-budget attachment, the
online/warning/offline status split, and the Prometheus-TSDB fleet trend
series with its 60s cache.

Extracted verbatim from app.py (Phase 2 step 8) — behaviour is unchanged.
app.py re-imports every name, so `import app as alarm_app;
alarm_app._build_fleet_trend` and `alarm_app._FLEET_TREND_CACHE` keep working
and stay monkeypatchable from the tests. The /api/availability route itself
(cache/single-flight/hybrid orchestration, welded to Flask `request` and the
rate-limit decorator) stays in app.py and calls these as module globals.
"""
from __future__ import annotations
import json
import math
import re
import time
import logging
from datetime import datetime, timezone, timedelta
from typing import Optional, List, Dict, Any, Tuple, Set
from urllib.parse import quote

try:
    from .fleet import (
        sla_budget,
        derive_bucket_inputs,
        merge_hybrid_target_availability,
        summarize_entries,
        maintenance_overlap_seconds,
        _bucket_outage_downtime_in_maintenance,
        DEFAULT_SCRAPE_INTERVAL_SEC,
        get_min_sla_coverage_percent,
        sla_carve_seconds,
        slice_bucket,
        subtract_windows,
    )
    from core.monitoring.queries import job_selector, pick_series
    from config import AVAIL_TREND_MIN_REPORTING_RATIO, ALERTNAME_TARGET_DOWN
    from core.monitoring import client as promclient
except (ImportError, ValueError):
    from alarm.core.availability.fleet import (
        sla_budget,
        derive_bucket_inputs,
        merge_hybrid_target_availability,
        summarize_entries,
        maintenance_overlap_seconds,
        _bucket_outage_downtime_in_maintenance,
        DEFAULT_SCRAPE_INTERVAL_SEC,
        get_min_sla_coverage_percent,
        sla_carve_seconds,
        slice_bucket,
        subtract_windows,
    )
    from alarm.core.monitoring.queries import job_selector, pick_series
    from alarm.config import AVAIL_TREND_MIN_REPORTING_RATIO, ALERTNAME_TARGET_DOWN
    from alarm.core.monitoring import client as promclient

logger = logging.getLogger("infrawatch")

# Fixed UTC+7 offset for Asia/Jakarta (WIB) — no DST, so plain arithmetic is
# exact and doesn't need a timezone database. This deployment's operators are
# all in Indonesia; every calendar-day grouping and hour label in the
# Availability Breakdown modal (backend and frontend alike) uses this same
# offset so the two sides can never disagree about which day/hour an event
# falls in.
WIB_OFFSET_SEC = 7 * 3600

# Firing alerts that mean "host unreachable" (the poller's own TargetDown plus
# the usual Prometheus rule names). Anything else — SlowResponse, resource
# alerts — is not an outage and must not become a Trend down-interval.
DOWN_ALERTNAMES = frozenset({
    ALERTNAME_TARGET_DOWN, "InstanceDown", "HostDown", "EndpointDown",
    "ProbeFailed", "BlackboxProbeFailed",
})


def _attach_sla_budgets(summary_dict, window_sec, default_target_pct, project_days, target_map=None):
    """Compute the SLA error budget per target (mutating the per_server
    values) and for the fleet, from the maintenance-excluded downtime/observed
    figures. `target_map` gives per-instance SLA target overrides; the fleet
    budget uses the deployment default. Returns the fleet-level budget dict."""
    target_map = target_map or {}
    for e in summary_dict.get("per_server", {}).get("values", []):
        dt = e.get("sla_downtime_seconds", e.get("downtime_seconds", 0.0)) or 0.0
        obs = e.get("sla_observed_seconds", e.get("observed_seconds", 0.0)) or 0.0
        tp = target_map.get(e.get("id"), e.get("sla_target_pct") or default_target_pct)
        e["sla_budget"] = sla_budget(dt, obs, tp, window_sec, project_days)
    fa = summary_dict.get("fleet_aggregate", {}) or {}
    f_dt = float(fa.get("total_downtime_minutes") or 0.0) * 60.0
    f_obs = float(fa.get("total_observed_minutes") or 0.0) * 60.0
    # f_dt/f_obs are fleet TOTALS (summed over every scored host), so the
    # window they're measured against must be the fleet total too — one
    # host's window * scored host count. Passing the single-host window here
    # made the fleet error budget report ~Nx the real usage (N hosts ->
    # "BREACHED" on a healthy fleet).
    n_scored = int(summary_dict.get("scored_count") or 0) or 1
    return sla_budget(f_dt, f_obs, default_target_pct, window_sec * n_scored, project_days)


def _availability_status_counts(entries, live_map=None):
    """online / warning / offline split by historical availability_pct, with the
    live probe_success snapshot breaking the tie for entries that have no
    historical coverage yet (availability_pct is None). Shared verbatim by
    api_availability's SQLite fast path and its Prometheus hybrid path so the
    same target is never bucketed differently depending on which path served the
    request (audit m4)."""
    live_map = live_map or {}
    counts = {"online": 0, "warning": 0, "offline": 0}
    for e in entries:
        avail_pct = e.get("availability_pct")
        if avail_pct is not None:
            if avail_pct >= 99.9:
                st_val = 'online'
            elif avail_pct >= 95.0:
                st_val = 'warning'
            else:
                st_val = 'offline'
        else:
            live_val = live_map.get(e.get("id"))
            if live_val is not None:
                st_val = 'online' if str(live_val) in ('1', '1.0') else 'offline'
            else:
                st_val = 'warning'
        counts[st_val] += 1
    return counts


_FLEET_TREND_CACHE = {}          # key -> (wall_ts, (series, slot))
_FLEET_TREND_CACHE_TTL = 60.0    # hourly slots — a minute stale is nothing


def _slot_host_seconds(uptime, downtime, coverage, excused_down, maint_cov):
    """SLA (maintenance-excluded) (uptime, coverage) for one host's slice —
    fleet.sla_carve_seconds, the carve merge_hybrid_target_availability applies
    before fleet_aggregate pools hosts, so the Trend and the headline agree."""
    up, _, cov = sla_carve_seconds(uptime, downtime, coverage, excused_down, maint_cov)
    return up, cov


def _bucket_sla_seconds(row, maint_windows, lo=None, hi=None):
    """(uptime, coverage) of one stored hourly bucket, restricted to [lo, hi]
    (default: the whole bucket), with maintenance carved out. fleet.slice_bucket
    — the ONE implementation behind the headline, the Availability Trend and
    the Downtime Calendar, so the three always agree."""
    sl = _slice_row(row, lo, hi, maint_windows)
    return (sl["sla_uptime"], sl["sla_coverage"]) if sl else (0.0, 0.0)


def _slice_row(row, lo, hi, maint_windows, now=None):
    b_start = float(row.get("bucket_start", 0) or 0)
    b_end = float(row.get("bucket_end") or (b_start + 3600.0))
    if row.get("bucket_end") is None:
        row = dict(row, bucket_end=b_end)
    lo = b_start if lo is None else max(b_start, float(lo))
    hi = b_end if hi is None else min(b_end, float(hi))
    if hi <= lo:
        return None
    return slice_bucket(row, lo, hi, maint_windows, now=now)


# Trend slot widths that tile a WIB day exactly (divisors of 24h), so no trend
# point ever straddles a calendar-day boundary.
_TREND_SLOT_HOURS = (1, 2, 3, 4, 6, 8, 12, 24)
# Sub-hour slot widths (seconds) for zoomed trends; all divide an hour.
_TREND_SUBHOUR_SLOTS = (300, 600, 900, 1200, 1800, 3600)


def _build_fleet_trend(trend_end_ts, window_seconds, instances, max_points=180, db_bucket_records=None, job=None,
                       maint_by_inst=None, min_reporting_ratio=None, source=None, allow_subhour=False,
                       prefer_job=None, host_spans=None):
    """Fleet availability time series for the modal's Availability Trend chart.

    Each point pools every reporting host's maintenance-excluded seconds —
    Σ uptime / Σ coverage, the fleet_aggregate formula — and carries
    hosts_reporting / hosts_expected. A slot where fewer than
    `min_reporting_ratio` of the expected hosts have data returns
    availability_pct=None ("partial data"): pooling whichever handful of
    hosts happened to report would present that subset as the whole fleet.
    A slot with no host at all is omitted (no telemetry).

    Host-slots come from materialized hourly buckets first — clipped to the
    window with their exact outage intervals (fleet.slice_bucket, same as the
    headline) — and hosts a slot is missing (or a slot missing entirely,
    including the in-progress one at `trend_end_ts`) are filled per host from
    Prometheus server `source` only (no failover), scoped to `job`, with the
    same pooling and maintenance carve. No `source` => no Prometheus fill.

    host_spans: {instance: (first_ts, last_ts)} for hosts that are only
    expected part of the window (no longer monitored); outside its span a
    host doesn't count toward hosts_expected.
    """
    if min_reporting_ratio is None:
        min_reporting_ratio = AVAIL_TREND_MIN_REPORTING_RATIO
    maint_by_inst = maint_by_inst or {}
    host_spans = host_spans or {}
    end = int(trend_end_ts)
    win = max(3600.0, float(window_seconds or 0.0))
    # Smallest day-divisor slot that keeps the series within max_points. The
    # old ceil(win/max_points) gave 5h slots for a 31d MTD — UTC-epoch aligned,
    # so points straddled WIB midnight and could never match the Calendar.
    #
    # allow_subhour (zoomed views): slots down to 5 min. Stored buckets are
    # hourly and can't be split, so a sub-hour series comes from Prometheus
    # alone (the caller compares it with the hourly one).
    need_s = win / max_points
    if allow_subhour and need_s < 3600:
        slot = next(m for m in _TREND_SUBHOUR_SLOTS if m >= need_s)
        db_bucket_records = None
    else:
        need_h = need_s / 3600.0
        slot = next((h for h in _TREND_SLOT_HOURS if h >= need_h), int(math.ceil(need_h / 24.0)) * 24) * 3600
    # Every point summarizes a slot that sits inside [end - win, end].
    start = end - int(win)

    if not instances:
        return [], slot
    inst_set = set(instances)

    # Points land on WIB-midnight-aligned slot boundaries (slot_key + slot),
    # clipped to `end` for the in-progress slot so no point carries a future ts.
    # For 1h slots this is identical to epoch alignment (WIB is a whole hour).
    key_of = lambda ts: int(math.floor((ts + WIB_OFFSET_SEC) / slot) * slot) - WIB_OFFSET_SEC
    first_slot_key = key_of(start)
    last_slot_key = key_of(end - 1)
    point_ts = lambda k: min(k + slot, end)
    slot_start = lambda ts: max(key_of(ts - 1), start)

    # {point_ts: {instance: [uptime_s, coverage_s]}}
    host_slots = {}
    for r in db_bucket_records or []:
        inst = r.get("instance")
        if inst not in inst_set:
            continue
        if float(r.get("coverage_seconds", 0) or 0) <= 0:
            continue
        sl = _slice_row(r, start, end, maint_by_inst.get(inst), now=end)
        if not sl or sl["sla_coverage"] <= 0:
            continue
        acc = host_slots.setdefault(point_ts(key_of(sl["bucket_start"])), {}).setdefault(inst, [0.0, 0.0])
        acc[0] += sl["sla_uptime"]
        acc[1] += sl["sla_coverage"]

    def expected_hosts(ts):
        # A host fully inside maintenance for the slot, or outside its
        # monitored span, isn't expected to report.
        s = slot_start(ts)
        n = 0
        for i in instances:
            sp = host_spans.get(i)
            if sp and (sp[1] <= s or sp[0] >= ts):
                continue
            if maint_by_inst and maintenance_overlap_seconds(maint_by_inst.get(i), s, ts) >= (ts - s):
                continue
            n += 1
        return n

    expected_by_ts = {}
    k = first_slot_key
    while k <= last_slot_key:
        expected_by_ts[point_ts(k)] = expected_hosts(point_ts(k))
        k += slot

    def insufficient(ts):
        exp = expected_by_ts[ts] if ts in expected_by_ts else expected_hosts(ts)
        return exp > 0 and len(host_slots.get(ts, {})) < min_reporting_ratio * exp

    # Slots that need Prometheus: absent from SQLite, or too few hosts in it —
    # the in-progress slot at `end` included (holding the previous slot's value
    # up to "now" is what hid a fresh fleet-wide outage behind a flat line).
    missing_ts = {ts for ts in expected_by_ts if insufficient(ts)}

    if missing_ts:
        # Grid-aligned slots in one query_range over [min, max] ONLY (scoped
        # to the actual gap, not the full window); the unaligned in-progress
        # slot ends at `end`, which a query_range stepping from an aligned
        # start never lands on, so it gets its own evaluation at `end` over
        # exactly its elapsed length.
        aligned = sorted(t for t in missing_ts if (t + WIB_OFFSET_SEC) % slot == 0)
        tails = sorted(t for t in missing_ts if (t + WIB_OFFSET_SEC) % slot != 0)
        insts_key = tuple(sorted(instances))
        prom_by_ts = {}
        queries = []
        if aligned:
            queries.append((aligned[0], aligned[-1], slot))
        for t in tails:
            queries.append((t, t, int(t - key_of(t - 1))))
        for q_start, q_end, q_win in queries:
            trend_timeout = max(6.0, min(25.0, (q_end - q_start) / 120000.0))
            # 60s cache of the Prometheus-only per-host result; merged against
            # the CURRENT host_slots below, which changes as the aggregator
            # materializes more hours.
            ck = (source or "", job or "", insts_key, q_start, q_end, slot, q_win)
            hit = _FLEET_TREND_CACHE.get(ck)
            got = hit[1] if hit and (time.time() - hit[0]) < _FLEET_TREND_CACHE_TTL else None
            if got is None:
                extra = {}
                if q_win != slot:
                    extra["window"] = q_win
                if prefer_job:
                    extra["prefer_job"] = prefer_job
                got = _query_prometheus_trend(job, instances, q_start, q_end, slot, trend_timeout,
                                              source=source, **extra)
                _FLEET_TREND_CACHE[ck] = (time.time(), got)
            for ts, per_inst in (got or {}).items():
                prom_by_ts.setdefault(ts, {}).update(per_inst)

        for ts, per_inst in prom_by_ts.items():
            if ts not in missing_ts:
                continue
            have = host_slots.setdefault(ts, {})
            s_slot = slot_start(ts)
            length = max(1.0, float(ts - s_slot))
            for inst, (upt, cov) in per_inst.items():
                if inst in have or inst not in inst_set or cov <= 0:
                    continue
                upt, cov = min(upt, length), min(cov, length)
                maint_cov = maintenance_overlap_seconds(maint_by_inst.get(inst), s_slot, ts)
                if maint_cov > 0:
                    # Only a ratio is known for the slot, no outage times: the
                    # headline's Prometheus-segment carve — maintenance leaves
                    # the denominator and excuses its FRACTION of the downtime.
                    down = max(0.0, cov - upt)
                    upt, _, cov = sla_carve_seconds(upt, down, cov, down * min(1.0, maint_cov / length), maint_cov)
                if cov > 0:
                    have[inst] = [upt, cov]

    series = []
    for ts in sorted(host_slots):
        hosts = host_slots[ts]
        if not hosts:
            continue
        exp = expected_by_ts[ts] if ts in expected_by_ts else expected_hosts(ts)
        up_s = sum(v[0] for v in hosts.values())
        cov_s = sum(v[1] for v in hosts.values())
        pct = None
        if cov_s > 0 and not insufficient(ts):
            pct = round(max(0.0, min(100.0, (up_s / cov_s) * 100.0)), 2)
        series.append({"ts": ts, "availability_pct": pct,
                       "hosts_reporting": len(hosts), "hosts_expected": exp})
    return series, slot


def _build_fleet_incidents(
    db_bucket_records: Optional[List[Dict[str, Any]]],
    req_start: float,
    req_end: float,
    instances: Optional[List[str]] = None,
    job: Optional[str] = None,
    source: Optional[str] = None,
    maint_by_inst: Optional[Dict[str, Any]] = None,
) -> List[Dict[str, Any]]:
    """Extract and merge exact outage intervals across [req_start, req_end]
    for the Availability Trend sweep. Preserves all incident intervals without
    calendar-day slicing or the calendar's 50-event truncation.

    Intervals come from fleet.slice_bucket — clipped to the window and with
    planned maintenance cut out, exactly like the Calendar's events — so a tick
    is only drawn for downtime the headline actually counts. A piece whose
    edge was cut (window, bucket or maintenance) is flagged carried_in /
    still_down, never drawn as a fake drop or recovery."""
    if req_end <= req_start:
        return []
    inst_set = set(instances) if instances else None
    maint_by_inst = maint_by_inst or {}

    by_host: Dict[str, Dict[str, Any]] = {}
    observed: Dict[Tuple[str, float], bool] = {}
    for row in (db_bucket_records or []):
        inst = row.get("instance")
        if not inst or (inst_set and inst not in inst_set):
            continue
        if float(row.get("downtime_seconds") or 0.0) <= 0:
            observed[(inst, float(row.get("bucket_start") or 0.0))] = False
            continue
        sl = _slice_row(row, req_start, req_end, maint_by_inst.get(inst), now=req_end)
        observed[(inst, float(row.get("bucket_start") or 0.0))] = _row_continues_outage(row, sl)
        # No per-host outage intervals stored for this hour (scalar fallback,
        # backfill pending): skip it. Synthesizing one ("down from the top of
        # the hour for downtime_seconds") showed invented DOWN/RECOVERED times
        # in the Trend while the Calendar correctly said intervals are
        # unavailable; the UI explains that case via daily[].events_unavailable.
        if not sl or not sl["outages"]:
            continue
        h_entry = by_host.setdefault(inst, {
            "instance": inst,
            "name": inst,
            "job": row.get("job") or "blackbox",
            "raw_intervals": [],
        })
        h_entry["raw_intervals"].extend(sl["outages"])

    # Also fold in live active incidents for this source so current outages are
    # never missing — but only alerts that mean the host is DOWN. Every firing
    # incident used to count (SlowResponse, CPU, disk...), so the Trend said
    # "1 host down" over a 100% line. Planned maintenance is cut out here too.
    try:
        try:
            from storage.repositories.alerts import IncidentRepository
        except (ImportError, ValueError):
            from alarm.storage.repositories.alerts import IncidentRepository
        active_incs = IncidentRepository.get_active_incidents(source=source)
        for inc in active_incs or []:
            inst = inc.get("instance")
            if not inst or (inst_set and inst not in inst_set):
                continue
            if inc.get("name") not in DOWN_ALERTNAMES:
                continue
            started = float(inc.get("time") or inc.get("started_at") or 0.0)
            if not started or started > req_end:
                continue
            pieces = subtract_windows(started, req_end, maint_by_inst.get(inst))
            if not pieces:
                continue
            h_entry = by_host.setdefault(inst, {
                "instance": inst,
                "name": inst,
                "job": inc.get("job") or "blackbox",
                "raw_intervals": [],
            })
            for a, b in pieces:
                h_entry["raw_intervals"].append((a, b, a < req_start or a > started, True))
    except Exception:
        pass

    results = []
    for inst, h in by_host.items():
        raw = sorted(h["raw_intervals"], key=lambda x: x[0])
        merged = []
        for s, e, open_start, open_end in raw:
            if not merged:
                merged.append([s, e, open_start, open_end])
            else:
                if s <= merged[-1][1] + 120.0:
                    if e >= merged[-1][1]:
                        merged[-1][3] = open_end
                    merged[-1][1] = max(merged[-1][1], e)
                else:
                    merged.append([s, e, open_start, open_end])
        if not merged:
            continue
        _close_stale_open_ends(merged, inst, observed, maint_by_inst.get(inst))
        earliest_start = merged[0][0]
        latest_end = merged[-1][1]
        results.append({
            "instance": inst,
            "name": inst,
            "job": h["job"],
            "start_ts": int(earliest_start),
            "end_ts": int(latest_end),
            "duration_sec": round(sum(max(0.0, e - s) for s, e, _, _ in merged), 1),
            "incident_count": len(merged),
            "intervals": [
                {
                    "start_ts": int(s), "end_ts": int(e),
                    "duration_sec": round(max(0.0, e - s), 1),
                    "carried_in": bool(open_start),
                    "still_down": bool(open_end),
                }
                for s, e, open_start, open_end in merged
            ],
        })
    return results


def _query_prometheus_trend(job, instances, start, end, slot, timeout, source=None, window=None, prefer_job=None):
    """Per-host samples from the real TSDB for [start, end] at `slot`
    resolution: {ts: {instance: (uptime_s, coverage_s)}}, each point covering
    the `window` seconds before it (default `slot`).

    Scoped to the view's `job` (same matcher as the stored rows) and, where an
    instance still has several series (e.g. `up` from four gitlab jobs), to
    the series of its own job (`prefer_job`) — never whichever came last.
    Never raises; an unreachable Prometheus yields {} (no data).
    """
    if not source:
        return {}
    window = int(window or slot)

    def _fetch(expr):
        path = f"/api/v1/query_range?query={quote(expr)}&start={start}&end={end}&step={slot}"
        try:
            raw, _ = promclient.fetch_prometheus_json(path, use_cache=True, cache_ttl=45.0, timeout=timeout, source=source)
        except Exception:
            logger.warning("fleet trend query_range failed for expr: %s", expr[:60], exc_info=True)
            return None
        if not raw or raw.get("status") != "success":
            return None
        picked = {}
        for r in raw.get("data", {}).get("result", []):
            labels = r.get("metric") or {}
            inst = labels.get("instance")
            for pair in r.get("values", []):
                try:
                    v = float(pair[1])
                    if v == v:  # NaN -> no samples in this slot
                        pick_series(picked.setdefault(int(float(pair[0])), {}), inst, labels, v, prefer_job)
                except (ValueError, TypeError, IndexError):
                    continue
        return {ts: {i: v for i, (_, v) in per.items()} for ts, per in picked.items()}

    # Per host: probe_success when it has one, else `up` — the same precedence
    # derive_bucket_inputs gives the Calendar and the aggregator.
    # ponytail: a host observed for only part of a slot still weighs a full
    # slot here; SQLite-backed slots carry exact coverage.
    matchers = ["instance=~`" + "|".join(re.escape(i) for i in instances) + "`"]
    if job_selector(job):
        matchers.append(job_selector(job))
    sel = "{" + ",".join(matchers) + "}"
    # A failed probe_success fetch must not leave `up` standing in for it: a
    # blackbox target's `up` is 1 while its probe fails, so every down host
    # would chart as up. No probe answer -> no data (the hourly rows serve).
    probe = _fetch(f"avg_over_time(probe_success{sel}[{window}s])")
    if probe is None:
        return {}
    ratio_by_ts = {}
    for per_by_ts in (_fetch(f"avg_over_time(up{sel}[{window}s])") or {}, probe):  # probe last so it wins
        for ts, per_inst in per_by_ts.items():
            ratio_by_ts.setdefault(ts, {}).update(per_inst)
    return {ts: {i: (float(window) * r, float(window)) for i, r in per.items()} for ts, per in ratio_by_ts.items()}

# Cap on how many downtime events a single day returns — a bad week on a big
# fleet could otherwise put hundreds of intervals in one payload. Sorted by
# duration first so truncation drops the least-interesting ones.
_DAILY_MAX_EVENTS = 100


_DAILY_PROMETHEUS_CACHE = {}          # key -> (wall_ts, prom_data)
_DAILY_PROMETHEUS_CACHE_TTL = 60.0


def clear_helpers_caches():
    """Clear module-level fleet trend and daily prometheus caches."""
    _FLEET_TREND_CACHE.clear()
    _DAILY_PROMETHEUS_CACHE.clear()


def _job_filter(job):
    sel = job_selector(job)
    return "{" + sel + "}" if sel else ""


def _run_queries(queries, fetch):
    raw_results = {}
    executor = getattr(promclient, "_SHARED_EXECUTOR", None)
    if executor:
        futures = {k: executor.submit(fetch, q) for k, q in queries.items()}
        for k, f in futures.items():
            try:
                raw_results[k] = f.result()
            except Exception:
                raw_results[k] = []
    else:
        for k, q in queries.items():
            raw_results[k] = fetch(q)
    return raw_results


def _query_prometheus_daily_matrix(job, start, end, step=86400, timeout=20.0, source=None, prefer_job=None):
    """Batch-query ONE Prometheus server (`source`) across all full missing days.
    Scoped to `job` and, per instance, to its own job's series (prefer_job)."""
    if promclient is None or not source:
        return {}

    job_filter = _job_filter(job)
    range_queries = {
        "probe_avail": f"avg_over_time(probe_success{job_filter}[1d]) * 100",
        "up_avail": f"avg_over_time(up{job_filter}[1d]) * 100",
        "probe_count": f"count_over_time(probe_success{job_filter}[1d])",
        "up_count": f"count_over_time(up{job_filter}[1d])",
        "probe_incidents": f"changes(probe_success{job_filter}[1d])",
        "up_incidents": f"changes(up{job_filter}[1d])",
        "duration": f"avg_over_time(probe_duration_seconds{job_filter}[1d]) * 1000",
    }

    def _fetch(expr):
        path = f"/api/v1/query_range?query={quote(expr)}&start={int(start)}&end={int(end)}&step={int(step)}"
        try:
            raw, _ = promclient.fetch_prometheus_json(path, use_cache=True, cache_ttl=60.0, timeout=timeout, source=source)
        except Exception:
            raw = None
        if raw and raw.get("status") == "success":
            return raw.get("data", {}).get("result", [])
        return []

    raw_results = _run_queries(range_queries, _fetch)
    picked = {k: {} for k in range_queries}
    for metric_name, results in raw_results.items():
        for item in results:
            m = item.get("metric", {})
            inst = m.get("instance") or m.get("target") or m.get("url")
            if not inst:
                continue
            for pair in item.get("values", []):
                try:
                    ts = float(pair[0])
                    midpoint = ts - 43200.0
                    d_str = datetime.fromtimestamp(midpoint + WIB_OFFSET_SEC, tz=timezone.utc).strftime("%Y-%m-%d")
                    val = float(pair[1])
                    if val == val:
                        pick_series(picked[metric_name].setdefault(d_str, {}), inst, m, val, prefer_job)
                except (ValueError, TypeError, IndexError):
                    continue
    return {k: {d: {i: v for i, (_, v) in per.items()} for d, per in days.items()} for k, days in picked.items()}


def _query_prometheus_partial_day(job, at_ts, duration_sec, timeout=15.0, source=None, prefer_job=None):
    """Query ONE Prometheus server (`source`) for an in-progress partial day."""
    if promclient is None or duration_sec <= 0 or not source:
        return {}
    dur_sec = max(60, int(duration_sec))
    job_filter = _job_filter(job)
    queries = {
        "probe_avail": f"avg_over_time(probe_success{job_filter}[{dur_sec}s]) * 100",
        "up_avail": f"avg_over_time(up{job_filter}[{dur_sec}s]) * 100",
        "probe_count": f"count_over_time(probe_success{job_filter}[{dur_sec}s])",
        "up_count": f"count_over_time(up{job_filter}[{dur_sec}s])",
        "probe_incidents": f"changes(probe_success{job_filter}[{dur_sec}s])",
        "up_incidents": f"changes(up{job_filter}[{dur_sec}s])",
        "duration": f"avg_over_time(probe_duration_seconds{job_filter}[{dur_sec}s]) * 1000",
    }

    def _fetch(expr):
        path = f"/api/v1/query?query={quote(expr)}&time={int(at_ts)}"
        try:
            raw, _ = promclient.fetch_prometheus_json(path, use_cache=True, cache_ttl=30.0, timeout=timeout, source=source)
        except Exception:
            raw = None
        if raw and raw.get("status") == "success":
            return raw.get("data", {}).get("result", [])
        return []

    raw_results = _run_queries(queries, _fetch)
    picked = {k: {} for k in queries}
    for metric_name, results in raw_results.items():
        for item in results:
            m = item.get("metric", {})
            inst = m.get("instance") or m.get("target") or m.get("url")
            if not inst:
                continue
            pair = item.get("value", [None, None])
            try:
                val = float(pair[1])
                if val == val:
                    pick_series(picked[metric_name], inst, m, val, prefer_job)
            except (ValueError, TypeError, IndexError):
                continue
    return {k: {i: v for i, (_, v) in per.items()} for k, per in picked.items()}


def _wib_day_start(d_str):
    return datetime.strptime(d_str, "%Y-%m-%d").replace(tzinfo=timezone.utc).timestamp() - WIB_OFFSET_SEC


def _row_continues_outage(row, sl) -> bool:
    """True when this hour's row opens mid-outage (its first outage piece
    starts at the bucket start, cut by the bucket edge)."""
    outs = (sl or {}).get("outages") or []
    b_start = float(row.get("bucket_start") or 0.0)
    return bool(outs) and bool(outs[0][2]) and outs[0][0] <= b_start + 1.0


def _close_stale_open_ends(merged, inst, observed, maint_windows):
    """Clear still_down on a piece that only looked open because its hour
    ended while the last sample was down: when the NEXT hour was observed and
    does not continue the outage, the host was back at the boundary. Left
    open, the UI drew no recovery and called a 27s blip "ongoing".
    `observed` maps (instance, bucket_start) -> continues-outage flag for
    every stored row; an hour with no row (telemetry gap) or a maintenance
    window starting at the edge stays open — we don't know it recovered."""
    for iv in merged:
        e = float(iv[1])
        if iv[3] and observed.get((inst, e)) is False and not any(
                float(a) <= e < float(b) for a, b in (maint_windows or [])):
            iv[3] = False
    return merged


def _merge_outages(raw):
    merged = []
    for s, e, open_start, open_end in sorted(raw, key=lambda x: x[0]):
        if merged and s <= merged[-1][1] + 1.0:
            if e >= merged[-1][1]:
                merged[-1][3] = open_end
            merged[-1][1] = max(merged[-1][1], e)
        else:
            merged.append([s, e, open_start, open_end])
    return merged


def _build_daily_downtime(
    db_bucket_records,
    req_start,
    req_end,
    instances=None,
    job=None,
    maint_by_inst=None,
    cadence_map=None,
    instance_job_map=None,
    source=None,
):
    """Per-calendar-day downtime rollup for the modal's Downtime Calendar
    section.

    Materialized SQLite rows are priced with fleet.slice_bucket — clipped to
    [req_start, req_end] with their exact outage intervals and maintenance
    carved out, the same helper the headline and the Trend use — so a day's %,
    its hosts_down and its listed intervals all describe the downtime the
    headline counts. Days SQLite doesn't (fully) hold are reconstructed from
    Prometheus through the canonical pipeline (merge_hybrid_target_availability).

    Rows for instances outside `instances` (targets no longer monitored,
    folded back in by the engine) count on the days they have rows.

    Every day carries coverage_pct (observed host-seconds over the host-seconds
    expected that day, maintenance excluded) and limited_data (coverage below
    the SLA minimum) so a mostly-unobserved day never reads as a clean 100%.
    """
    if req_end <= req_start:
        return []
    if not db_bucket_records and not instances:
        return []
    maint_by_inst = maint_by_inst or {}
    inst_set = set(instances or [])
    min_cov_pct = get_min_sla_coverage_percent()

    days = {}
    extra_rows = {}  # instance (not monitored any more) -> its rows
    observed = {}    # (instance, bucket_start) -> row opens mid-outage
    for row in db_bucket_records or []:
        instance = row.get("instance")
        if not instance:
            continue
        if inst_set and instance not in inst_set:
            extra_rows.setdefault(instance, []).append(row)
        sl = _slice_row(row, req_start, req_end, maint_by_inst.get(instance), now=req_end)
        observed[(instance, float(row.get("bucket_start") or 0.0))] = _row_continues_outage(row, sl)
        if not sl:
            continue
        date_str = datetime.fromtimestamp(sl["bucket_start"] + WIB_OFFSET_SEC, tz=timezone.utc).strftime("%Y-%m-%d")
        day = days.setdefault(date_str, {
            "uptime_sec": 0.0, "coverage_sec": 0.0, "observed_sec": 0.0,
            "hosts_down": set(), "host_events": {}, "outage_missing": False,
            "host_hours": set(), "extra_expected_sec": 0.0,
        })
        day["host_hours"].add((instance, float(row.get("bucket_start") or 0.0)))
        day["coverage_sec"] += sl["sla_coverage"]
        day["uptime_sec"] += sl["sla_uptime"]
        day["observed_sec"] += sl["sla_coverage"]
        if inst_set and instance not in inst_set:
            day["extra_expected_sec"] += max(0.0, sl["bucket_end"] - sl["bucket_start"] - sl["maint_cov"])

        if sl["sla_downtime"] <= 0 and not sl["outages"]:
            continue
        if sl["outages"] is None:
            # downtime known, no per-outage intervals (scalar fallback row)
            day["outage_missing"] = True
            day["hosts_down"].add(instance)
            continue
        if not sl["outages"]:
            continue
        day["hosts_down"].add(instance)
        day["host_events"].setdefault(instance, {
            "instance": instance, "name": instance,
            "job": row.get("job") or "blackbox", "raw_intervals": [],
        })["raw_intervals"].extend(sl["outages"])

    def _day_slice(d_str):
        d_start = _wib_day_start(d_str)
        return max(req_start, d_start), min(req_end, d_start + 86400.0)

    def _expected_sec(d_str, extra=0.0):
        s, e = _day_slice(d_str)
        if not instances:
            return None
        total = 0.0
        for inst in instances:
            total += max(0.0, (e - s) - maintenance_overlap_seconds(maint_by_inst.get(inst), s, e))
        return total + extra

    def _coverage_fields(d_str, observed, extra=0.0):
        exp = _expected_sec(d_str, extra)
        if not exp:
            return {"coverage_pct": None, "limited_data": False}
        cov_pct = round(min(100.0, 100.0 * observed / exp), 2)
        return {"coverage_pct": cov_pct, "limited_data": cov_pct < min_cov_pct}

    out_by_date = {}
    for date_str in sorted(days.keys()):
        d = days[date_str]
        avail_pct = (
            round((d["uptime_sec"] / d["coverage_sec"]) * 100.0, 2)
            if d["coverage_sec"] > 0 else None
        )

        host_entries = []
        for instance, h in d["host_events"].items():
            merged = _close_stale_open_ends(
                _merge_outages(h["raw_intervals"]), instance, observed, maint_by_inst.get(instance))
            host_entries.append({
                "instance": instance,
                "name": instance,
                "job": h["job"],
                "start_ts": int(merged[0][0]) if merged else 0,
                "end_ts": int(merged[-1][1]) if merged else 0,
                "duration_sec": round(sum(e - s for s, e, _, _ in merged), 1),
                "incident_count": len(merged),
                "intervals": [
                    {
                        "start_ts": int(s), "end_ts": int(e),
                        "duration_sec": round(max(0.0, e - s), 1),
                        "carried_in": bool(open_start),
                        "still_down": bool(open_end),
                    }
                    for s, e, open_start, open_end in merged
                ],
            })

        events_sorted = sorted(host_entries, key=lambda e: e["duration_sec"], reverse=True)
        truncated = max(0, len(events_sorted) - _DAILY_MAX_EVENTS)

        entry = {
            "date": date_str,
            "availability_pct": avail_pct,
            "hosts_down": len(d["hosts_down"]),
        }
        entry.update(_coverage_fields(date_str, d["observed_sec"], d["extra_expected_sec"]))
        if d["outage_missing"] and not events_sorted:
            entry["events"] = None
            entry["events_unavailable"] = True
        else:
            entry["events"] = events_sorted[:_DAILY_MAX_EVENTS]
            if truncated:
                entry["truncated_count"] = truncated
            if d["outage_missing"]:
                entry["events_unavailable"] = "partial"
        out_by_date[date_str] = entry

    # Determine requested period calendar days (WIB)
    start_dt = datetime.fromtimestamp(req_start + WIB_OFFSET_SEC, tz=timezone.utc).date()
    end_dt = datetime.fromtimestamp(max(req_start, req_end - 1e-6) + WIB_OFFSET_SEC, tz=timezone.utc).date()
    all_dates = []
    cur_dt = start_dt
    while cur_dt <= end_dt:
        all_dates.append(cur_dt.strftime("%Y-%m-%d"))
        cur_dt += timedelta(days=1)

    def _incomplete(d_str):
        # A day SQLite holds only some hours of (history still backfilling,
        # or an aggregator gap) must not be priced from those hours alone —
        # that is a different number than Prometheus has for the whole day.
        if not instances or d_str not in days:
            return False
        s, e = _day_slice(d_str)
        hours = math.floor((e - s) / 3600.0)
        monitored_hours = sum(1 for inst, _ in days[d_str]["host_hours"] if inst in inst_set)
        return monitored_hours < 0.95 * len(instances) * hours

    # Missing days are those without SQLite records (or with 0 coverage), or
    # only partly materialized.
    missing_dates = [d for d in all_dates
                     if d not in out_by_date or out_by_date[d]["availability_pct"] is None or _incomplete(d)]

    if not instances or not missing_dates or promclient is None:
        return [out_by_date[d] for d in all_dates if d in out_by_date]

    # Resolve cadence_map if not provided
    if cadence_map is None:
        try:
            try:
                from core.monitoring.state import get_instance_cadence_map
            except (ImportError, ValueError):
                from alarm.core.monitoring.state import get_instance_cadence_map
            cadence_map = dict(get_instance_cadence_map(job, source=source))
        except Exception:
            cadence_map = {}

    # Separate missing days into full 24h days and partial days (e.g. today or partial window edges)
    full_missing = []
    partial_missing = []
    for d_str in missing_dates:
        s_start, s_end = _day_slice(d_str)
        if (s_end - s_start) >= 86399.0:
            full_missing.append(d_str)
        else:
            partial_missing.append((d_str, s_start, s_end))

    prom_data = {
        "probe_avail": {}, "up_avail": {}, "probe_count": {}, "up_count": {},
        "probe_incidents": {}, "up_incidents": {}, "duration": {},
    }

    # 1. Batch query full missing days in one query_range sweep
    if full_missing:
        range_start = _wib_day_start(full_missing[0]) + 86400.0
        range_end = _wib_day_start(full_missing[-1]) + 86400.0

        cache_key = (source or "", job or "", tuple(sorted(instances)), range_start, range_end)
        hit = _DAILY_PROMETHEUS_CACHE.get(cache_key)
        matrix_data = hit[1] if hit and (time.time() - hit[0]) < _DAILY_PROMETHEUS_CACHE_TTL else None
        if matrix_data is None:
            matrix_data = _query_prometheus_daily_matrix(job, range_start, range_end, step=86400, source=source,
                                                         prefer_job=instance_job_map)
            _DAILY_PROMETHEUS_CACHE[cache_key] = (time.time(), matrix_data)

        for m_name, d_map in matrix_data.items():
            for d_str, inst_map in d_map.items():
                prom_data.setdefault(m_name, {}).setdefault(d_str, {}).update(inst_map)

    # 2. Query partial missing days (if any, typically today in progress)
    for d_str, s_start, s_end in partial_missing:
        dur_sec = max(60, int(s_end - s_start))
        p_data = _query_prometheus_partial_day(job, s_end, dur_sec, source=source, prefer_job=instance_job_map)
        for m_name, inst_map in p_data.items():
            prom_data.setdefault(m_name, {}).setdefault(d_str, {}).update(inst_map)

    # 3. Canonical availability processing for each missing day
    for d_str in missing_dates:
        day_slice_start, day_slice_end = _day_slice(d_str)
        period_minutes = max(0.0, (day_slice_end - day_slice_start) / 60.0)

        day_probe = {
            "avail": prom_data.get("probe_avail", {}).get(d_str, {}),
            "count": prom_data.get("probe_count", {}).get(d_str, {}),
            "incidents": prom_data.get("probe_incidents", {}).get(d_str, {}),
        }
        day_up = {
            "avail": prom_data.get("up_avail", {}).get(d_str, {}),
            "count": prom_data.get("up_count", {}).get(d_str, {}),
            "incidents": prom_data.get("up_incidents", {}).get(d_str, {}),
        }
        day_dur = prom_data.get("duration", {}).get(d_str, {})

        merged_maps = derive_bucket_inputs(instances, day_probe, day_up)

        day_entries = []
        for inst in instances:
            if isinstance(cadence_map, dict):
                inst_interval = cadence_map.get(inst) or DEFAULT_SCRAPE_INTERVAL_SEC
            elif cadence_map is not None:
                inst_interval = cadence_map
            else:
                inst_interval = DEFAULT_SCRAPE_INTERVAL_SEC

            target_job = (instance_job_map or {}).get(inst) or job or "blackbox"
            inst_prom = {
                "avail": merged_maps.get("avail", {}).get(inst),
                "count": merged_maps.get("count", {}).get(inst),
                "incidents": merged_maps.get("incidents", {}).get(inst),
                "duration": day_dur.get(inst),
            }
            day_entries.append(merge_hybrid_target_availability(
                req_start=day_slice_start,
                req_end=day_slice_end,
                target_id=inst,
                target_name=inst,
                job=target_job,
                sqlite_buckets=[],
                prom_metrics=inst_prom,
                expected_interval_sec=inst_interval,
                maintenance_windows=maint_by_inst.get(inst),
            ))
        # No longer monitored hosts: Prometheus has nothing for them any more,
        # their stored rows for this day are all there is.
        for inst, rows in extra_rows.items():
            day_entries.append(merge_hybrid_target_availability(
                req_start=day_slice_start,
                req_end=day_slice_end,
                target_id=inst,
                target_name=inst,
                job=rows[-1].get("job") or job or "blackbox",
                sqlite_buckets=rows,
                prom_metrics={},
                maintenance_windows=maint_by_inst.get(inst),
            ))

        day_summary = summarize_entries(day_entries, period_minutes=period_minutes)
        avail_pct = day_summary.get("fleet_aggregate", {}).get("value")
        # Same basis as the SQLite days: downtime left after maintenance.
        down_count = len([e for e in day_entries
                          if (e.get("sla_downtime_seconds", e.get("downtime_seconds")) or 0.0) > 0])
        observed = sum(float(e.get("sla_observed_seconds", e.get("observed_seconds")) or 0.0) for e in day_entries)
        extra_expected = days.get(d_str, {}).get("extra_expected_sec", 0.0)
        cov_fields = _coverage_fields(d_str, observed, extra_expected)

        prev = out_by_date.get(d_str) or {}
        # If Prometheus returned no data (e.g. beyond retention limit), DO NOT
        # overwrite valid SQLite data — but it keeps its own (low) coverage and
        # limited_data flag, so a day priced from a few stored hours is marked.
        if avail_pct is None and prev.get("availability_pct") is not None:
            continue

        if prev.get("events"):
            # Partly materialized day: Prometheus prices the whole day, the
            # per-host intervals already stored stay (incomplete, so "partial").
            out_by_date[d_str] = dict(
                prev,
                availability_pct=avail_pct if avail_pct is not None else prev.get("availability_pct"),
                hosts_down=max(down_count, prev.get("hosts_down") or 0),
                events_unavailable="partial",
                **(cov_fields if avail_pct is not None else {}),
            )
            continue
        entry = {
            "date": d_str,
            "availability_pct": avail_pct if avail_pct is not None else prev.get("availability_pct"),
            "hosts_down": down_count if avail_pct is not None else (prev.get("hosts_down") or 0),
            "events": prev.get("events"),
            "events_unavailable": True if not prev.get("events") else "partial",
        }
        entry.update(cov_fields if avail_pct is not None else
                     {k: prev.get(k) for k in ("coverage_pct", "limited_data")} if prev else
                     {"coverage_pct": 0.0, "limited_data": True})
        out_by_date[d_str] = entry

    return [out_by_date[d] for d in all_dates if d in out_by_date]
