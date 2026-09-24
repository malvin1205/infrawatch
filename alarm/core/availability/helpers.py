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
    )
    from config import AVAIL_TREND_MIN_REPORTING_RATIO
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
    )
    from alarm.config import AVAIL_TREND_MIN_REPORTING_RATIO
    from alarm.core.monitoring import client as promclient

logger = logging.getLogger("infrawatch")

# Fixed UTC+7 offset for Asia/Jakarta (WIB) — no DST, so plain arithmetic is
# exact and doesn't need a timezone database. This deployment's operators are
# all in Indonesia; every calendar-day grouping and hour label in the
# Availability Breakdown modal (backend and frontend alike) uses this same
# offset so the two sides can never disagree about which day/hour an event
# falls in.
WIB_OFFSET_SEC = 7 * 3600


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
    the same carve-out merge_hybrid_target_availability applies before
    fleet_aggregate pools hosts, so the Trend and the headline agree."""
    maint_cov = min(coverage, maint_cov)
    if maint_cov <= 0:
        return uptime, coverage
    cov = max(0.0, coverage - maint_cov)
    down = min(max(0.0, downtime - min(downtime, excused_down, maint_cov)), cov)
    return max(0.0, cov - down), cov


def _build_fleet_trend(trend_end_ts, window_seconds, instances, max_points=180, db_bucket_records=None, job=None,
                       maint_by_inst=None, min_reporting_ratio=None, source=None):
    """Fleet availability time series for the modal's Availability Trend chart.

    Each point pools every reporting host's maintenance-excluded seconds —
    Σ uptime / Σ coverage, the fleet_aggregate formula — and carries
    hosts_reporting / hosts_expected. A slot where fewer than
    `min_reporting_ratio` of the expected hosts have data returns
    availability_pct=None ("partial data"): pooling whichever handful of
    hosts happened to report would present that subset as the whole fleet.
    A slot with no host at all is omitted (no telemetry).

    Host-slots come from materialized hourly buckets first; hosts a slot is
    missing (or a slot missing entirely) are filled per host from Prometheus
    server `source` only (no failover) with the same pooling — never two
    sources for the same host-slot. No `source` => no Prometheus fill.
    """
    if min_reporting_ratio is None:
        min_reporting_ratio = AVAIL_TREND_MIN_REPORTING_RATIO
    maint_by_inst = maint_by_inst or {}
    end = int(trend_end_ts)
    win = max(3600.0, float(window_seconds or 0.0))
    slot = 3600
    if win / slot > max_points:
        slot = int(math.ceil(win / max_points / 3600.0) * 3600.0)
    # Every point summarizes a slot that sits inside [end - win, end].
    start = end - int(win)

    if not instances:
        return [], slot
    inst_set = set(instances)

    # Points land on epoch-aligned slot boundaries (slot_key + slot), clipped
    # to `end` for the in-progress slot so no point carries a future ts.
    first_slot_key = int(math.floor(start / slot) * slot)
    last_slot_key = int(math.floor((end - 1) / slot) * slot)
    point_ts = lambda k: min(k + slot, end)

    # {point_ts: {instance: [uptime_s, coverage_s]}}
    host_slots = {}
    for r in db_bucket_records or []:
        inst = r.get("instance")
        if inst not in inst_set:
            continue
        cov = float(r.get("coverage_seconds", 0) or 0)
        if cov <= 0:
            continue
        b_start = float(r.get("bucket_start", 0))
        b_end = float(r.get("bucket_end") or (b_start + slot))
        if b_end <= (end - win) or b_start >= end:
            continue
        upt = float(r.get("uptime_seconds", 0) or 0)
        down = float(r.get("downtime_seconds", 0) or 0)
        wins = maint_by_inst.get(inst)
        maint_cov = excused = 0.0
        if wins:
            maint_cov = maintenance_overlap_seconds(wins, b_start, b_end)
            if maint_cov > 0:
                exact = _bucket_outage_downtime_in_maintenance(r, b_start, b_end, wins)
                excused = maint_cov if exact is None else exact
        upt, cov = _slot_host_seconds(upt, down, cov, excused, maint_cov)
        if cov <= 0:
            continue
        slot_key = int(math.floor(b_start / slot) * slot)
        acc = host_slots.setdefault(point_ts(slot_key), {}).setdefault(inst, [0.0, 0.0])
        acc[0] += upt
        acc[1] += cov

    def expected_hosts(ts):
        # A host fully inside maintenance for the slot isn't expected to report.
        if not maint_by_inst:
            return len(instances)
        s = ts - slot
        return sum(1 for i in instances
                   if maintenance_overlap_seconds(maint_by_inst.get(i), s, ts) < (ts - s))

    expected_by_ts = {}
    k = first_slot_key
    while k <= last_slot_key:
        expected_by_ts[point_ts(k)] = expected_hosts(point_ts(k))
        k += slot

    def insufficient(ts):
        # A bucket straddling the window start lands one slot before the grid;
        # it's held to the same bar, not waved through.
        exp = expected_by_ts[ts] if ts in expected_by_ts else expected_hosts(ts)
        return exp > 0 and len(host_slots.get(ts, {})) < min_reporting_ratio * exp

    # Slots that need Prometheus: absent from SQLite, or too few hosts in it.
    # An ongoing slot right at `end` is still aggregating in live memory.
    missing_ts = {ts for ts in expected_by_ts if insufficient(ts)}
    if len(missing_ts) == 1 and list(missing_ts)[0] == point_ts(last_slot_key) and (end - last_slot_key) < slot:
        missing_ts = set()

    if missing_ts:
        # Queried over [min(missing_ts), max(missing_ts)] ONLY, not the full
        # window — scoping it to the actual gap keeps the fallback
        # proportional to what's actually missing (a full-window query_range
        # on every gap is what made this take 20s+ before).
        gap_start, gap_end = min(missing_ts), max(missing_ts)
        trend_timeout = max(6.0, min(25.0, (gap_end - gap_start) / 120000.0))
        # 60s cache of the Prometheus-only per-host result; merged against the
        # CURRENT host_slots below, which changes as the aggregator
        # materializes more hours.
        ck = (source or "", job or "", tuple(sorted(instances)), gap_start, gap_end, slot)
        hit = _FLEET_TREND_CACHE.get(ck)
        prom_by_ts = hit[1] if hit and (time.time() - hit[0]) < _FLEET_TREND_CACHE_TTL else None
        if prom_by_ts is None:
            prom_by_ts = _query_prometheus_trend(job, instances, gap_start, gap_end, slot, trend_timeout, source=source)
            _FLEET_TREND_CACHE[ck] = (time.time(), prom_by_ts)

        for ts, per_inst in (prom_by_ts or {}).items():
            if ts not in missing_ts:
                continue
            have = host_slots.setdefault(ts, {})
            for inst, (upt, cov) in per_inst.items():
                if inst in have or inst not in inst_set or cov <= 0:
                    continue
                maint_cov = maintenance_overlap_seconds(maint_by_inst.get(inst), ts - slot, ts)
                # ponytail: Prometheus gives a ratio per slot, not outage times,
                # so maintenance only shrinks the host's weight here (downtime
                # inside the window isn't excused). Exact carve-out would need
                # a finer query_range step.
                if maint_cov > 0:
                    scale = max(0.0, 1.0 - maint_cov / float(slot))
                    upt, cov = upt * scale, cov * scale
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
) -> List[Dict[str, Any]]:
    """Extract and merge exact outage intervals across [req_start, req_end]
    for the Availability Trend sweep. Preserves all incident intervals without
    calendar-day slicing or the calendar's 50-event truncation."""
    if req_end <= req_start:
        return []
    inst_set = set(instances) if instances else None

    by_host: Dict[str, Dict[str, Any]] = {}
    for row in (db_bucket_records or []):
        inst = row.get("instance")
        if not inst or (inst_set and inst not in inst_set):
            continue
        b_start = float(row.get("bucket_start") or 0.0)
        b_end = float(row.get("bucket_end") or 0.0)
        if b_end <= req_start or b_start >= req_end:
            continue
        down_s = float(row.get("downtime_seconds") or 0.0)
        if down_s <= 0:
            continue
        raw_outage = row.get("outage_json")
        outage = None
        if raw_outage:
            try:
                outage = raw_outage if isinstance(raw_outage, dict) else json.loads(raw_outage)
            except (TypeError, ValueError):
                outage = None

        h_entry = by_host.setdefault(inst, {
            "instance": inst,
            "name": inst,
            "job": row.get("job") or "blackbox",
            "raw_intervals": [],
        })
        if outage and outage.get("i"):
            raw_ints = outage.get("i")
            last_idx = len(raw_ints) - 1
            for idx, interval in enumerate(raw_ints):
                try:
                    s, e = float(interval[0]), float(interval[1])
                except (TypeError, ValueError, IndexError):
                    continue
                if e <= req_start or s >= req_end:
                    continue
                h_entry["raw_intervals"].append((
                    s, e,
                    bool(outage.get("ongoing_start")) and idx == 0,
                    bool(outage.get("ongoing_end")) and idx == last_idx,
                ))
        else:
            s = max(req_start, b_start)
            e = min(req_end, s + min(down_s, b_end - s))
            h_entry["raw_intervals"].append((
                s, e,
                b_start < req_start,
                down_s >= (b_end - b_start) and b_end >= req_end,
            ))

    # Also fold in live active incidents for this source so current outages are never missing
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
            started = float(inc.get("time") or inc.get("started_at") or 0.0)
            if started and started <= req_end:
                h_entry = by_host.setdefault(inst, {
                    "instance": inst,
                    "name": inst,
                    "job": inc.get("job") or "blackbox",
                    "raw_intervals": [],
                })
                h_entry["raw_intervals"].append((started, req_end, started < req_start, True))
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
                    merged[-1][1] = max(merged[-1][1], e)
                    merged[-1][3] = open_end
                else:
                    merged.append([s, e, open_start, open_end])
        if not merged:
            continue
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


