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
import json
import math
import re
import time
import logging
from datetime import datetime, timezone
from urllib.parse import quote

try:
    from .fleet import sla_budget
    from core.monitoring import client as promclient
except (ImportError, ValueError):
    from alarm.core.availability.fleet import sla_budget
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


def _build_fleet_trend(trend_end_ts, window_seconds, instances, max_points=180, db_bucket_records=None):
    """Fleet availability time series for the modal's Availability Trend chart.

    Prefers materialized hourly bucket records (from SQLite fast-path) which
    accurately reflect every instance's time-weighted uptime and coverage.
    Falls back to Prometheus TSDB query_range if bucket records are unavailable.
    """
    end = int(trend_end_ts)
    win = max(3600.0, float(window_seconds or 0.0))
    slot = 3600
    if win / slot > max_points:
        slot = int(math.ceil(win / max_points / 3600.0) * 3600.0)
    # First eval point is one slot in, so every point summarizes a slot that
    # sits fully inside [end - win, end] rather than reaching back before it.
    start = end - int(win) + slot

    if not instances:
        return [], slot

    # 1. Prefer materialized hourly buckets if provided (Fast Path & 100% consistent with fleet_aggregate)
    if db_bucket_records:
        slot_map = {}
        for r in db_bucket_records:
            b_start = float(r.get("bucket_start", 0))
            cov = float(r.get("coverage_seconds", 0) or 0)
            upt = float(r.get("uptime_seconds", 0) or 0)
            if cov <= 0:
                continue
            if b_start < (end - win - 60.0) or b_start >= end:
                continue
            slot_key = int(math.floor(b_start / slot) * slot)
            if slot_key not in slot_map:
                slot_map[slot_key] = {"uptime": 0.0, "coverage": 0.0}
            slot_map[slot_key]["uptime"] += upt
            slot_map[slot_key]["coverage"] += cov

        if slot_map:
            series = []
            for slot_key in sorted(slot_map.keys()):
                d = slot_map[slot_key]
                if d["coverage"] > 0:
                    pct = round(max(0.0, min(100.0, (d["uptime"] / d["coverage"]) * 100.0)), 2)
                    series.append({
                        "ts": slot_key + slot,
                        "availability_pct": pct,
                    })
            if len(series) >= 2:
                return series, slot

    # 2. Prometheus TSDB fallback (query_range)
    trend_timeout = max(6.0, min(25.0, win / 120000.0))

    # 60s cache
    ck = (tuple(sorted(instances)), int(win), slot, max_points)
    hit = _FLEET_TREND_CACHE.get(ck)
    if hit and (time.time() - hit[0]) < _FLEET_TREND_CACHE_TTL:
        return hit[1]

    # Classify instances to properly query mixed fleets (probe_success vs up)
    try:
        try:
            from core.monitoring.state import get_instance_job_map
        except (ImportError, ValueError):
            from alarm.core.monitoring.state import get_instance_job_map
        job_map = get_instance_job_map(None) or {}
    except Exception:
        job_map = {}

    probe_instances = [i for i in instances if job_map.get(i, "").startswith("blackbox")]
    up_instances = [i for i in instances if not job_map.get(i, "").startswith("blackbox")]

    queries_to_try = []
    if probe_instances and up_instances:
        # Mixed fleet (All Jobs): combine probe_success and up with instance-weighted averages
        p_re = "|".join(re.escape(i) for i in probe_instances)
        u_re = "|".join(re.escape(i) for i in up_instances)
        expr = (
            f"(sum(avg_over_time(probe_success{{instance=~`{p_re}`}}[{slot}s])) + sum(avg_over_time(up{{instance=~`{u_re}`}}[{slot}s]))) "
            f"/ (count(avg_over_time(probe_success{{instance=~`{p_re}`}}[{slot}s])) + count(avg_over_time(up{{instance=~`{u_re}`}}[{slot}s])))"
        )
        queries_to_try.append(expr)
    elif probe_instances:
        p_re = "|".join(re.escape(i) for i in probe_instances)
        queries_to_try.append(f"avg(avg_over_time(probe_success{{instance=~`{p_re}`}}[{slot}s]))")
    elif up_instances:
        u_re = "|".join(re.escape(i) for i in up_instances)
        queries_to_try.append(f"avg(avg_over_time(up{{instance=~`{u_re}`}}[{slot}s]))")

    # Standard PromQL fallback if above queries fail
    inst_re = "|".join(re.escape(i) for i in instances)
    sel = f'{{instance=~`{inst_re}`}}'
    for metric in ("probe_success", "up"):
        queries_to_try.append(
            f"sum(sum_over_time({metric}{sel}[{slot}s])) / sum(count_over_time({metric}{sel}[{slot}s]))"
        )

    for expr in queries_to_try:
        path = (
            f"/api/v1/query_range?query={quote(expr)}"
            f"&start={start}&end={end}&step={slot}"
        )
        try:
            raw, _ = promclient.fetch_prometheus_json(path, use_cache=True, cache_ttl=45.0, timeout=trend_timeout)
        except Exception:
            logger.warning("fleet trend query_range failed for expr: %s", expr[:60], exc_info=True)
            raw = None
        if not raw or raw.get("status") != "success":
            continue
        result = raw.get("data", {}).get("result", [])
        if not result:
            continue
        series = []
        for pair in result[0].get("values", []):
            try:
                ts = int(float(pair[0]))
                frac = float(pair[1])
            except (ValueError, TypeError, IndexError):
                continue
            if frac != frac:  # NaN -> no samples in this slot, leave a gap
                continue
            series.append({
                "ts": ts,
                "availability_pct": round(max(0.0, min(100.0, frac * 100.0)), 2),
            })
        if series:
            _FLEET_TREND_CACHE[ck] = (time.time(), (series, slot))
            return series, slot

    _FLEET_TREND_CACHE[ck] = (time.time(), ([], slot))
    return [], slot


