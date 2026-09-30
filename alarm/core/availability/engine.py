from __future__ import annotations
"""AvailabilityEngine: the deep domain module for fleet availability,
hybrid TSDB/SQLite reconciliation, SLA error budgets, and bucket aggregation.
"""
import bisect
import logging
import math
import os
import re
import threading
import time
from typing import Optional, Dict, Any, List, Tuple

from .models import AvailabilityQuery, AvailabilityReport
from ._cache import AvailabilityCache
from .fleet import (
    merge_hybrid_fleet_availability,
    merge_hybrid_target_availability,
    reconstruct_time_series_intervals,
    clip_hourly_bucket,
    derive_bucket_inputs,
    estimate_instance_cadence,
    sla_budget,
    get_sla_target_pct,
    summarize_entries,
)
from .helpers import (
    _attach_sla_budgets,
    _availability_status_counts,
    _build_fleet_trend,
    _build_fleet_incidents,
    _build_daily_downtime,
    clear_helpers_caches,
)

try:
    from config import (
        DEFAULT_JOB_FILTER,
        SCRAPE_INTERVAL_SECONDS,
        _AVAIL_FRESHNESS_TOLERANCE_SEC,
        _AVAIL_STALE_BUCKET_TOLERANCE_SEC,
        AVAIL_TREND_MIN_REPORTING_RATIO,
        AVAIL_TARGET_WHITELIST,
    )
    from storage import (
        AvailabilityBucketRepository,
        SlaTargetRepository,
    )
    from storage.repositories.availability import norm_source
    from core.monitoring import (
        client as default_prom_client,
        queries as default_prom_queries,
    )
    from core.monitoring.state import (
        get_monitored_instances,
        get_instance_job_map,
        get_instance_cadence_map,
    )
    from core.monitoring.primitives import _parse_epoch_ts
    from core.monitoring.queries import with_job
    from core.alerts.engine import (
        load_maintenance_windows,
        maintenance_windows_by_instance,
    )
except (ImportError, ValueError):
    from alarm.config import (
        DEFAULT_JOB_FILTER,
        SCRAPE_INTERVAL_SECONDS,
        _AVAIL_FRESHNESS_TOLERANCE_SEC,
        _AVAIL_STALE_BUCKET_TOLERANCE_SEC,
        AVAIL_TREND_MIN_REPORTING_RATIO,
        AVAIL_TARGET_WHITELIST,
    )
    from alarm.storage import (
        AvailabilityBucketRepository,
        SlaTargetRepository,
    )
    from alarm.storage.repositories.availability import norm_source
    from alarm.core.monitoring import (
        client as default_prom_client,
        queries as default_prom_queries,
    )
    from alarm.core.monitoring.state import (
        get_monitored_instances,
        get_instance_job_map,
        get_instance_cadence_map,
    )
    from alarm.core.monitoring.primitives import _parse_epoch_ts
    from alarm.core.monitoring.queries import with_job
    from alarm.core.alerts.engine import (
        load_maintenance_windows,
        maintenance_windows_by_instance,
    )

logger = logging.getLogger("infrawatch.availability")

# How deep materialized history reaches: each server's own Prometheus
# retention, so SQLite holds everything that server can still reconstruct
# (history older than that can't be rebuilt; sweeping it only writes empty
# placeholder rows). This value is only the fallback for a server whose
# retention is unknown (unreachable, or size-based retention).
AVAIL_BACKFILL_SECONDS = float(
    os.environ.get("AVAIL_BACKFILL_SECONDS", os.environ.get("AVAIL_BUCKET_RETENTION_SECONDS", str(35 * 86400)))
)
# Hard ceiling: no /api/availability window reaches past 366 days, so deeper
# rows could never be read.
AVAIL_BACKFILL_MAX_SECONDS = 366 * 86400.0
# Depth is filled by walking backwards one chunk per aggregation cycle. The
# exact path fetches RAW samples for the whole chunk (`probe_success[Ns]`, every
# series): at a 2s scrape a 6h chunk was ~10.8k samples/series — tens of MB that
# routinely timed out, silently leaving hours without outage intervals. 1h keeps
# each fetch small; 35d still completes in ~14h of 60s ticks.
# Raw sample fetches reach this far before the window, so the first hour sees
# the previous sample (its carried-in state). Prometheus' own lookback: 15s
# missed it for 1m-scraped targets, marking every hour of one long outage as a
# new drop.
RAW_LEAD_IN_SECONDS = 300.0
AVAIL_BACKFILL_CHUNK_SECONDS = float(os.environ.get("AVAIL_BACKFILL_CHUNK", str(12 * 3600)))
# Longest span of one host's raw samples fetched in one request: only flapping
# hosts are fetched raw, ~1800 samples/hour each at a 2s scrape.
AVAIL_BACKFILL_RAW_SPAN_SECONDS = float(os.environ.get("AVAIL_BACKFILL_RAW_SPAN", str(6 * 3600)))
# Concurrent raw fetches per chunk (of the 16-worker pool shared with the API).
AVAIL_BACKFILL_RAW_CONCURRENCY = int(os.environ.get("AVAIL_BACKFILL_RAW_CONCURRENCY", "4"))
# Flapping hosts sharing the same hours fetched per raw request.
AVAIL_BACKFILL_RAW_BATCH = int(os.environ.get("AVAIL_BACKFILL_RAW_BATCH", "8"))
# A completed sweep that left instances under-materialized is not re-run for
# this long (Prometheus may simply have nothing there) — but it IS re-run after,
# so a sweep that failed transiently is never abandoned for good.
AVAIL_BACKFILL_RETRY_SECONDS = float(os.environ.get("AVAIL_BACKFILL_RETRY", str(6 * 3600)))
# A depth chunk whose raw-sample fetch fails is retried on the next cycles; after
# this many consecutive failures it is persisted from the scalar fallback (and
# stays a "hole" for the next sweep to retry) so one bad hour can't pin the walk.
AVAIL_BACKFILL_MAX_CHUNK_FAILURES = int(os.environ.get("AVAIL_BACKFILL_MAX_CHUNK_FAILURES", "3"))
# Wall-clock budget per aggregation cycle for depth chunks (after the first,
# which always runs). Keep under AVAIL_AGGREGATE_INTERVAL so ticks don't pile up.
AVAIL_BACKFILL_CYCLE_BUDGET_SECONDS = float(os.environ.get("AVAIL_BACKFILL_CYCLE_BUDGET", "40"))
# At most this often, backfilled history evicts cached reports (and once more
# when the sweep reaches the floor).
AVAIL_BACKFILL_INVALIDATE_SECONDS = float(os.environ.get("AVAIL_BACKFILL_INVALIDATE", "60"))


def _promql_str(text: str) -> str:
    """`text` escaped for a double-quoted PromQL string literal."""
    return text.replace("\\", "\\\\").replace('"', '\\"')


def _raw_hour_record(inst, job, samples, sample_ts, cur_h, curr_time, cad, latency):
    """One hour's bucket row reconstructed from raw 0/1 samples (the exact path)."""
    nxt_h = cur_h + 3600.0
    # Carried in = the host was already down AT cur_h, i.e. the last sample
    # BEFORE the hour (the fetch keeps a lead-in) is 0. hour_pts[0] == 0 alone
    # also flagged an outage that began at the hour's first scrape.
    lead_idx = bisect.bisect_left(sample_ts, cur_h) - 1
    carried_in = lead_idx >= 0 and samples[lead_idx][1] == 0
    eff_end = min(nxt_h, curr_time)
    rec = reconstruct_time_series_intervals(
        samples, window_start_ts=cur_h, window_end_ts=eff_end, expected_interval_sec=cad,
    )
    lo = bisect.bisect_left(sample_ts, cur_h)
    hi = bisect.bisect_left(sample_ts, eff_end)
    return {
        "instance": inst,
        "job": job,
        "bucket_start": cur_h,
        "bucket_end": nxt_h,
        "uptime_seconds": round(rec["uptime_seconds"], 2),
        "downtime_seconds": round(rec["downtime_seconds"], 2),
        "unknown_seconds": round(rec["unknown_seconds"], 2),
        "coverage_seconds": round(rec["coverage_seconds"], 2),
        "sample_count": hi - lo,
        "availability_pct": rec["availability_pct"],
        "incident_count": int(rec["incident_count"]),
        "avg_latency_ms": latency,
        "updated_at": curr_time,
        "outage_json": {
            "d": [round(float(x), 1) for x in rec.get("outage_durations_sec", [])],
            "i": [[round(float(s), 1), round(float(e), 1)]
                  for s, e in rec.get("outage_intervals_sec", [])],
            "ongoing_start": bool(carried_in),
            "ongoing_end": bool(rec.get("is_ongoing_outage")),
        },
    }


def _stable_hour_record(inst, job, cur_h, value, count, lead_down, latency, curr_time):
    """The row _raw_hour_record would build for an hour whose samples are all
    `value` with no gap over the reconstruction tolerance — without fetching
    them. Full UP: no outage. Full DOWN: one outage spanning the hour, open at
    its end (the next hour decides whether it continued)."""
    down = value == 0
    return {
        "instance": inst,
        "job": job,
        "bucket_start": cur_h,
        "bucket_end": cur_h + 3600.0,
        "uptime_seconds": 0.0 if down else 3600.0,
        "downtime_seconds": 3600.0 if down else 0.0,
        "unknown_seconds": 0.0,
        "coverage_seconds": 3600.0,
        "sample_count": int(count),
        "availability_pct": 0.0 if down else 100.0,
        "incident_count": 1 if down else 0,
        "avg_latency_ms": latency,
        "updated_at": curr_time,
        "outage_json": {
            "d": [3600.0] if down else [],
            "i": [[round(cur_h, 1), round(cur_h + 3600.0, 1)]] if down else [],
            "ongoing_start": bool(lead_down),
            "ongoing_end": down,
        },
    }


def _parse_prom_duration(text: Optional[str]) -> Optional[float]:
    """'15d', '1y2w', '720h30m' -> seconds. None/0/unparseable -> None."""
    import re
    units = {"ms": 0.001, "s": 1, "m": 60, "h": 3600, "d": 86400, "w": 604800, "y": 31536000}
    parts = re.findall(r"(\d+)(ms|[smhdwy])", (text or "").strip())
    total = sum(int(n) * units[u] for n, u in parts)
    return float(total) if total > 0 else None
# Forward repair (aggregator was down, process restarted) is capped so a long
# outage can't emit hundreds of windows in one cycle — the backward walk above
# picks up anything older.
AVAIL_HEAD_REPAIR_SECONDS = float(os.environ.get("AVAIL_HEAD_REPAIR", str(6 * 3600)))