def _query_prometheus_trend(job, instances, start, end, slot, timeout, source=None):
    """Per-host samples from the real TSDB for [start, end] at `slot`
    resolution: {ts: {instance: (uptime_s, coverage_s)}}.

    sum_over_time / count_over_time by instance, converted to seconds with
    each host's scrape cadence, so the caller pools them exactly like
    materialized buckets (Σ uptime / Σ coverage over the same host list).
    A bare `sum(sum_over_time)/sum(count_over_time)` would weight hosts by
    sample count — a 2s-scraped host would outweigh a 15s one 7.5x.
    Never raises; an unreachable Prometheus yields {} (no data).
    """
    if not source:
        return {}

    def _fetch(expr):
        path = f"/api/v1/query_range?query={quote(expr)}&start={start}&end={end}&step={slot}"
        try:
            raw, _ = promclient.fetch_prometheus_json(path, use_cache=True, cache_ttl=45.0, timeout=timeout, source=source)
        except Exception:
            logger.warning("fleet trend query_range failed for expr: %s", expr[:60], exc_info=True)
            return {}
        if not raw or raw.get("status") != "success":
            return {}
        out = {}
        for r in raw.get("data", {}).get("result", []):
            inst = (r.get("metric") or {}).get("instance")
            for pair in r.get("values", []):
                try:
                    v = float(pair[1])
                    if v == v:  # NaN -> no samples in this slot
                        out.setdefault(int(float(pair[0])), {})[inst] = v
                except (ValueError, TypeError, IndexError):
                    continue
        return out

    # Per host: probe_success when it has one, else `up` — the same precedence
    # derive_bucket_inputs gives the Calendar and the aggregator. (Picking the
    # metric by job-name prefix, and weighting hosts by sample count x a
    # guessed cadence, put the Prometheus-filled Trend ~0.3pp off the TSDB.)
    # ponytail: a host observed for only part of a slot still weighs a full
    # slot here; SQLite-backed slots carry exact coverage.
    # No `avg by (instance)`: an instance with several series (e.g. `up` from
    # four gitlab jobs) resolves to the same series the Calendar and the
    # aggregator use (_fetch keeps the last one per instance), not a blend.
    sel = "{instance=~`" + "|".join(re.escape(i) for i in instances) + "`}"
    ratio_by_ts = {}
    for metric in ("up", "probe_success"):  # probe_success last so it wins
        for ts, per_inst in _fetch(f"avg_over_time({metric}{sel}[{slot}s])").items():
            ratio_by_ts.setdefault(ts, {}).update(per_inst)
    return {ts: {i: (float(slot) * r, float(slot)) for i, r in per.items()} for ts, per in ratio_by_ts.items()}


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