# Cap on how many downtime events a single day returns — a bad week on a big
# fleet could otherwise put hundreds of intervals in one payload. Sorted by
# duration first so truncation drops the least-interesting ones.
_DAILY_MAX_EVENTS = 100


def _build_daily_downtime(db_bucket_records, req_start, req_end):
    """Per-calendar-day downtime rollup for the modal's Downtime Calendar
    section, built entirely from the hourly SQLite bucket rows engine.py
    already fetched into `db_bucket_records` (bucket_repo.get_bucket_records)
    for this same request — no second query, no new table.

    Days are WIB (Asia/Jakarta, UTC+7, no DST) calendar days: `date_str` is
    computed by shifting each bucket's timestamp +7h before taking the UTC
    date. This deployment's operators are all in Indonesia, so "today"/
    "yesterday" on the calendar grid — and every hour label the frontend
    derives from `date_str` (Downtime Calendar cells, Outage Rail, the Trend
    chart's hover) — needs to mean the WIB day, not the UTC one; grouping by
    UTC day here while displaying WIB elsewhere would silently shift up to 7
    hours of one day's outages onto the wrong calendar cell. 7 hours is a
    whole number of hours and bucket_start/bucket_end are always hour-
    aligned, so this shift never splits an hourly bucket across the new WIB
    day boundary — it only changes which date_str that whole bucket rolls
    up under (WIB midnight is exactly 17:00 UTC, itself an hour boundary).

    Returns [{date, availability_pct, hosts_down, events, ...}], oldest
    first. `events` is grouped per host: `[{instance, name, job, start_ts, end_ts, duration_sec, incident_count, intervals}]`,
    capped at `_DAILY_MAX_EVENTS` (worst-duration-first; a `truncated_count`
    field is added when any were dropped). Contiguous intervals across hourly
    bucket boundaries are merged so the same host never repeats redundantly.

    A hydrated bucket row's `outage_json.i` holds exact [start, end] outage
    intervals — but `aggregate_hourly_buckets`' scalar-fallback path (no raw
    0/1 samples available for that hour) writes a row with no `outage_json`
    at all, even though `downtime_seconds` on it can be > 0. Rather than
    render that as "zero downtime", a day resting entirely on such rows comes
    back with `events: None, events_unavailable: True`; a day that mixes
    exact and approximate rows keeps its known events and marks
    `events_unavailable: "partial"`. `hosts_down` is always the true count
    either way — it only needs to know downtime_seconds > 0, not the exact
    interval.
    """
    if not db_bucket_records or req_end <= req_start:
        return []

    days = {}
    for row in db_bucket_records:
        b_start = float(row.get("bucket_start") or 0.0)
        b_end = float(row.get("bucket_end") or 0.0)
        if b_end <= req_start or b_start >= req_end:
            continue

        date_str = datetime.fromtimestamp(b_start + WIB_OFFSET_SEC, tz=timezone.utc).strftime("%Y-%m-%d")
        day = days.setdefault(date_str, {
            "uptime_sec": 0.0, "coverage_sec": 0.0,
            "hosts_down": set(), "host_events": {}, "outage_missing": False,
        })
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
        # ongoing_start / ongoing_end are per-bucket: the hour opened already
        # down, and the hour closed still down. They only describe the first
        # and last interval in that bucket respectively. Carried through the
        # merge below, they tell a consumer whether an interval's edge is a
        # real state change or just where the bucket (and so the data) stops —
        # which is not something the timestamps alone can say, since the last
        # bucket of the newest day ends at the last scrape, not on the hour.
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

    out = []
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
                    # Only genuinely contiguous intervals merge. An outage that
                    # spans an hour boundary is stored clipped to it (…–10:00:00
                    # and 10:00:00–…), so touching ends are what the merge is for.
                    # The old +60s slack also swallowed a real recovery: on a
                    # 60s-scrape job a host that comes back for exactly one probe
                    # and drops again was reported as one continuous incident,
                    # over a window it was demonstrably up for (verified against
                    # Prometheus: 192.168.9.100, 2026-09-11 09:26–09:31).
                    if s <= merged[-1][1] + 1.0:  # 1s for float/rounding jitter only
                        merged[-1][1] = max(merged[-1][1], e)
                        merged[-1][3] = open_end  # the joined piece owns the tail
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
                        # start_ts is not a drop and end_ts is not a recovery
                        # when these are set — the host was already down, or
                        # still down where the data stops.
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
        out.append(entry)
    return out