class AvailabilityEngine:
    """Deep module consolidating availability calculation, in-flight caching,
    hybrid Prometheus/SQLite fusion, and hourly bucket aggregation.
    """

    def __init__(
        self,
        prom_client=None,
        prom_queries=None,
        bucket_repo=None,
        sla_repo=None,
        cache: Optional[AvailabilityCache] = None,
    ):
        self.prom_client = prom_client or default_prom_client
        self.prom_queries = prom_queries or default_prom_queries
        self.bucket_repo = bucket_repo or AvailabilityBucketRepository
        self.sla_repo = sla_repo or SlaTargetRepository
        self.cache = cache or AvailabilityCache()
        # Backward-walk cursor for depth backfill: next chunk end to materialize,
        # plus the under-materialized set left over by the last completed sweep
        # (instances Prometheus simply has no history for — re-sweeping those
        # forever would never terminate).
        self._deep_cursor: Optional[float] = None
        self._deep_swept_stale: frozenset = frozenset()
        self._deep_swept_at: float = 0.0
        # Stale set of the sweep in flight; committed to _deep_swept_stale only
        # when the sweep actually reaches the floor.
        self._deep_sweep_pending: Optional[frozenset] = None
        self._deep_chunk_failures: Dict[Tuple[float, float], int] = {}
        # Effective depth (seconds) for the current source — see _backfill_depth.
        self._backfill_depth_sec: Optional[float] = None
        # Last time freshly backfilled history evicted the report cache, and
        # the span written since then (evicted only for reports overlapping it).
        self._depth_invalidated_at: float = 0.0
        self._dirty_range: Optional[Tuple[float, float]] = None
        self._backfill_status_cache: Dict[Tuple[str, Tuple[str, ...]], Tuple[float, Dict[str, Any]]] = {}
        self._retention_cache: Dict[str, Tuple[float, Optional[float]]] = {}
        # Stale-while-revalidate state for live long windows (get_availability).
        self._refresh_guard = threading.Lock()
        self._refreshing: set = set()
        self._last_live: Dict[str, Tuple[float, int, Dict[str, Any]]] = {}

    def _prom_retention_seconds(self, source: str) -> Optional[float]:
        """Effective retention of server `source` (cached 1h), or None when
        unknown/size-only. A failed read keeps the last value that did succeed
        — a network blip must not shrink the depth (and the prune that follows
        it) to the 35d fallback — and is retried after 60s. Never raises."""
        now = time.time()
        hit = self._retention_cache.get(source)
        if hit and now - hit[0] < (3600.0 if hit[1] else 60.0):
            return hit[1]
        ret = None
        # runtimeinfo carries the EFFECTIVE retention ("15d", "15d or 10GiB"):
        # a server left on the default has retention.time=0s in /flags, which
        # read as unknown. /flags stays as the fallback for older Prometheus.
        for path, pick in (("/api/v1/status/runtimeinfo", lambda d: d.get("storageRetention")),
                           ("/api/v1/status/flags", lambda d: d.get("storage.tsdb.retention.time"))):
            try:
                raw, _ = self.prom_client.fetch_prometheus_json(
                    path, use_cache=True, cache_ttl=3600.0, timeout=5.0, source=source)
                if raw and raw.get("status") == "success":
                    ret = _parse_prom_duration(pick(raw.get("data") or {}))
            except Exception:
                ret = None
            if ret:
                break
        if ret is None and hit:
            ret = hit[1]
        self._retention_cache[source] = (now, ret)
        return ret

    def _backfill_depth(self, source: str) -> float:
        ret = self._prom_retention_seconds(source)
        return min(ret, AVAIL_BACKFILL_MAX_SECONDS) if ret else AVAIL_BACKFILL_SECONDS

    @property
    def backfill_in_progress(self) -> bool:
        """A depth sweep is walking toward the retention floor."""
        return self._deep_sweep_pending is not None

    def _note_materialized(self, start: float, end: float) -> None:
        lo, hi = self._dirty_range or (start, end)
        self._dirty_range = (min(lo, start), max(hi, end))

    def invalidate_range(self, start: float, end: float) -> int:
        """Evict cached reports whose window overlaps [start, end) — and their
        stale-serve copies, which would otherwise be handed out once more as
        "backfill pending" for history that is now materialized."""
        clear_helpers_caches()
        self._backfill_status_cache.clear()
        with self._refresh_guard:
            for view_id, (ts, minutes, _) in list(self._last_live.items()):
                if ts - minutes * 60.0 < end and ts > start:
                    self._last_live.pop(view_id, None)
        return self.cache.invalidate_range(start, end)

    def invalidate_cache(self, job: Optional[str] = None, instance: Optional[str] = None) -> int:
        """Evict matching cached availability queries and clear module-level trend caches."""
        clear_helpers_caches()
        return self.cache.invalidate(job=job, instance=instance)

    # A live long-window report may be served from the previous cache bucket
    # for this long while its replacement is computed in the background.
    STALE_SERVE_SEC = 1800.0

    def _refresh_in_background(self, query: AvailabilityQuery, cache_key: str) -> None:
        with self._refresh_guard:
            if cache_key in self._refreshing:
                return
            self._refreshing.add(cache_key)

        def run():
            try:
                self.get_availability(query, allow_stale=False)
            except Exception:
                logger.exception("availability background refresh failed for %s", cache_key)
            finally:
                with self._refresh_guard:
                    self._refreshing.discard(cache_key)

        threading.Thread(target=run, name=f"avail-refresh-{len(self._refreshing)}", daemon=True).start()

    def get_availability(self, query: AvailabilityQuery, allow_stale: bool = True) -> AvailabilityReport:
        """_get_availability plus the live backfill status (see backfill_status).
        Attached per response, not cached with the report: a 30d report is
        cached for minutes, the progress of a running backfill is not."""
        report = self._get_availability(query, allow_stale)
        payload = report.payload
        scope = payload.get("scope") or {}
        targets = payload.get("targets")
        if scope.get("source") and isinstance(targets, dict) and targets:
            try:
                status = self.backfill_status(scope["source"], sorted(targets))
            except Exception:
                logger.exception("availability: backfill status failed")
                status = None
            if status is not None:
                return AvailabilityReport(dict(payload, backfill=status))
        return report

    def backfill_status(self, source: str, instances: List[str], now: Optional[float] = None) -> Dict[str, Any]:
        """How much of the retention window is materialized for `instances`.

        state "filling" while any completed hour in [floor, now) lacks a row
        for some instance; "complete" once all do. materialized_from_ts: every
        hour from it up to now is complete — history the Trend can show with
        exact intervals; older is still being filled (newest first). Read from
        SQLite, so it holds on any worker, leader or not. Cached 30s."""
        now = time.time() if now is None else now
        key = (source, tuple(instances))
        hit = self._backfill_status_cache.get(key)
        if hit and now - hit[0] < 30.0:
            return hit[1]
        top = math.floor(now / 3600.0) * 3600.0
        # Same floor as the depth sweep (_next_depth_backfill_window), which
        # also materializes the hour the floor falls in.
        floor_ts = math.floor((top - self._backfill_depth(source)) / 3600.0) * 3600.0
        counts = self.bucket_repo.get_materialized_hour_counts(instances, floor_ts, top, source=source)
        need = len(set(instances))
        total = max(0, int(round((top - floor_ts) / 3600.0)))
        done = sum(1 for h, c in counts.items() if c >= need)
        t = top - 3600.0
        while t >= floor_ts and counts.get(t, 0) >= need:
            t -= 3600.0
        status = {
            "state": "complete" if done >= total else "filling",
            "floor_ts": int(floor_ts),
            "materialized_from_ts": int(t + 3600.0),
            "complete_hours": done,
            "total_hours": total,
            "progress_pct": round(100.0 * done / total, 1) if total else 100.0,
        }
        self._backfill_status_cache[key] = (now, status)
        return status

    def _get_availability(self, query: AvailabilityQuery, allow_stale: bool = True) -> AvailabilityReport:
        """Single deep entry point for querying fleet and per-target availability.

        Live windows of 24h and longer are stale-while-revalidate: when the
        current cache bucket is cold, the previous report for the same view
        (same server/job/SLA, a window within an hour of this one, at most
        STALE_SERVE_SEC old) is returned at once and the new one is computed
        in the background. A cold 30d/MTD report takes over a minute — past
        the browser's patience — and every poll landing on a new bucket used
        to wait for it."""
        t_req_start = time.perf_counter()
        now = time.time()

        # Resolve SLA targets map
        try:
            sla_target_map = self.sla_repo.get_all()
        except Exception:
            sla_target_map = {}
        sla_map_sig = hash(tuple(sorted(sla_target_map.items()))) if sla_target_map else 0

        # Endpoint resolution for cache keying
        try:
            endpoints_data = self.prom_client.load_endpoints()
            active_url = endpoints_data.get("active") or getattr(self.prom_client, "_DEFAULT_PROM_URL", "http://prometheus:9090")
        except Exception:
            active_url = "http://prometheus:9090"
        # Every number in this report comes from this ONE server (no failover,
        # no other server's SQLite rows) and whitelisted targets only.
        source = norm_source(active_url)

        cache_key, effective_ttl = AvailabilityCache.derive_cache_key(
            endpoint=active_url,
            job=query.job,
            minutes_int=query.minutes_int,
            end_ts=query.end_ts,
            sla_target_pct=query.sla_target_pct,
            sla_days=query.sla_days,
            sla_map_sig=sla_map_sig,
            now=now,
        )

        # 1. Check in-flight cache (fast path before lock acquisition)
        cached_payload = self.cache.get(cache_key, effective_ttl, now=now)
        if cached_payload is not None:
            return AvailabilityReport(cached_payload)

        live_long = query.end_ts is None and query.minutes_int >= 1440
        view_id = re.sub(r":\d+:live_\d+:", ":live:", cache_key)
        if live_long and allow_stale:
            with self._refresh_guard:
                prev = self._last_live.get(view_id)
            if prev and now - prev[0] < self.STALE_SERVE_SEC and abs(prev[1] - query.minutes_int) <= 60:
                self._refresh_in_background(query, cache_key)
                return AvailabilityReport(prev[2])

        # 2. Acquire single-flight coalescing lock
        t_lock_wait_start = time.perf_counter()
        with self.cache.flight_lock_for(cache_key):
            t_lock_acquired = time.perf_counter()
            flight_wait_ms = (t_lock_acquired - t_lock_wait_start) * 1000.0

            # Re-check cache under lock in case another worker just completed it
            now_under_lock = time.time()
            cached_payload = self.cache.get(cache_key, effective_ttl, now=now_under_lock)
            if cached_payload is not None:
                return AvailabilityReport(cached_payload)

            # 3. Compute availability
            req_end = float(query.end_ts) if query.end_ts is not None else now
            req_start = req_end - (query.minutes * 60.0)

            try:
                instance_job_map = self._scoped_job_map(query.job, source)
                monitored_instances = sorted(instance_job_map)
            except Exception:
                monitored_instances = []
                instance_job_map = {}
            if not monitored_instances:
                # Server unreachable: still report its OWN materialized history.
                try:
                    monitored_instances = sorted({r["instance"] for r in self.bucket_repo.get_bucket_records(
                        query.job, req_start, req_end, source=source)})
                except Exception:
                    monitored_instances = []

            if not monitored_instances:
                empty_summary = summarize_entries([], query.minutes, sla_threshold=query.sla_target_pct)
                payload = self._build_empty_payload(query, req_end, empty_summary)
                # Still labelled: an unreachable server must read as "server X: no data",
                # not as an unscoped empty view.
                payload["scope"] = {"source": source, "whitelist_enforced": AVAIL_TARGET_WHITELIST is not None and bool(set(monitored_instances) & AVAIL_TARGET_WHITELIST),
                                    "instances": 0}
                self.cache.set(cache_key, payload, now=now_under_lock)
                return AvailabilityReport(payload)

            # Maintenance windows overlapping this query window
            maint_by_inst = self._resolve_maintenance_windows(req_start, req_end, query.job, monitored_instances, source)

            # Retrieve SQLite bucket records in the window [req_start, req_end]
            t_sqlite_start = time.perf_counter()
            try:
                db_bucket_records = self.bucket_repo.get_bucket_records(
                    job=query.job,
                    start_time=req_start,
                    end_time=req_end,
                    instances=monitored_instances,
                    source=source,
                )
            except Exception:
                db_bucket_records = []
            t_sqlite_end = time.perf_counter()
            sqlite_duration_ms = (t_sqlite_end - t_sqlite_start) * 1000.0

            # Check if SQLite completely covers the requested window for all monitored instances
            is_sqlite_fully_complete = self._check_sqlite_coverage(
                db_bucket_records, monitored_instances, req_start, req_end, query.end_ts, now
            )

            if is_sqlite_fully_complete:
                # FAST PATH: Materialized SQLite coverage with 0 Prometheus queries
                payload = self._compute_fast_path_payload(
                    query=query,
                    req_start=req_start,
                    req_end=req_end,
                    monitored_instances=monitored_instances,
                    db_bucket_records=db_bucket_records,
                    maint_by_inst=maint_by_inst,
                    sla_target_map=sla_target_map,
                    flight_wait_ms=flight_wait_ms,
                    sqlite_duration_ms=sqlite_duration_ms,
                    t_req_start=t_req_start,
                    instance_job_map=instance_job_map,
                    source=source,
                )
            else:
                # HYBRID PATH: Merge live Prometheus TSDB samples with SQLite buckets
                payload = self._compute_hybrid_path_payload(
                    query=query,
                    req_start=req_start,
                    req_end=req_end,
                    monitored_instances=monitored_instances,
                    db_bucket_records=db_bucket_records,
                    maint_by_inst=maint_by_inst,
                    sla_target_map=sla_target_map,
                    flight_wait_ms=flight_wait_ms,
                    sqlite_duration_ms=sqlite_duration_ms,
                    t_req_start=t_req_start,
                    instance_job_map=instance_job_map,
                    source=source,
                )

            # A target removed from monitoring keeps its already-materialized
            # SQLite history — fold it back in for any window that overlaps
            # days it was actually being probed, or deleting a chronically-down
            # host would retroactively (and silently) improve the fleet's
            # historical SLA for periods when it was real. No-op (one cheap
            # SQLite query, itself often empty) whenever nothing has ever been
            # removed inside the window.
            payload = self._reincorporate_removed_targets(
                query=query,
                req_start=req_start,
                req_end=req_end,
                monitored_instances=monitored_instances,
                maint_by_inst=maint_by_inst,
                sla_target_map=sla_target_map,
                payload=payload,
                source=source,
            )

            # Hosts folded back into the headline must be in the Trend, its
            # ticks and the Calendar too — otherwise a removed, chronically
            # down host made the headline 50% over an all-green chart.
            removed_rows = payload.pop("_removed_rows", None) or {}
            all_records = list(db_bucket_records)
            if removed_rows:
                maint_by_inst = dict(maint_by_inst or {}, **(payload.pop("_removed_maint", None) or {}))
                for rows in removed_rows.values():
                    all_records.extend(rows)
                spans = {i: (min(float(r["bucket_start"]) for r in rows), max(float(r["bucket_end"]) for r in rows))
                         for i, rows in removed_rows.items()}
                trend_insts = list(monitored_instances) + sorted(removed_rows)
                trend_series, trend_slot = _build_fleet_trend(
                    req_end, query.minutes * 60.0, trend_insts, db_bucket_records=all_records, job=query.job,
                    maint_by_inst=maint_by_inst, source=source, prefer_job=instance_job_map, host_spans=spans,
                )
                payload["trend"] = trend_series
                payload["trend_bucket_seconds"] = trend_slot
                payload["trend_incidents"] = _build_fleet_incidents(
                    db_bucket_records=all_records, req_start=req_start, req_end=req_end,
                    instances=trend_insts, job=query.job, source=source, maint_by_inst=maint_by_inst,
                )
            payload.pop("_removed_maint", None)

            # Downtime Calendar section — derived from the SAME bucket rows the
            # headline was priced from, regardless of which path ran. Missing
            # historical days are reconstructed from Prometheus.
            payload["daily"] = _build_daily_downtime(
                db_bucket_records=all_records,
                req_start=req_start,
                req_end=req_end,
                instances=monitored_instances,
                job=query.job,
                maint_by_inst=maint_by_inst,
                instance_job_map=instance_job_map,
                source=source,
            )
            payload["job"] = query.job
            payload["scope"] = {
                "source": source,
                "whitelist_enforced": AVAIL_TARGET_WHITELIST is not None and bool(set(monitored_instances) & AVAIL_TARGET_WHITELIST),
                "instances": len(monitored_instances),
            }
            # Oldest instant materialized history can reach (Prometheus
            # retention, capped by AVAIL_BACKFILL_SECONDS). The UI uses it to
            # tell "outside retention, never reconstructable" apart from
            # "backfill pending".
            payload["history_floor_ts"] = int(now - self._backfill_depth(source))

            if not query.debug:
                payload.pop("_trace", None)

            self.cache.set(cache_key, payload, now=now_under_lock)
            if live_long:
                with self._refresh_guard:
                    self._last_live[view_id] = (now_under_lock, query.minutes_int, payload)
            return AvailabilityReport(payload)

    def get_trend(self, job: str, start_ts: float, end_ts: float, max_points: int = 180) -> Dict[str, Any]:
        """Fleet trend for an arbitrary [start, end] — the Trend chart's zoom.

        The full report's trend is sized for its whole range (a 30d report has
        4h slots), so zooming into a few days only magnified 4h blocks. This
        re-slices just the zoomed window: sub-hour slots from Prometheus where
        it still has the data, hourly stored buckets otherwise.
        """
        now = time.time()
        end_ts = min(float(end_ts), now)
        start_ts = max(0.0, min(float(start_ts), end_ts - 60.0))
        try:
            source = norm_source(self.prom_client.load_endpoints().get("active"))
        except Exception:
            source = ""
        key = f"trend:{source}:{(job or '').lower()}:{int(start_ts) // 60}:{int(end_ts) // 60}:{max_points}"
        hit = self.cache.get(key, 60.0, now=now)
        if hit is not None:
            return hit

        try:
            job_map = self._scoped_job_map(job, source) if source else {}
        except Exception:
            job_map = {}
        # Stored hourly buckets (+ Prometheus where they're missing) are
        # ALWAYS the baseline: a zoom's own series must never show less
        # than the report it came from. A wide zoom (>= 180h) used to be
        # Prometheus-only and went blank beyond retention.
        try:
            records = self.bucket_repo.get_bucket_records(job, start_ts, end_ts, instances=sorted(job_map) or None,
                                                          source=source) if source else []
        except Exception:
            records = []
        # A slow/unreachable Prometheus /targets gives an empty job map; the
        # hosts are still in SQLite. Returning an empty trend then blanked the
        # zoomed chart ("No telemetry") while the report above it had data.
        monitored = sorted(job_map) or sorted({r["instance"] for r in records if r.get("instance")})
        out = {
            "ok": True, "job": job, "trend": [], "trend_bucket_seconds": 3600,
            "trend_start_ts": int(start_ts), "trend_end_ts": int(end_ts),
            "trend_min_reporting_pct": round(AVAIL_TREND_MIN_REPORTING_RATIO * 100.0, 1),
        }
        if monitored:
            maint = self._resolve_maintenance_windows(start_ts, end_ts, job, monitored, source)
            job_map = job_map or None
            win = end_ts - start_ts
            series, slot = _build_fleet_trend(end_ts, win, monitored, max_points=max_points,
                                              db_bucket_records=records, job=job, maint_by_inst=maint,
                                              source=source, prefer_job=job_map)
            if win / max_points < 3600:
                # Finer sub-hour slots only come from Prometheus. Use them only
                # when they cover every hour the hourly series has — a partly
                # retained window would otherwise trade stored history for gaps.
                sub, sub_slot = _build_fleet_trend(end_ts, win, monitored, max_points=max_points, job=job,
                                                   maint_by_inst=maint, source=source, allow_subhour=True,
                                                   prefer_job=job_map)
                hour_of = lambda ts: int((ts - 1) // 3600)
                hourly_hours = {hour_of(p["ts"]) for p in series if p.get("availability_pct") is not None}
                sub_hours = {hour_of(p["ts"]) for p in sub if p.get("availability_pct") is not None}
                if sub_slot < 3600 and sub_hours and hourly_hours <= sub_hours:
                    series, slot = sub, sub_slot
            out.update(trend=series, trend_bucket_seconds=slot)
        if out["trend"]:  # an empty answer is usually transient — don't pin it for 60s
            self.cache.set(key, out, now=now)
        return out

    def aggregate_hourly_buckets(self, now: Optional[float] = None) -> int:
        """Roll up completed historical 1-hour availability buckets and persist to SQLite.
        Returns the count of bucket records written.

        Ported from the original _aggregate_availability_cycle: one bucket row
        per instance PER HOUR (not one wide row per aggregation window), exact
        reconstruction from raw 0/1 samples when available with a per-hour
        outage_json payload, and a first_ts/last_ts overlap fallback when the
        range query is empty. changes() counts both edges of an outage, so the
        incident count is halved (ceil) before persisting.
        """
        curr_time = now if now is not None else time.time()
        try:
            source = norm_source(self.prom_client.load_endpoints().get("active"))
        except Exception:
            source = ""
        if not source:
            return 0
        try:
            self._validate_whitelist(source)
            instance_job_map = self._scoped_job_map("all", source)
            monitored = sorted(instance_job_map.keys())
        except Exception:
            instance_job_map = {}
            monitored = []

        if not monitored:
            return 0

        latest_end = self.bucket_repo.get_latest_bucket_end("all", source=source)
        windows_to_aggregate = self._availability_aggregation_windows(curr_time, latest_end)
        self._backfill_depth_sec = self._backfill_depth(source)
        depth_window = self._next_depth_backfill_window(monitored, curr_time, source)
        if depth_window is not None:
            windows_to_aggregate = [depth_window] + windows_to_aggregate
        total_written = 0

        executor = getattr(self.prom_client, "_SHARED_EXECUTOR", None)

        # Several depth chunks per cycle while the budget lasts: one 1h chunk
        # per 60s tick took ~24h to backfill 60d of retention after a fresh start.
        deadline = time.monotonic() + AVAIL_BACKFILL_CYCLE_BUDGET_SECONDS
        while True:
            for w_start, w_end in windows_to_aggregate:
                if depth_window is not None and (w_start, w_end) == depth_window:
                    rows, complete, st = self._materialize_depth_chunk(
                        w_start, w_end, monitored, instance_job_map, source, curr_time)
                    if not complete:
                        fails = self._deep_chunk_failures.get(depth_window, 0) + 1
                        self._deep_chunk_failures[depth_window] = fails
                        if fails < AVAIL_BACKFILL_MAX_CHUNK_FAILURES:
                            logger.warning(
                                "Availability depth backfill: fetch failed for [%.0f, %.0f] "
                                "(attempt %d/%d); will retry",
                                w_start, w_end, fails, AVAIL_BACKFILL_MAX_CHUNK_FAILURES)
                            self._deep_cursor = w_end
                            continue
                        # Keep what was built; the missing hosts/hours stay
                        # holes for the next sweep to retry.
                        logger.warning(
                            "Availability depth backfill: fetch failed %d times for [%.0f, %.0f]; "
                            "storing %d complete row(s), rest left for the next sweep",
                            fails, w_start, w_end, len(rows))
                    self._deep_chunk_failures.pop(depth_window, None)
                    logger.info(
                        "Availability depth backfill: [%.0f, %.0f] %d host(s): %d stable hour(s), "
                        "%d raw hour(s) via %d request(s), %d raw sample(s)",
                        w_start, w_end, st["hosts"], st["stable_hours"], st["raw_hours"],
                        st["raw_requests"], st["raw_samples"])
                    if rows:
                        try:
                            self.bucket_repo.save_buckets(rows, source)
                            total_written += len(rows)
                            self._note_materialized(w_start, w_end)
                        except Exception:
                            logger.exception(
                                "availability aggregator: save_buckets failed for %d record(s)", len(rows))
                    continue

                w_minutes = max(1, int(round((w_end - w_start) / 60.0)))
                step_sec = SCRAPE_INTERVAL_SECONDS
                if w_minutes > 10080:
                    step_sec = 300.0
                elif w_minutes > 1440:
                    step_sec = 30.0

                at_suffix = f" @ {int(w_end)}"
                queries = {
                    "probe_avail": f"avg_over_time(probe_success[{w_minutes}m]{at_suffix}) * 100",
                    "up_avail": f"avg_over_time(up[{w_minutes}m]{at_suffix}) * 100",
                    "probe_count": f"count_over_time(probe_success[{w_minutes}m]{at_suffix})",
                    "up_count": f"count_over_time(up[{w_minutes}m]{at_suffix})",
                    "probe_first_ts": f"min_over_time(timestamp(probe_success)[{w_minutes}m:]{at_suffix})",
                    "probe_last_ts": f"max_over_time(timestamp(probe_success)[{w_minutes}m:]{at_suffix})",
                    "up_first_ts": f"min_over_time(timestamp(up)[{w_minutes}m:]{at_suffix})",
                    "up_last_ts": f"max_over_time(timestamp(up)[{w_minutes}m:]{at_suffix})",
                    "duration": f"avg_over_time(probe_duration_seconds[{w_minutes}m]{at_suffix}) * 1000",
                    "probe_incidents": f"changes(probe_success[{w_minutes}m]{at_suffix})",
                    "up_incidents": f"changes(up[{w_minutes}m]{at_suffix})",
                }

                if executor:
                    futures = {k: executor.submit(self.prom_queries.fetch_prom_query_map, q, 10.0, 15.0, source,
                                                  prefer_job=instance_job_map) for k, q in queries.items()}
                    results = {}
                    for k, f in futures.items():
                        try:
                            results[k] = f.result()
                        except Exception:
                            results[k] = {}
                else:
                    results = {}
                    for k, q in queries.items():
                        try:
                            results[k] = self.prom_queries.fetch_prom_query_map(q, 10.0, 15.0, source, prefer_job=instance_job_map)
                        except Exception:
                            results[k] = {}

                range_step = 15.0
                try:
                    probe_range_map = self.prom_queries.fetch_prom_range_map("probe_success", w_start, w_end, RAW_LEAD_IN_SECONDS, cache_ttl=10.0, timeout=20.0, source=source, prefer_job=instance_job_map, strict=True)
                except Exception:
                    probe_range_map = None
                if probe_range_map is None:
                    # A blackbox target's `up` stays 1 while its probe fails, so filling
                    # a failed probe_success fetch in from `up` (raw or scalar) booked
                    # down hosts as fully up. Leave what is stored and retry: a head
                    # window is re-aggregated next cycle (stop here so no later
                    # window moves the watermark past it).
                    logger.warning(
                        "Availability aggregator: probe_success fetch failed for [%.0f, %.0f]; "
                        "keeping stored buckets, will retry", w_start, w_end)
                    break
                else:
                    try:
                        up_range_map = self.prom_queries.fetch_prom_range_map("up", w_start, w_end, RAW_LEAD_IN_SECONDS, cache_ttl=10.0, timeout=20.0, source=source, prefer_job=instance_job_map)
                    except Exception:
                        up_range_map = {}

                probe_results_raw = {
                    "avail": results.get("probe_avail", {}), "count": results.get("probe_count", {}),
                    "first_ts": results.get("probe_first_ts", {}), "last_ts": results.get("probe_last_ts", {}),
                    "incidents": results.get("probe_incidents", {}),
                }
                up_results_raw = {
                    "avail": results.get("up_avail", {}), "count": results.get("up_count", {}),
                    "first_ts": results.get("up_first_ts", {}), "last_ts": results.get("up_last_ts", {}),
                    "incidents": results.get("up_incidents", {}),
                }
                merged_maps = derive_bucket_inputs(monitored, probe_results_raw, up_results_raw)

                # Prometheus has samples for this window (count > 0) but the raw
                # fetch came back empty: a timeout/oversized response, not "no data".
                raw_fetch_failed = (not probe_range_map and not up_range_map
                                    and any(merged_maps["count"].get(i) for i in monitored))
                if raw_fetch_failed:
                    logger.warning(
                        "Availability aggregator: raw sample fetch failed for [%.0f, %.0f]; "
                        "storing scalar fallback without outage intervals", w_start, w_end)
                avail_map = merged_maps["avail"]
                count_map = merged_maps["count"]
                first_ts_map = merged_maps["first_ts"]
                last_ts_map = merged_maps["last_ts"]
                incidents_map = merged_maps["incidents"]
                duration_map = results.get("duration", {})

                observed_cadences = []
                for inst in monitored:
                    estimated = estimate_instance_cadence(inst, count_map, first_ts_map, last_ts_map)
                    if estimated is not None:
                        observed_cadences.append(estimated)
                fleet_median_cadence = (
                    sorted(observed_cadences)[len(observed_cadences) // 2]
                    if observed_cadences else SCRAPE_INTERVAL_SECONDS
                )

                bucket_records = []
                h_start = math.floor(w_start / 3600.0) * 3600.0
                h_end = math.ceil(w_end / 3600.0) * 3600.0
                num_hours = max(1, int(round((h_end - h_start) / 3600.0)))
                w_duration_sec = float(w_end - w_start)

                for inst in monitored:
                    raw_avail = avail_map.get(inst)
                    raw_count = count_map.get(inst)
                    raw_dur = duration_map.get(inst)
                    raw_inc = incidents_map.get(inst)

                    latency = 0.0
                    if raw_dur is not None:
                        try:
                            latency = round(float(raw_dur), 1)
                        except (ValueError, TypeError):
                            latency = 0.0

                    # Exact path: raw 0/1 samples for this instance (probe_success
                    # first, fall back to the `up` series for node/exporter targets).
                    samples = probe_range_map.get(inst) or up_range_map.get(inst)
                    if samples:
                        cad = (
                            estimate_instance_cadence(inst, count_map, first_ts_map, last_ts_map)
                            or (fleet_median_cadence if fleet_median_cadence > 0 else range_step)
                        )
                        sample_ts = [ts for ts, _ in samples]
                        cur_h = h_start
                        while cur_h < h_end:
                            if cur_h >= curr_time:
                                break  # never materialize a bucket for an hour that has not started
                            bucket_records.append(_raw_hour_record(
                                inst, instance_job_map.get(inst, "blackbox"), samples, sample_ts,
                                cur_h, curr_time, cad, latency))
                            cur_h += 3600.0
                        continue

                    # Fallback path: no raw samples — approximate from the
                    # avg_over_time / count / first-last-timestamp scalars.
                    avail_pct = None
                    raw_avail_float = None
                    if raw_avail is not None:
                        try:
                            raw_avail_float = max(0.0, min(100.0, float(raw_avail)))
                            avail_pct = round(raw_avail_float, 2)
                        except (ValueError, TypeError):
                            avail_pct = None
                            raw_avail_float = None

                    sample_count = 0
                    cov_sec = 0.0
                    f_ts = float(first_ts_map.get(inst, 0)) if first_ts_map else 0.0
                    l_ts = float(last_ts_map.get(inst, 0)) if last_ts_map else 0.0

                    if raw_count is not None:
                        try:
                            sample_count = int(float(raw_count))
                            if sample_count >= 2:
                                span = l_ts - f_ts
                                if f_ts > 0 and l_ts > 0 and span > 0:
                                    intv = span / (sample_count - 1)
                                    lead_in = min(intv, max(0.0, f_ts - w_start)) if (f_ts - w_start) <= intv * 1.5 else 0.0
                                    lead_out = min(intv, max(0.0, w_end - l_ts)) if (w_end - l_ts) <= intv * 1.5 else 0.0
                                    cov_sec = min(span + lead_in + lead_out, w_duration_sec)
                                else:
                                    eff_cad = fleet_median_cadence if fleet_median_cadence > 0 else step_sec
                                    cov_sec = min(sample_count * eff_cad, w_duration_sec)
                            elif sample_count == 1:
                                eff_cad = fleet_median_cadence if fleet_median_cadence > 0 else step_sec
                                cov_sec = min(eff_cad, w_duration_sec)
                        except (ValueError, TypeError):
                            cov_sec = 0.0
                    elif avail_pct is not None:
                        cov_sec = w_duration_sec

                    if raw_avail_float is not None:
                        up_rate = min(1.0, max(0.0, raw_avail_float / 100.0))
                        down_rate = max(0.0, 1.0 - up_rate)
                    else:
                        # No availability ratio (avg_over_time failed or absent):
                        # samples existed but their up/down split is unknown. With
                        # down_rate=0 the covered seconds used to be booked as pure
                        # uptime — a fabricated 100%. Record the hour as unknown.
                        up_rate = 0.0
                        down_rate = 0.0
                        cov_sec = 0.0
                        f_ts = l_ts = 0.0
                    down_sec = round(cov_sec * down_rate, 2)

                    inc_count = 0
                    if raw_inc is not None:
                        try:
                            inc_count = int(math.ceil(float(raw_inc) / 2.0))
                        except (ValueError, TypeError):
                            inc_count = 0
                    if inc_count == 0 and down_sec > 0:
                        inc_count = 1

                    cur_h = h_start
                    while cur_h < h_end:
                        nxt_h = cur_h + 3600.0
                        if f_ts > 0 and l_ts > 0 and l_ts >= f_ts:
                            overlap_start = max(cur_h, f_ts)
                            overlap_end = min(nxt_h, l_ts)
                            overlap_sec = max(0.0, overlap_end - overlap_start)
                            if overlap_sec > 0:
                                h_cov = min(3600.0, overlap_sec)
                                h_down = round(h_cov * down_rate, 2)
                                h_up = max(0.0, round(h_cov - h_down, 2))
                                h_unk = max(0.0, round(3600.0 - h_cov, 2))
                                h_avail = avail_pct
                            else:
                                h_cov = 0.0
                                h_down = 0.0
                                h_up = 0.0
                                h_unk = 3600.0
                                h_avail = None
                        elif avail_pct is not None or cov_sec > 0:
                            h_cov = min(3600.0, cov_sec / num_hours)
                            h_down = round(h_cov * down_rate, 2)
                            h_up = max(0.0, round(h_cov - h_down, 2))
                            h_unk = max(0.0, round(3600.0 - h_cov, 2))
                            h_avail = avail_pct
                        else:
                            h_cov = 0.0
                            h_down = 0.0
                            h_up = 0.0
                            h_unk = 3600.0
                            h_avail = None

                        bucket_records.append({
                            "instance": inst,
                            "job": instance_job_map.get(inst, "blackbox"),
                            "bucket_start": cur_h,
                            "bucket_end": nxt_h,
                            "uptime_seconds": round(h_up, 2),
                            "downtime_seconds": round(h_down, 2),
                            "unknown_seconds": round(h_unk, 2),
                            "coverage_seconds": round(h_cov, 2),
                            "sample_count": sample_count // num_hours,
                            "availability_pct": h_avail,
                            "incident_count": inc_count if cur_h == h_start else 0,
                            "avg_latency_ms": latency,
                            "updated_at": curr_time,
                        })
                        cur_h = nxt_h

                if bucket_records:
                    try:
                        self.bucket_repo.save_buckets(bucket_records, source)
                        total_written += len(bucket_records)
                    except Exception:
                        logger.exception(
                            "availability aggregator: save_buckets failed for %d record(s)", len(bucket_records)
                        )

            # Stop on budget, sweep done, or a failed chunk (cursor rewound to its end).
            if (depth_window is None or time.monotonic() >= deadline
                    or self._deep_cursor == depth_window[1]):
                break
            depth_window = self._next_depth_backfill_window(monitored, curr_time, source)
            if depth_window is None:
                break
            windows_to_aggregate = [depth_window]

        # Reports are cached up to 15 min (plus stale-serve), so days the sweep
        # just filled kept reading "backfill pending". Throttled: a cold 30d
        # report is expensive, don't rebuild it every cycle mid-sweep.
        floor_start = math.floor(curr_time / 3600.0) * 3600.0 - (self._backfill_depth_sec or AVAIL_BACKFILL_SECONDS)
        sweep_done = self._deep_cursor is None or self._deep_cursor <= floor_start
        if self._dirty_range and (sweep_done or curr_time - self._depth_invalidated_at >= AVAIL_BACKFILL_INVALIDATE_SECONDS):
            self._depth_invalidated_at = curr_time
            lo, hi = self._dirty_range
            self._dirty_range = None
            self.invalidate_range(lo, hi)

        return total_written

    def _scoped_job_map(self, job: str, source: str) -> Dict[str, str]:
        """Targets that server `source` itself scrapes (no failover, no
        alert-only fold-in from incidents), restricted to the whitelist."""
        job_map = get_instance_job_map(job, include_alert_only=False, source=source) or {}
        wl = AVAIL_TARGET_WHITELIST
        if wl is None:
            return job_map
        filtered = {i: j for i, j in job_map.items() if i in wl}
        # If the whitelist has matching targets for this server, enforce it.
        # If this server has targets but none match the static whitelist (e.g. a different
        # Prometheus server or new environment), fall back to all scraped targets on this server
        # so availability is computed and displayed rather than dropping all targets to NO_DATA.
        if not filtered and job_map:
            return job_map
        return filtered

    def _validate_whitelist(self, source: str) -> None:
        """Startup/reload check (runs every aggregator cycle, logs on change):
        the server's scraped targets must equal the whitelist. Unexpected
        targets are excluded from availability, logged loudly, never ingested."""
        wl = AVAIL_TARGET_WHITELIST
        state = self.__dict__.setdefault("_whitelist_state", {})
        if wl is None:
            if state.get(source) != "none":
                logger.warning("availability: no target whitelist file - every target on %s counts toward SLA", source)
                state[source] = "none"
            return
        live = set(get_instance_job_map("all", include_alert_only=False, source=source) or {})
        if not live:
            return  # server unreachable; nothing to validate
        if not (live & wl):
            if state.get(source) != "no_overlap":
                logger.info("availability: server %s has %d targets outside static whitelist; counting all toward SLA",
                            source, len(live))
                state[source] = "no_overlap"
            return
        unexpected, missing = sorted(live - wl), sorted(wl - live)
        sig = (tuple(unexpected), tuple(missing))
        if state.get(source) == sig:
            return
        state[source] = sig
        if unexpected:
            logger.error("availability: %s scrapes %d NON-whitelisted target(s), excluded from SLA/trend/calendar: %s",
                         source, len(unexpected), unexpected)
        if missing:
            logger.warning("availability: %d whitelisted target(s) not scraped by %s: %s",
                           len(missing), source, missing)
        if not unexpected and not missing:
            logger.info("availability: %s targets match the whitelist exactly (%d)", source, len(wl))

    def _resolve_maintenance_windows(self, req_start: float, req_end: float, job: str, monitored_instances: List[str], source: str):
        try:
            all_windows = load_maintenance_windows()
            overlapping = [
                w for w in all_windows
                if w.get("sla_excluded", True)  # "Include in SLA" windows only mute alarms
                and _parse_epoch_ts(w.get("end_epoch") if w.get("end_epoch") is not None else w.get("end", 0)) > req_start
                and _parse_epoch_ts(w.get("start_epoch") if w.get("start_epoch") is not None else w.get("start", 0)) < req_end
            ]
            if overlapping:
                needs_job = any((w.get("scope") or w.get("scope_type")) == "job" for w in overlapping)
                job_map = get_instance_job_map(job, source=source) if needs_job else {}
                return maintenance_windows_by_instance(monitored_instances, job_map, overlapping) or None
        except Exception:
            pass
        return None

    def _check_sqlite_coverage(
        self,
        db_bucket_records: List[Dict[str, Any]],
        monitored_instances: List[str],
        req_start: float,
        req_end: float,
        end_ts: Optional[float],
        now: float,
    ) -> bool:
        if not db_bucket_records or not monitored_instances:
            return False

        instances_in_db = set()
        instance_spans = {}
        newest_bucket_update = 0.0

        # A row with zero coverage counts too: the aggregator writes one for
        # an hour Prometheus has no samples of (host added later, exporter
        # off). Requiring coverage sent the whole 30d report of a job with
        # one such host to the hybrid path — ~45s re-querying Prometheus for
        # hours it has nothing for. Same "materialized" as the depth sweep.
        monitored_set = set(monitored_instances)
        for b in db_bucket_records:
            inst = b.get("instance")
            if inst in monitored_set:
                instances_in_db.add(inst)
                st = float(b.get("bucket_start", 0))
                en = float(b.get("bucket_end", 0))
                try:
                    newest_bucket_update = max(newest_bucket_update, float(b.get("updated_at", 0) or 0))
                except (TypeError, ValueError):
                    pass
                cur = instance_spans.get(inst)
                if cur is None:
                    instance_spans[inst] = (st, en, 1)
                else:
                    instance_spans[inst] = (min(cur[0], st), max(cur[1], en), cur[2] + 1)

        aggregator_fresh = (
            end_ts is not None
            or (newest_bucket_update > 0.0 and (now - newest_bucket_update) < _AVAIL_STALE_BUCKET_TOLERANCE_SEC)
        )

        if len(instances_in_db) == len(monitored_instances) and aggregator_fresh:
            expected_hours = max(1, int(round((req_end - req_start) / 3600.0)))
            for inst in monitored_instances:
                sp = instance_spans.get(inst)
                if not sp or sp[0] > (req_start + 3600.0) or sp[1] < (req_end - _AVAIL_FRESHNESS_TOLERANCE_SEC) or sp[2] < max(1, expected_hours - 1):
                    return False
            return True
        return False

    def _reincorporate_removed_targets(
        self,
        query: AvailabilityQuery,
        req_start: float,
        req_end: float,
        monitored_instances: List[str],
        maint_by_inst: Any,
        sla_target_map: Dict[str, float],
        payload: Dict[str, Any],
        *,
        source: str,
    ) -> Dict[str, Any]:
        """Re-adds instances that have materialized SQLite buckets inside
        [req_start, req_end] but are no longer in `monitored_instances` (i.e.
        soft-deleted via DELETE /api/targets — see storage/targets_store.py).
        A removed target has no live tail to merge (Prometheus no longer
        scrapes it), so this is SQLite-only: purely additive on top of the
        already-computed fast/hybrid payload, and a no-op — one cheap query,
        itself usually empty — whenever nothing has ever been removed inside
        the window.
        """
        try:
            all_buckets_in_window = self.bucket_repo.get_bucket_records(
                job=query.job, start_time=req_start, end_time=req_end, source=source,
            )
        except Exception:
            return payload

        monitored_set = set(monitored_instances)
        removed_buckets_by_inst: Dict[str, List[Dict[str, Any]]] = {}
        for b in all_buckets_in_window:
            inst = b.get("instance")
            if inst and inst not in monitored_set:
                removed_buckets_by_inst.setdefault(inst, []).append(b)
        if not removed_buckets_by_inst:
            return payload
        # Planned maintenance of a removed host is excluded like anyone else's.
        removed_maint = self._resolve_maintenance_windows(
            req_start, req_end, query.job, sorted(removed_buckets_by_inst), source) or {}
        maint_by_inst = dict(maint_by_inst or {}, **removed_maint)

        empty_prom = {"first_ts": None, "last_ts": None, "count": None, "avail": None, "incidents": None, "duration": None}
        removed_entries = []
        for inst, buckets in removed_buckets_by_inst.items():
            # A bucket row can exist with zero real coverage: an alertmanager
            # webhook naming an "instance" that was never actually scraped
            # (a test/diagnostic payload, a typo'd target) briefly satisfies
            # get_instance_job_map's include_alert_only fold-in for one
            # aggregation cycle, which writes a placeholder row for it. That
            # phantom then gets "reincorporated" forever, inflating the host
            # count and showing a 0%-complete row for something that was
            # never real infrastructure. A genuinely removed/renamed host
            # always has real coverage in its history — that's the whole
            # point of bringing it back — so zero coverage across every
            # bucket is the signal this isn't one.
            if sum(float(b.get("coverage_seconds") or 0.0) for b in buckets) <= 0.0:
                continue
            job_name = buckets[-1].get("job") or buckets[0].get("job") or query.job
            removed_entries.append(merge_hybrid_target_availability(
                req_start=req_start,
                req_end=req_end,
                target_id=inst,
                target_name=inst,
                job=job_name,
                sqlite_buckets=buckets,
                prom_metrics=empty_prom,
                sla_threshold=float((sla_target_map or {}).get(inst, query.sla_target_pct)),
                maintenance_windows=(maint_by_inst or {}).get(inst),
            ))

        if not removed_entries:
            return payload
        combined_entries = list(payload.get("entries") or []) + removed_entries
        combined_summary = summarize_entries(
            combined_entries, period_minutes=query.minutes, sla_threshold=query.sla_target_pct,
        )
        fleet_sla_budget = _attach_sla_budgets(
            combined_summary, query.minutes * 60.0, query.sla_target_pct, query.sla_days,
            target_map=sla_target_map,
        )
        counts = _availability_status_counts(combined_entries)
        lowest_availability = sorted(
            [e for e in combined_summary["per_server"]["values"] if e.get("availability_pct") is not None and e["availability_pct"] < 100.0],
            key=lambda e: (
                e["availability_pct"],
                -(e.get("downtime_minutes") or 0.0),
                -(e.get("incidents") or 0),
            ),
        )

        payload = dict(payload)
        payload["sla"] = fleet_sla_budget
        payload["availability_percent"] = combined_summary["fleet_aggregate"]["value"]
        payload["overall"] = combined_summary["fleet_aggregate"]["value"]
        payload["fleet_aggregate"] = combined_summary["fleet_aggregate"]
        payload["fleet_average"] = combined_summary["fleet_average"]
        payload["health_ratio"] = combined_summary["health_ratio"]
        payload["zero_downtime_ratio"] = combined_summary.get("zero_downtime_ratio")
        payload["sla_compliance"] = combined_summary.get("sla_compliance")
        payload["sla_compliance_ratio"] = combined_summary.get("sla_compliance_ratio")
        payload["coverage_ratio"] = combined_summary.get("coverage_ratio", payload.get("coverage_ratio"))
        payload["per_server"] = combined_summary["per_server"]
        payload["entries"] = combined_entries
        payload["targets"] = {e["id"]: e["availability_pct"] for e in combined_entries}
        payload["analytics"] = combined_summary.get("analytics", payload.get("analytics", {}))
        payload["lowest_availability"] = lowest_availability
        payload["hosts_requiring_attention"] = lowest_availability
        payload["counts"] = {
            **payload.get("counts", {}),
            "total": len(monitored_instances) + len(removed_entries),
            "scored": combined_summary.get("scored_count", 0),
            "eligible": combined_summary.get("eligible_count", 0),
            "online": counts["online"],
            "warning": counts["warning"],
            "offline": counts["offline"],
            "removed": len(removed_entries),
        }
        kept = {e["id"] for e in removed_entries}
        payload["_removed_rows"] = {i: rows for i, rows in removed_buckets_by_inst.items() if i in kept}
        payload["_removed_maint"] = {i: w for i, w in removed_maint.items() if i in kept}
        return payload

    def _compute_fast_path_payload(
        self,
        query: AvailabilityQuery,
        req_start: float,
        req_end: float,
        monitored_instances: List[str],
        db_bucket_records: List[Dict[str, Any]],
        maint_by_inst: Any,
        sla_target_map: Dict[str, float],
        flight_wait_ms: float,
        sqlite_duration_ms: float,
        t_req_start: float,
        instance_job_map: Optional[Dict[str, str]] = None,
        *,
        source: str,
    ) -> Dict[str, Any]:
        t_merge_start = time.perf_counter()
        entries, summary_dict = merge_hybrid_fleet_availability(
            req_start=req_start,
            req_end=req_end,
            monitored_instances=monitored_instances,
            sqlite_buckets=db_bucket_records,
            prom_results_map={},
            expected_interval_sec=SCRAPE_INTERVAL_SECONDS,
            maintenance_by_instance=maint_by_inst,
            sla_threshold=query.sla_target_pct,
            sla_threshold_by_instance=sla_target_map,
            job_by_instance=instance_job_map,
        )
        t_merge_end = time.perf_counter()
        merge_duration_ms = (t_merge_end - t_merge_start) * 1000.0

        fleet_sla_budget = _attach_sla_budgets(
            summary_dict, query.minutes * 60.0, query.sla_target_pct, query.sla_days, target_map=sla_target_map
        )
        hybrid_meta = summary_dict.get("hybrid", {})

        if any(e.get("availability_pct") is None for e in entries):
            counts = _availability_status_counts(entries, self.prom_queries.fetch_prom_query_map(
                with_job("probe_success", query.job), source=source, prefer_job=instance_job_map))
        else:
            counts = _availability_status_counts(entries)

        lowest_availability = sorted(
            [e for e in summary_dict["per_server"]["values"] if e.get("availability_pct") is not None and e["availability_pct"] < 100.0],
            key=lambda e: (
                e["availability_pct"],
                -(e.get("downtime_minutes") or 0.0),
                -(e.get("incidents") or 0),
            ),
        )

        trend_series, trend_slot_sec = _build_fleet_trend(
            req_end, query.minutes * 60.0, monitored_instances, db_bucket_records=db_bucket_records, job=query.job,
            maint_by_inst=maint_by_inst, source=source, prefer_job=instance_job_map,
        )
        trend_incidents = _build_fleet_incidents(
            db_bucket_records=db_bucket_records,
            req_start=req_start,
            req_end=req_end,
            instances=monitored_instances,
            job=query.job,
            source=source,
            maint_by_inst=maint_by_inst,
        )
        t_done = time.perf_counter()

        trace_data = {
            "route": "/api/availability",
            "path": "sqlite_fast_path",
            "minutes": query.minutes_int,
            "flight_wait_ms": round(flight_wait_ms, 2),
            "sqlite_duration_ms": round(sqlite_duration_ms, 2),
            "sqlite_record_count": len(db_bucket_records),
            "prom_duration_ms": 0.0,
            "prom_query_count": 0,
            "prom_queries": {},
            "hybrid_merge_ms": round(merge_duration_ms, 2),
            "materialize_ms": 0.0,
            "total_backend_ms": round((t_done - t_req_start) * 1000.0, 2),
        }

        return self._assemble_payload(
            query=query,
            req_end=req_end,
            monitored_instances=monitored_instances,
            summary_dict=summary_dict,
            hybrid_meta=hybrid_meta,
            fleet_sla_budget=fleet_sla_budget,
            counts=counts,
            lowest_availability=lowest_availability,
            trend_series=trend_series,
            trend_slot_sec=trend_slot_sec,
            trend_incidents=trend_incidents,
            source="materialized",
            data_status="COMPLETE",
            trace_data=trace_data,
        )

    def _compute_hybrid_path_payload(
        self,
        query: AvailabilityQuery,
        req_start: float,
        req_end: float,
        monitored_instances: List[str],
        db_bucket_records: List[Dict[str, Any]],
        maint_by_inst: Any,
        sla_target_map: Dict[str, float],
        flight_wait_ms: float,
        sqlite_duration_ms: float,
        t_req_start: float,
        instance_job_map: Optional[Dict[str, str]] = None,
        *,
        source: str,
    ) -> Dict[str, Any]:
        at_suffix = f" @ {query.end_ts}" if query.end_ts is not None else ""

        # Determine whether SQLite covers history, so Prometheus only needs to query the un-materialized head
        instance_spans = {}
        for b in db_bucket_records:
            inst = b.get("instance")
            cov = float(b.get("coverage_seconds", 0) or 0)
            if inst in monitored_instances and cov > 0:
                st = float(b.get("bucket_start", 0))
                en = float(b.get("bucket_end", 0))
                cur = instance_spans.get(inst)
                if cur is None:
                    instance_spans[inst] = (st, en, 1)
                else:
                    instance_spans[inst] = (min(cur[0], st), max(cur[1], en), cur[2] + 1)

        sqlite_head_only = False
        prom_query_minutes = query.minutes_int
        prom_head_sec = None

        # Head-only needs SQLite to hold the window's HISTORY too, not just a
        # recent tail: with only the last ~18h materialized (backfill still
        # walking back), checking the end alone dropped the other 29 days of
        # a 30d window from the headline — "Unmonitored 697h" for hosts
        # Prometheus had watched the whole time, while the Trend and the
        # Calendar filled those days from Prometheus. Otherwise query
        # Prometheus for the full window (merge_hybrid then uses SQLite only
        # where Prometheus has no samples).
        reaches_start = sum(1 for sp in instance_spans.values() if sp[0] <= req_start + 3600.0)
        if (len(instance_spans) >= len(monitored_instances) * 0.85
                and reaches_start >= len(monitored_instances) * 0.85):
            min_end = min(sp[1] for sp in instance_spans.values())
            # If SQLite covers historical data ending within 24 hours of req_end:
            # Query Prometheus ONLY for the un-materialized live head!
            if min_end >= (req_end - 86400.0):
                if min_end < req_end:
                    head_sec = max(60.0, req_end - min_end)
                else:
                    head_sec = 60.0
                prom_query_minutes = max(1, int(math.ceil(head_sec / 60.0)))
                prom_head_sec = head_sec
                sqlite_head_only = True

        req_timeout = 8.0 if sqlite_head_only else max(5.0, min(30.0, query.minutes / 300.0))
        avail_cache_ttl = 15.0 if query.minutes_int >= 1440 else 5.0

        # Scoped to the view's job (the same matcher the stored rows, the Trend
        # and the Calendar use) — unscoped, `up{instance=X}` of another job
        # (node exporter down) priced a gitlab-rails view at 0%.
        probe = with_job("probe_success", query.job)
        upm = with_job("up", query.job)
        durm = with_job("probe_duration_seconds", query.job)
        queries = {
            "probe_avail": f"avg_over_time({probe}[{prom_query_minutes}m]{at_suffix}) * 100",
            "up_avail": f"avg_over_time({upm}[{prom_query_minutes}m]{at_suffix}) * 100",
            "probe_count": f"count_over_time({probe}[{prom_query_minutes}m]{at_suffix})",
            "up_count": f"count_over_time({upm}[{prom_query_minutes}m]{at_suffix})",
            "duration": f"avg_over_time({durm}[{prom_query_minutes}m]{at_suffix}) * 1000",
            "probe_incidents": f"changes({probe}[{prom_query_minutes}m]{at_suffix})" if prom_query_minutes <= 1440 else None,
            "up_incidents": f"changes({upm}[{prom_query_minutes}m]{at_suffix})" if prom_query_minutes <= 1440 else None,
            "live_probe": probe if query.end_ts is None else None,
            "live_up": upm if query.end_ts is None else None,
        }
        if prom_query_minutes <= 60:
            queries["probe_first_ts"] = f"min_over_time(timestamp({probe})[{prom_query_minutes}m:]{at_suffix})"
            queries["probe_last_ts"] = f"max_over_time(timestamp({probe})[{prom_query_minutes}m:]{at_suffix})"
            queries["up_first_ts"] = f"min_over_time(timestamp({upm})[{prom_query_minutes}m:]{at_suffix})"
            queries["up_last_ts"] = f"max_over_time(timestamp({upm})[{prom_query_minutes}m:]{at_suffix})"

        t_prom_start = time.perf_counter()
        executor = getattr(self.prom_client, "_SHARED_EXECUTOR", None)

        def _call_q(expr):
            t_s = time.perf_counter()
            res = self.prom_queries.fetch_prom_query_map(expr, cache_ttl=avail_cache_ttl, timeout=req_timeout, source=source,
                                                         prefer_job=instance_job_map)
            return res, (time.perf_counter() - t_s) * 1000.0

        results = {}
        prom_query_timings = {}
        if executor:
            futures = {k: executor.submit(_call_q, q) for k, q in queries.items() if q}
            for k, f in futures.items():
                try:
                    res, q_dur = f.result()
                    results[k] = res
                    prom_query_timings[k] = round(q_dur, 2)
                except Exception:
                    results[k] = {}
                    prom_query_timings[k] = -1.0
        else:
            for k, q in queries.items():
                if q:
                    res, q_dur = _call_q(q)
                    results[k] = res
                    prom_query_timings[k] = round(q_dur, 2)

        t_prom_end = time.perf_counter()
        prom_duration_ms = (t_prom_end - t_prom_start) * 1000.0

        probe_results_raw = {
            "avail": results.get("probe_avail", {}), "count": results.get("probe_count", {}),
            "first_ts": results.get("probe_first_ts", {}), "last_ts": results.get("probe_last_ts", {}),
            "incidents": results.get("probe_incidents", {}), "live": results.get("live_probe", {}),
        }
        up_results_raw = {
            "avail": results.get("up_avail", {}), "count": results.get("up_count", {}),
            "first_ts": results.get("up_first_ts", {}), "last_ts": results.get("up_last_ts", {}),
            "incidents": results.get("up_incidents", {}), "live": results.get("live_up", {}),
        }
        merged_maps = derive_bucket_inputs(monitored_instances, probe_results_raw, up_results_raw)
        avail_map = merged_maps["avail"]
        count_map = merged_maps["count"]
        first_ts_map = merged_maps["first_ts"]
        last_ts_map = merged_maps["last_ts"]
        incidents_map = merged_maps["incidents"]
        live_map = merged_maps["live"]
        duration_map = results.get("duration", {})

        try:
            cadence_map = dict(get_instance_cadence_map(query.job, source=source))
        except Exception:
            cadence_map = {}
        for inst in monitored_instances:
            estimated = estimate_instance_cadence(inst, count_map, first_ts_map, last_ts_map)
            if estimated is not None:
                cadence_map[inst] = estimated

        prom_results_map = {
            "first_ts": first_ts_map,
            "last_ts": last_ts_map,
            "count": count_map,
            "avail": avail_map,
            "incidents": incidents_map,
            "duration": duration_map,
        }
        if prom_head_sec is not None:
            prom_results_map["window_sec"] = prom_head_sec

        t_merge_start = time.perf_counter()
        entries, summary_dict = merge_hybrid_fleet_availability(
            req_start=req_start,
            req_end=req_end,
            monitored_instances=monitored_instances,
            sqlite_buckets=db_bucket_records,
            prom_results_map=prom_results_map,
            expected_interval_sec=cadence_map,
            maintenance_by_instance=maint_by_inst,
            sla_threshold=query.sla_target_pct,
            sla_threshold_by_instance=sla_target_map,
            job_by_instance=instance_job_map,
        )
        t_merge_end = time.perf_counter()
        merge_duration_ms = (t_merge_end - t_merge_start) * 1000.0

        fleet_sla_budget = _attach_sla_budgets(
            summary_dict, query.minutes * 60.0, query.sla_target_pct, query.sla_days, target_map=sla_target_map
        )
        hybrid_meta = summary_dict.get("hybrid", {})
        counts = _availability_status_counts(entries, live_map)

        lowest_availability = sorted(
            [e for e in summary_dict["per_server"]["values"] if e.get("availability_pct") is not None and e["availability_pct"] < 100.0],
            key=lambda e: (
                e["availability_pct"],
                -(e.get("downtime_minutes") or 0.0),
                -(e.get("incidents") or 0),
            ),
        )

        trend_series, trend_slot_sec = _build_fleet_trend(
            req_end, query.minutes * 60.0, monitored_instances, db_bucket_records=db_bucket_records, job=query.job,
            maint_by_inst=maint_by_inst, source=source, prefer_job=instance_job_map,
        )
        trend_incidents = _build_fleet_incidents(
            db_bucket_records=db_bucket_records,
            req_start=req_start,
            req_end=req_end,
            instances=monitored_instances,
            job=query.job,
            source=source,
            maint_by_inst=maint_by_inst,
        )
        t_done = time.perf_counter()

        trace_data = {
            "route": "/api/availability",
            "path": "hybrid_path",
            "minutes": query.minutes_int,
            "flight_wait_ms": round(flight_wait_ms, 2),
            "sqlite_duration_ms": round(sqlite_duration_ms, 2),
            "sqlite_record_count": len(db_bucket_records),
            "prom_duration_ms": round(prom_duration_ms, 2),
            "prom_query_count": len([q for q in queries.values() if q]),
            "prom_queries": prom_query_timings,
            "hybrid_merge_ms": round(merge_duration_ms, 2),
            "materialize_ms": 0.0,
            "total_backend_ms": round((t_done - t_req_start) * 1000.0, 2),
        }

        return self._assemble_payload(
            query=query,
            req_end=req_end,
            monitored_instances=monitored_instances,
            summary_dict=summary_dict,
            hybrid_meta=hybrid_meta,
            fleet_sla_budget=fleet_sla_budget,
            counts=counts,
            lowest_availability=lowest_availability,
            trend_series=trend_series,
            trend_slot_sec=trend_slot_sec,
            trend_incidents=trend_incidents,
            source=hybrid_meta.get("source", "fallback"),
            data_status=hybrid_meta.get("data_status", "PARTIAL"),
            trace_data=trace_data,
        )

    def _assemble_payload(
        self,
        query: AvailabilityQuery,
        req_end: float,
        monitored_instances: List[str],
        summary_dict: Dict[str, Any],
        hybrid_meta: Dict[str, Any],
        fleet_sla_budget: Any,
        counts: Dict[str, int],
        lowest_availability: List[Dict[str, Any]],
        trend_series: List[Dict[str, Any]],
        trend_slot_sec: int,
        source: str,
        data_status: str,
        trace_data: Dict[str, Any],
        trend_incidents: Optional[List[Dict[str, Any]]] = None,
    ) -> Dict[str, Any]:
        return {
            "ok": True,
            "period_minutes": round(query.minutes, 2),
            "requested_window_seconds": hybrid_meta.get("requested_window_seconds", round(query.minutes * 60.0, 1)),
            "coverage_seconds": hybrid_meta.get("coverage_seconds", 0.0),
            "unknown_seconds": hybrid_meta.get("unknown_seconds", 0.0),
            "missing_seconds": hybrid_meta.get("missing_seconds", hybrid_meta.get("unknown_seconds", 0.0)),
            "sqlite_seconds": hybrid_meta.get("sqlite_seconds", 0.0),
            "prometheus_seconds": hybrid_meta.get("prometheus_seconds", 0.0),
            "overlap_removed_seconds": hybrid_meta.get("overlap_removed_seconds", 0.0),
            "maintenance_excluded_seconds": hybrid_meta.get("maintenance_excluded_seconds", 0.0),
            "maintenance_scheduled_seconds": hybrid_meta.get("maintenance_scheduled_seconds", 0.0),
            "sla": fleet_sla_budget,
            "coverage_percent": hybrid_meta.get("coverage_percent", 0.0),
            "availability_percent": summary_dict["fleet_aggregate"]["value"],
            "data_status": data_status,
            "telemetry_audit": hybrid_meta.get("telemetry_audit", summary_dict.get("telemetry_audit", {})),
            "end": query.end_ts,
            "counts": {
                "total": len(monitored_instances),
                "scored": summary_dict.get("scored_count", 0),
                "eligible": summary_dict.get("eligible_count", 0),
                "online": counts["online"],
                "warning": counts["warning"],
                "offline": counts["offline"],
                # No longer monitored (deleted, renamed, or dropped from
                # Prometheus scrape config) but still folded into this
                # window's totals below — see _reincorporate_removed_targets.
                "removed": 0,
            },
            "overall": summary_dict["fleet_aggregate"]["value"],
            "fleet_aggregate": summary_dict["fleet_aggregate"],
            "fleet_average": summary_dict["fleet_average"],
            "health_ratio": summary_dict["health_ratio"],
            "zero_downtime_ratio": summary_dict.get("zero_downtime_ratio"),
            "sla_compliance": summary_dict.get("sla_compliance"),
            "sla_compliance_ratio": summary_dict.get("sla_compliance_ratio"),
            "coverage_ratio": summary_dict.get("coverage_ratio"),
            "per_server": summary_dict["per_server"],
            "lowest_availability": lowest_availability,
            "hosts_requiring_attention": lowest_availability,
            "entries": summary_dict["per_server"]["values"],
            "targets": {e["id"]: e["availability_pct"] for e in summary_dict["per_server"]["values"]},
            "analytics": summary_dict.get("analytics", {}),
            "trend": trend_series,
            "trend_incidents": trend_incidents or [],
            "trend_end_ts": int(req_end),
            "trend_start_ts": int(req_end - query.minutes * 60.0),
            "trend_bucket_seconds": trend_slot_sec,
            # Threshold behind null (partial-coverage) trend points, for the tooltip.
            "trend_min_reporting_pct": round(AVAIL_TREND_MIN_REPORTING_RATIO * 100.0, 1),
            "source": source,
            "_trace": trace_data,
        }

    def _build_empty_payload(self, query: AvailabilityQuery, req_end: float, empty_summary: Dict[str, Any]) -> Dict[str, Any]:
        return {
            "ok": True,
            "job": query.job,
            "period_minutes": round(query.minutes, 2),
            "requested_window_seconds": round(query.minutes * 60.0, 1),
            "coverage_seconds": 0.0,
            "unknown_seconds": round(query.minutes * 60.0, 1),
            "sqlite_seconds": 0.0,
            "prometheus_seconds": 0.0,
            "overlap_removed_seconds": 0.0,
            "coverage_percent": 0.0,
            "availability_percent": None,
            "data_status": "NO_DATA",
            "end": query.end_ts,
            "counts": {
                "total": 0,
                "scored": 0,
                "eligible": 0,
                "online": 0,
                "warning": 0,
                "offline": 0,
                "removed": 0,
            },
            "overall": None,
            "sla": sla_budget(0.0, 0.0, query.sla_target_pct, query.minutes * 60.0, query.sla_days),
            "fleet_aggregate": empty_summary["fleet_aggregate"],
            "fleet_average": empty_summary["fleet_average"],
            "health_ratio": empty_summary["health_ratio"],
            "zero_downtime_ratio": empty_summary.get("zero_downtime_ratio"),
            "sla_compliance": empty_summary.get("sla_compliance"),
            "sla_compliance_ratio": empty_summary.get("sla_compliance_ratio"),
            "coverage_ratio": empty_summary.get("coverage_ratio"),
            "per_server": empty_summary["per_server"],
            "lowest_availability": [],
            "hosts_requiring_attention": [],
            "entries": [],
            "targets": {},
            "analytics": empty_summary.get("analytics", {}),
            "trend": [],
            "trend_end_ts": int(req_end),
            "trend_start_ts": int(req_end - query.minutes * 60.0),
            "trend_bucket_seconds": 3600,
            "daily": [],
            "source": "nodata",
        }

    def _materialize_depth_chunk(
        self, w_start: float, w_end: float, monitored: List[str],
        instance_job_map: Dict[str, str], source: str, curr_time: float,
    ) -> Tuple[List[Dict[str, Any]], bool, Dict[str, int]]:
        """Bucket rows for one depth chunk, fetching raw samples only where needed.

        Per hour and host, changes/min/max/count_over_time classify the hour:
        constant value with no gap over the reconstruction tolerance is written
        straight from the aggregates (_stable_hour_record — identical to what
        the raw path reconstructs); anything else (flapping, gaps, partial
        data) gets that host's raw TSDB samples for just those hours, so short
        outages keep their exact edges. Hosts already complete are skipped.

        Returns (rows, complete, stats). complete=False means a fetch failed:
        the rows hold only what could be built and the caller retries.
        """
        stats = {"hosts": 0, "stable_hours": 0, "raw_hours": 0, "raw_requests": 0, "raw_samples": 0}
        h_start = math.floor(w_start / 3600.0) * 3600.0
        h_end = min(math.ceil(w_end / 3600.0) * 3600.0, math.floor(curr_time / 3600.0) * 3600.0)
        hours = [h_start + 3600.0 * k for k in range(max(0, int(round((h_end - h_start) / 3600.0))))]
        if not hours:
            return [], True, stats
        try:
            have = self.bucket_repo.get_materialized_instance_hours(h_start, h_end, source=source)
        except Exception:
            have = {}
        todo = [i for i in monitored if len(have.get(i, ())) < len(hours)]
        stats["hosts"] = len(todo)
        if not todo:
            return [], True, stats

        # Per-hour aggregates, evaluated at each hour's END. [3601s], not [1h]:
        # a range selector is (t-r, t] (Prometheus 3) or [t-r, t] (2.x), and the
        # extra second makes sure the hour's own first sample is inside either
        # way. Overlap can only make an hour look like it changed -> raw fetch.
        span = dict(start_ts=h_start + 3600.0, end_ts=h_end, step_sec=3600, timeout=30.0,
                    source=source, prefer_job=instance_job_map)
        queries = {}
        for m in ("probe_success", "up"):
            queries[(m, "changes")] = (f"changes({m}[3601s])", span)
            queries[(m, "min")] = (f"min_over_time({m}[3601s])", span)
            queries[(m, "max")] = (f"max_over_time({m}[3601s])", span)
            # Evaluated 1ms before the hour's end: (cur_h - 1ms, nxt_h - 1ms]
            # is exactly the bucket's [cur_h, nxt_h) at ms resolution.
            queries[(m, "count")] = (f"count_over_time({m}[3600s])",
                                     dict(span, start_ts=h_start + 3599.999, end_ts=h_end - 0.001))
            # Last sample before each hour (5m lookback): carried-in state.
            queries[(m, "lead")] = (m, dict(span, start_ts=h_start - 0.001, end_ts=h_end - 3600.001))
        queries[("probe_success", "latency")] = ("avg_over_time(probe_duration_seconds[1h]) * 1000", span)

        executor = getattr(self.prom_client, "_SHARED_EXECUTOR", None)
        fetch = self.prom_queries.fetch_prom_matrix_map
        res: Dict[Tuple[str, str], Any] = {}
        if executor:
            futs = {k: executor.submit(fetch, q, **kw) for k, (q, kw) in queries.items()}
            for k, f in futs.items():
                try:
                    res[k] = f.result()
                except Exception:
                    res[k] = None
        else:
            for k, (q, kw) in queries.items():
                try:
                    res[k] = fetch(q, **kw)
                except Exception:
                    res[k] = None
        if any(v is None for k, v in res.items() if k[1] != "latency"):
            return [], False, stats
        latency_map = res.get(("probe_success", "latency")) or {}

        def val(m, kind, inst, ts):
            return (res[(m, kind)].get(inst) or {}).get(round(ts, 3))

        def latency_at(inst, t):
            v = (latency_map.get(inst) or {}).get(round(t, 3))
            return round(v, 1) if v is not None else 0.0

        rows: List[Dict[str, Any]] = []
        raw_spans: List[Tuple[str, str, List[float], float]] = []
        span_h = max(1, int(AVAIL_BACKFILL_RAW_SPAN_SECONDS // 3600))
        for inst in todo:
            job = instance_job_map.get(inst, "blackbox")
            done = have.get(inst, set())
            # Same routing as derive_bucket_inputs: the probe series when the
            # host has one in this chunk, else its `up` series.
            m = "probe_success" if res[("probe_success", "count")].get(inst) else "up"
            counts = {h: val(m, "count", inst, h + 3599.999) or 0.0 for h in hours}
            dense = max(counts.values())
            if dense <= 0:
                # No sample for this host anywhere in the chunk: the row the
                # scalar path writes for "no data" (an unknown hour).
                for h in hours:
                    if h not in done:
                        rows.append({
                            "instance": inst, "job": job, "bucket_start": h, "bucket_end": h + 3600.0,
                            "uptime_seconds": 0.0, "downtime_seconds": 0.0, "unknown_seconds": 3600.0,
                            "coverage_seconds": 0.0, "sample_count": 0, "availability_pct": None,
                            "incident_count": 0, "avg_latency_ms": 0.0, "updated_at": curr_time,
                        })
                continue
            cad = 3600.0 / dense
            need_raw: List[float] = []
            for h in hours:
                if h in done:
                    continue
                t = h + 3600.0
                ch, mn, mx = val(m, "changes", inst, t), val(m, "min", inst, t), val(m, "max", inst, t)
                c = counts[h]
                # Complete = at most 1 sample short of the chunk's densest hour.
                # A gap-free hour holds n or n+1 samples depending on scrape
                # phase, so this allows at most one missing sample: a ~2x
                # cadence gap, under the 3x reconstruction tolerance, so no
                # second of the hour is unknown. (-2 let jittered double
                # misses through: measured 12-37s of unknown booked as up.)
                complete = c >= 2 and c >= dense - 1
                stable = ch == 0 and mn is not None and mn == mx and mn in (0.0, 1.0)
                if complete and stable:
                    lead = val(m, "lead", inst, h - 0.001)
                    rows.append(_stable_hour_record(
                        inst, job, h, int(mn), c, lead == 0, latency_at(inst, t), curr_time))
                    stats["stable_hours"] += 1
                else:
                    need_raw.append(h)
            # Contiguous raw hours per request, capped to bound the payload.
            group: List[float] = []
            for h in need_raw + [None]:
                if group and (h is None or h != group[-1] + 3600.0 or len(group) >= span_h):
                    raw_spans.append((inst, m, group, cad))
                    group = []
                if h is not None:
                    group.append(h)

        # Hosts needing the same hours share one request (up to
        # AVAIL_BACKFILL_RAW_BATCH): same samples, far fewer round trips.
        by_span: Dict[Tuple[str, Tuple[float, ...]], List[Tuple[str, float]]] = {}
        for inst, m, group, cad in raw_spans:
            by_span.setdefault((m, tuple(group)), []).append((inst, cad))
        batches = []
        for (m, group), members in by_span.items():
            step = max(1, AVAIL_BACKFILL_RAW_BATCH)
            for i in range(0, len(members), step):
                batches.append((m, list(group), members[i:i + step]))

        def fetch_raw(m, group, members):
            names = [inst for inst, _ in members]
            if len(names) == 1:
                matcher = 'instance="%s"' % _promql_str(names[0])
            else:
                matcher = 'instance=~"^(?:%s)$"' % "|".join(_promql_str(re.escape(n)) for n in names)
            return self.prom_queries.fetch_prom_range_map(
                "%s{%s}" % (m, matcher), group[0], group[-1] + 3600.0, RAW_LEAD_IN_SECONDS,
                cache_ttl=0.0, timeout=30.0, source=source, prefer_job=instance_job_map, strict=True)

        got = []
        if executor:
            # A few at a time: the pool is shared with the API, and hundreds
            # of queued raw fetches (a bad day) would stall every UI query.
            n = max(1, AVAIL_BACKFILL_RAW_CONCURRENCY)
            for i in range(0, len(batches), n):
                futs = [(b, executor.submit(fetch_raw, *b)) for b in batches[i:i + n]]
                for b, f in futs:
                    try:
                        got.append((b, f.result()))
                    except Exception:
                        got.append((b, None))
        else:
            for b in batches:
                try:
                    got.append((b, fetch_raw(*b)))
                except Exception:
                    got.append((b, None))
        complete = True
        for (m, group, members), rmap in got:
            stats["raw_requests"] += 1
            if rmap is None:
                complete = False
                continue
            for inst, cad in members:
                samples = rmap.get(inst) or []
                stats["raw_samples"] += len(samples)
                sample_ts = [ts for ts, _ in samples]
                job = instance_job_map.get(inst, "blackbox")
                for h in group:
                    # Cadence as the head path (and the old 1h-chunk backfill)
                    # estimates it: this hour's own span / (samples - 1). A
                    # chunk-wide 3600/densest-hour count moves the 3x gap
                    # tolerance and booked up to ~170s/hour differently.
                    lo = bisect.bisect_left(sample_ts, h)
                    hi = bisect.bisect_left(sample_ts, h + 3600.0)
                    span = sample_ts[hi - 1] - sample_ts[lo] if hi - lo >= 2 else 0.0
                    h_cad = span / (hi - lo - 1) if span > 0 else cad
                    rows.append(_raw_hour_record(
                        inst, job, samples, sample_ts, h, curr_time, h_cad, latency_at(inst, h + 3600.0)))
                    stats["raw_hours"] += 1
        return rows, complete, stats

    @staticmethod
    def _is_under_materialized(
        span: Optional[Tuple[float, int]], hour_end: float, floor_start: float
    ) -> bool:
        """Does this instance's bucket history still need backfilling?

        Two ways it can: the history doesn't reach the retention floor, or it
        has holes inside the span it does cover. The hole test is what catches
        an aggregator outage — the forward pass only ever repairs the trailing
        hours, so a gap in the middle is otherwise invisible and permanent.
        """
        if not span:
            return True
        min_start, hours = span
        # The walk stops once the cursor crosses the floor, so the earliest
        # bucket legitimately sits up to one chunk above it — and retention
        # pruning keeps nudging it further as time passes. Anything inside that
        # margin is "as deep as it gets", not shallow.
        if min_start > floor_start + AVAIL_BACKFILL_CHUNK_SECONDS + 3600.0:
            return True
        expected_hours = max(1.0, (hour_end - min_start) / 3600.0)
        # One hour of slack for the newest, still-aggregating hour. The old 5%
        # slack hid up to ~42h of holes per host over 35d. A target briefly
        # absent from Prometheus doesn't leave a hole: the sweep writes an
        # (unknown-coverage) row for every monitored instance-hour.
        return hours < expected_hours - 1.0

    @staticmethod
    def _row_is_materialized(r: Dict[str, Any]) -> bool:
        """A stored hour counts as done unless it holds downtime without the
        per-host outage intervals (scalar fallback / pre-outage_json rows) —
        those are holes the sweep must re-fetch. Mirrors the SQL filter in
        AvailabilityBucketRepository.get_instance_bucket_coverage."""
        return not (float(r.get("downtime_seconds") or 0.0) > 0 and not r.get("outage_json"))

    def _chunk_materialized(self, monitored: List[str], start: float, end: float, source: str) -> bool:
        """True when EVERY monitored instance has every hour of [start, end)
        materialized. Per host, not a fleet-wide 95%: that let one host's hole
        hide behind 19 complete ones and never be swept."""
        try:
            counts = self.bucket_repo.get_materialized_hour_counts(monitored, start, end, source=source)
        except Exception:
            return False
        need = len(set(monitored))
        hours = int(round((end - start) / 3600.0))
        return all(counts.get(start + k * 3600.0, 0) >= need for k in range(hours))

    def _next_depth_backfill_window(
        self, monitored: List[str], now: float, source: str
    ) -> Optional[Tuple[float, float]]:
        """One chunk of *backward* backfill, or None when depth is satisfied.

        The incremental path only ever aggregates the trailing hour, so history
        older than the aggregator's first run is never materialized — which is
        why a fleet that Prometheus holds 30d of telemetry for rendered as "only
        1.7% of this window observed". This sweeps backwards to the retention
        floor, one chunk per cycle, whenever any monitored instance is missing
        depth or has a hole.

        Idempotent by construction (bucket writes are upserts), so re-walking a
        span that is already materialized is wasted work but never wrong.
        """
        hour_end = math.floor(now / 3600.0) * 3600.0
        floor_start = hour_end - (self._backfill_depth_sec or AVAIL_BACKFILL_SECONDS)

        cursor = self._deep_cursor
        if cursor is not None and cursor > floor_start:
            # A sweep is in flight. Never restart it on fleet churn: targets
            # flap constantly (a down host drops out of Prometheus and returns),
            # and keying the cursor on fleet membership reset it to the top on
            # every flap — so it rewrote the newest chunk forever and never
            # tiled downward. Progress must be monotonic.
            pass
        else:
            # Idle. A sweep that just reached the floor is committed only now —
            # recording it at START made a sweep whose chunks failed count as
            # done, and nothing ever retried it.
            if self._deep_sweep_pending is not None:
                self._deep_swept_stale = self._deep_sweep_pending
                self._deep_swept_at = now
                self._deep_sweep_pending = None
            # Only looked up when idle: ~1s over 60d, and a sweep in flight
            # doesn't need it (it was paid once per chunk before).
            try:
                # Only history inside the floor counts: older rows (kept by the
                # prune's 35d minimum while Prometheus retains less) can never be re-fetched, so
                # counting their gaps would re-trigger a useless sweep forever.
                coverage = self.bucket_repo.get_instance_bucket_coverage(monitored, source=source, since=floor_start)
            except Exception:
                logger.exception("Availability depth backfill: bucket coverage lookup failed")
                return None
            stale = frozenset(
                i for i in monitored
                if self._is_under_materialized(coverage.get(i), hour_end, floor_start)
            )
            # Anything still stale after the last completed sweep is most likely
            # stale because Prometheus has nothing there; re-sweeping it every
            # cycle would never terminate, so wait out a backoff — but retry
            # after it, since a transient failure looks exactly the same. A newly
            # monitored target is not a subset, so it starts one immediately.
            if not stale or (stale <= self._deep_swept_stale
                             and now - self._deep_swept_at < AVAIL_BACKFILL_RETRY_SECONDS):
                return None
            # Sweep from the top of the window, not from the thinnest instance's
            # earliest bucket: a *hole* (aggregator down for a stretch) sits
            # above that point, so starting there would walk straight past it.
            self._deep_sweep_pending = stale
            cursor = hour_end
            logger.info(
                "Availability depth backfill: starting sweep, %d/%d instances under-materialized",
                len(stale), len(monitored),
            )

        # Skip chunks every monitored instance already has buckets for. Without
        # this, each restart re-aggregated the whole materialized span from
        # Prometheus (~1.5 min per chunk) before reaching the missing history.
        # One query for the whole span: asking chunk by chunk cost ~0.3s each,
        # so a restart over 60d of history spent ~7 min before its first fetch.
        try:
            counts = self.bucket_repo.get_materialized_hour_counts(monitored, floor_start, cursor, source=source)
        except Exception:
            logger.exception("Availability depth backfill: materialized-hours lookup failed")
            counts = {}
        need = len(set(monitored))

        def chunk_done(lo, hi):
            return all(counts.get(lo + k * 3600.0, 0) >= need for k in range(int(round((hi - lo) / 3600.0))))

        chunk_start = max(floor_start, cursor - AVAIL_BACKFILL_CHUNK_SECONDS)
        while chunk_start > floor_start and chunk_done(chunk_start, cursor):
            cursor = chunk_start
            chunk_start = max(floor_start, cursor - AVAIL_BACKFILL_CHUNK_SECONDS)
        self._deep_cursor = chunk_start
        logger.info(
            "Availability depth backfill: [%.0f, %.0f], %.1fd remaining to floor",
            chunk_start, cursor, max(0.0, chunk_start - floor_start) / 86400.0,
        )
        return (chunk_start, cursor)

    @staticmethod
    def _availability_aggregation_windows(
        now: float,
        latest_end: Optional[float],
        max_lookback_sec: Optional[float] = None,
    ) -> List[Tuple[float, float]]:
        """Forward (head) aggregation windows: the recent span not yet rolled up.

        Depth is not this function's job — _next_depth_backfill_window walks
        backwards for that — so the lookback is capped rather than spanning the
        full retention period in a single cycle.
        """
        lookback = float(max_lookback_sec if max_lookback_sec is not None else AVAIL_HEAD_REPAIR_SECONDS)
        hour_end = math.floor(now / 3600.0) * 3600.0
        floor_start = hour_end - lookback

        # Steady state: already materialized through the last completed hour.
        if latest_end is not None and latest_end >= (hour_end - 3600.0):
            windows = [(hour_end - 3600.0, hour_end)]
            if now - hour_end >= 30.0:
                windows.append((hour_end, now))
            return windows

        # Cold start or an aggregator outage: repair forward from the watermark,
        # cost proportional to the gap, clamped to the lookback cap.
        cur_t = floor_start if latest_end is None else max(floor_start, math.floor(latest_end / 3600.0) * 3600.0)
        windows = []
        while cur_t < now:
            next_t = min(cur_t + 21600, now)
            windows.append((cur_t, next_t))
            cur_t = next_t
        return windows