def _query_prometheus_daily_matrix(job, start, end, step=86400, timeout=20.0, source=None):
    """Batch-query ONE Prometheus server (`source`) across all full missing days."""
    if promclient is None or not source:
        return {}

    job_filter = ""
    if job and job != "all":
        if job.lower() == "blackbox":
            job_filter = '{job=~"blackbox.*"}'
        elif job.lower() == "node":
            job_filter = '{job=~"node.*"}'
        else:
            job_escaped = job.replace('"', '\\"')
            job_filter = f'{{job="{job_escaped}"}}'

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

    raw_results = {}
    executor = getattr(promclient, "_SHARED_EXECUTOR", None)
    if executor:
        futures = {k: executor.submit(_fetch, q) for k, q in range_queries.items()}
        for k, f in futures.items():
            try:
                raw_results[k] = f.result()
            except Exception:
                raw_results[k] = []
    else:
        for k, q in range_queries.items():
            raw_results[k] = _fetch(q)

    prom_data = {k: {} for k in range_queries}
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
                        prom_data[metric_name].setdefault(d_str, {})[inst] = val
                except (ValueError, TypeError, IndexError):
                    continue

    return prom_data


def _query_prometheus_partial_day(job, at_ts, duration_sec, timeout=15.0, source=None):
    """Query ONE Prometheus server (`source`) for an in-progress partial day."""
    if promclient is None or duration_sec <= 0 or not source:
        return {}
    dur_sec = max(60, int(duration_sec))
    job_filter = ""
    if job and job != "all":
        if job.lower() == "blackbox":
            job_filter = '{job=~"blackbox.*"}'
        elif job.lower() == "node":
            job_filter = '{job=~"node.*"}'
        else:
            job_escaped = job.replace('"', '\\"')
            job_filter = f'{{job="{job_escaped}"}}'

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

    raw_results = {}
    executor = getattr(promclient, "_SHARED_EXECUTOR", None)
    if executor:
        futures = {k: executor.submit(_fetch, q) for k, q in queries.items()}
        for k, f in futures.items():
            try:
                raw_results[k] = f.result()
            except Exception:
                raw_results[k] = []
    else:
        for k, q in queries.items():
            raw_results[k] = _fetch(q)

    partial_data = {k: {} for k in queries}
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
                    partial_data[metric_name][inst] = val
            except (ValueError, TypeError, IndexError):
                continue
    return partial_data


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

    Authoritative telemetry comes from Prometheus through the canonical
    availability processing pipeline (derive_bucket_inputs,
    merge_hybrid_target_availability, summarize_entries).
    Historical hours already materialized in SQLite `db_bucket_records`
    are reused as a performance cache. Any days missing from SQLite
    are reconstructed from Prometheus, guaranteeing complete calendar
    coverage even with a cold/empty SQLite database.
    """
    if req_end <= req_start:
        return []
    if not db_bucket_records and not instances:
        return []

    days = {}
    if db_bucket_records:
        for row in db_bucket_records:
            b_start = float(row.get("bucket_start") or 0.0)
            b_end = float(row.get("bucket_end") or 0.0)
            if b_end <= req_start or b_start >= req_end:
                continue

            date_str = datetime.fromtimestamp(b_start + WIB_OFFSET_SEC, tz=timezone.utc).strftime("%Y-%m-%d")
            day = days.setdefault(date_str, {
                "uptime_sec": 0.0, "coverage_sec": 0.0,
                "hosts_down": set(), "host_events": {}, "outage_missing": False,
                "host_hours": set(),
            })
            day["host_hours"].add((row.get("instance"), b_start))
            day["coverage_sec"] += float(row.get("coverage_seconds") or 0.0)
            day["uptime_sec"] += float(row.get("uptime_seconds") or 0.0)

            if float(row.get("downtime_seconds") or 0.0) <= 0:
                continue

            instance = row.get("instance")
            raw_outage = row.get("outage_json")
            outage = None
            if raw_outage:
                try:
                    outage = raw_outage if isinstance(raw_outage, dict) else json.loads(raw_outage)
                except (TypeError, ValueError):
                    outage = None

            if outage is None:
                day["outage_missing"] = True
                day["hosts_down"].add(instance)
                continue

            day["hosts_down"].add(instance)

            h_entry = day["host_events"].setdefault(instance, {
                "instance": instance,
                "name": instance,
                "job": row.get("job") or "blackbox",
                "raw_intervals": [],
                "total_downtime_sec": 0.0,
            })
            raw_ints = outage.get("i") or []
            last_idx = len(raw_ints) - 1
            for idx, interval in enumerate(raw_ints):
                try:
                    s, e = float(interval[0]), float(interval[1])
                except (TypeError, ValueError, IndexError):
                    continue
                dur = max(0.0, e - s)
                h_entry["raw_intervals"].append((
                    s, e,
                    bool(outage.get("ongoing_start")) and idx == 0,
                    bool(outage.get("ongoing_end")) and idx == last_idx,
                ))
                h_entry["total_downtime_sec"] += dur

    out_by_date = {}
    for date_str in sorted(days.keys()):
        d = days[date_str]
        avail_pct = (
            round((d["uptime_sec"] / d["coverage_sec"]) * 100.0, 2)
            if d["coverage_sec"] > 0 else None
        )

        host_entries = []
        for instance, h in d["host_events"].items():
            raw = sorted(h["raw_intervals"], key=lambda x: x[0])
            merged = []
            for s, e, open_start, open_end in raw:
                if not merged:
                    merged.append([s, e, open_start, open_end])
                else:
                    if s <= merged[-1][1] + 1.0:
                        merged[-1][1] = max(merged[-1][1], e)
                        merged[-1][3] = open_end
                    else:
                        merged.append([s, e, open_start, open_end])

            earliest_start = merged[0][0] if merged else 0.0
            latest_end = merged[-1][1] if merged else 0.0
            total_dur = round(h["total_downtime_sec"], 1)

            host_entries.append({
                "instance": instance,
                "name": instance,
                "job": h["job"],
                "start_ts": int(earliest_start),
                "end_ts": int(latest_end),
                "duration_sec": total_dur,
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
        d_start = datetime.strptime(d_str, "%Y-%m-%d").replace(tzinfo=timezone.utc).timestamp() - WIB_OFFSET_SEC
        hours = math.floor((min(req_end, d_start + 86400.0) - max(req_start, d_start)) / 3600.0)
        return len(days[d_str]["host_hours"]) < 0.95 * len(instances) * hours

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
        dt_d = datetime.strptime(d_str, "%Y-%m-%d").replace(tzinfo=timezone.utc)
        d_start = dt_d.timestamp() - WIB_OFFSET_SEC
        d_end = d_start + 86400.0
        s_start = max(req_start, d_start)
        s_end = min(req_end, d_end)
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
        dt_first = datetime.strptime(full_missing[0], "%Y-%m-%d").replace(tzinfo=timezone.utc)
        range_start = dt_first.timestamp() - WIB_OFFSET_SEC + 86400.0
        dt_last = datetime.strptime(full_missing[-1], "%Y-%m-%d").replace(tzinfo=timezone.utc)
        range_end = dt_last.timestamp() - WIB_OFFSET_SEC + 86400.0

        cache_key = (source or "", job or "", tuple(sorted(instances)), range_start, range_end)
        hit = _DAILY_PROMETHEUS_CACHE.get(cache_key)
        matrix_data = hit[1] if hit and (time.time() - hit[0]) < _DAILY_PROMETHEUS_CACHE_TTL else None
        if matrix_data is None:
            matrix_data = _query_prometheus_daily_matrix(job, range_start, range_end, step=86400, source=source)
            _DAILY_PROMETHEUS_CACHE[cache_key] = (time.time(), matrix_data)

        for m_name, d_map in matrix_data.items():
            for d_str, inst_map in d_map.items():
                prom_data.setdefault(m_name, {}).setdefault(d_str, {}).update(inst_map)

    # 2. Query partial missing days (if any, typically today in progress)
    for d_str, s_start, s_end in partial_missing:
        dur_sec = max(60, int(s_end - s_start))
        p_data = _query_prometheus_partial_day(job, s_end, dur_sec, source=source)
        for m_name, inst_map in p_data.items():
            prom_data.setdefault(m_name, {}).setdefault(d_str, {}).update(inst_map)

    # 3. Canonical availability processing for each missing day
    for d_str in missing_dates:
        dt_d = datetime.strptime(d_str, "%Y-%m-%d").replace(tzinfo=timezone.utc)
        d_start = dt_d.timestamp() - WIB_OFFSET_SEC
        d_end = d_start + 86400.0
        day_slice_start = max(req_start, d_start)
        day_slice_end = min(req_end, d_end)
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

            inst_maint = (maint_by_inst or {}).get(inst)
            target_job = (instance_job_map or {}).get(inst) or job or "blackbox"

            inst_prom = {
                "avail": merged_maps.get("avail", {}).get(inst),
                "count": merged_maps.get("count", {}).get(inst),
                "incidents": merged_maps.get("incidents", {}).get(inst),
                "duration": day_dur.get(inst),
            }

            entry = merge_hybrid_target_availability(
                req_start=day_slice_start,
                req_end=day_slice_end,
                target_id=inst,
                target_name=inst,
                job=target_job,
                sqlite_buckets=[],
                prom_metrics=inst_prom,
                expected_interval_sec=inst_interval,
                maintenance_windows=inst_maint,
            )
            day_entries.append(entry)

        day_summary = summarize_entries(day_entries, period_minutes=period_minutes)
        avail_pct = day_summary.get("fleet_aggregate", {}).get("value")
        down_count = len([e for e in day_entries if (e.get("downtime_seconds") or 0.0) > 0])

        prev = out_by_date.get(d_str) or {}
        # If Prometheus returned no data (e.g. beyond retention limit), DO NOT overwrite valid SQLite data!
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
            )
            continue
        out_by_date[d_str] = {
            "date": d_str,
            "availability_pct": avail_pct if avail_pct is not None else prev.get("availability_pct"),
            "hosts_down": down_count if avail_pct is not None else (prev.get("hosts_down") or 0),
            "events": prev.get("events"),
            "events_unavailable": True if not prev.get("events") else "partial",
        }

    return [out_by_date[d] for d in all_dates if d in out_by_date]
