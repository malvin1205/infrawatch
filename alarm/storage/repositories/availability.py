"""Availability buckets, leases, SLA targets, and latency threshold repositories for InfraWatch.
"""
import time
import json
import sqlite3
from typing import List, Dict, Any, Optional, Tuple

try:
    from alarm.storage.connection import db_read, db_transaction
except (ImportError, ValueError):
    from storage.connection import db_read, db_transaction
try:
    from config import AVAIL_TARGET_WHITELIST
except ImportError:
    from alarm.config import AVAIL_TARGET_WHITELIST

import logging
logger = logging.getLogger("infrawatch")


def norm_source(url: Optional[str]) -> str:
    """Canonical server identity for availability rows: the Prometheus base URL."""
    return (url or "").strip().rstrip("/")


_SOURCE_NON_MATCHING_CACHE: Dict[str, Tuple[float, bool]] = {}


def _source_allows_non_matching(source: Optional[str], wl) -> bool:
    norm = norm_source(source)
    if not norm:
        return False
    now = time.time()
    cached = _SOURCE_NON_MATCHING_CACHE.get(norm)
    if cached and (now - cached[0]) < 15.0:
        return cached[1]
    allows = False
    try:
        try:
            from core.monitoring.state import get_instance_job_map
        except (ImportError, ValueError):
            from alarm.core.monitoring.state import get_instance_job_map
        job_map = get_instance_job_map(None, include_alert_only=False, source=norm) or {}
        live_targets = list(job_map.keys())
        if live_targets and wl and not any(t in wl for t in live_targets):
            allows = True
    except Exception:
        allows = False
    _SOURCE_NON_MATCHING_CACHE[norm] = (now, allows)
    return allows


def _whitelisted(instance: Optional[str], whitelist=None, source: Optional[str] = None, allow_non_matching_source: bool = True) -> bool:
    wl = AVAIL_TARGET_WHITELIST if whitelist is None else whitelist
    if wl is None:
        return True
    if instance in wl:
        return True
    if allow_non_matching_source and source:
        if _source_allows_non_matching(source, wl):
            return True
    return False


class SlaTargetRepository:
    """Per-target SLA availability target (%). Absent -> the deployment
    default (SLA_TARGET_PCT env / SLA_COMPLIANCE_THRESHOLD) applies."""

    @staticmethod
    def get_all(db_path: Optional[str] = None) -> Dict[str, float]:
        with db_read(db_path) as conn:
            rows = conn.execute("SELECT instance, target_pct FROM sla_targets").fetchall()
            return {r["instance"]: float(r["target_pct"]) for r in rows}

    @staticmethod
    def get_target(instance: str, db_path: Optional[str] = None) -> Optional[float]:
        with db_read(db_path) as conn:
            row = conn.execute(
                "SELECT target_pct FROM sla_targets WHERE instance = ?", (instance,)
            ).fetchone()
            return float(row["target_pct"]) if row else None

    @staticmethod
    def set_target(instance: str, target_pct: float, updated_by: Optional[str] = None,
                   db_path: Optional[str] = None):
        pct = max(0.0, min(100.0, float(target_pct)))
        with db_transaction(db_path) as conn:
            conn.execute(
                """INSERT INTO sla_targets (instance, target_pct, updated_by, updated_at)
                   VALUES (?, ?, ?, ?)
                   ON CONFLICT(instance) DO UPDATE SET
                       target_pct = excluded.target_pct,
                       updated_by = excluded.updated_by,
                       updated_at = excluded.updated_at""",
                (instance, pct, updated_by, time.time()),
            )
        return pct

    @staticmethod
    def delete_target(instance: str, db_path: Optional[str] = None) -> bool:
        with db_transaction(db_path) as conn:
            cur = conn.execute("DELETE FROM sla_targets WHERE instance = ?", (instance,))
            return cur.rowcount > 0


class SlowThresholdRepository:
    """Per-instance SlowResponse threshold (ms). Absent -> the deployment
    default (DEFAULT_SLOW_RESPONSE_THRESHOLD_MS) applies — some targets
    (e.g. a naturally slower overseas endpoint) aren't actually degraded
    at the global default, they're just always like that."""

    @staticmethod
    def get_all(db_path: Optional[str] = None) -> Dict[str, float]:
        with db_read(db_path) as conn:
            rows = conn.execute("SELECT instance, threshold_ms FROM slow_thresholds").fetchall()
            return {r["instance"]: float(r["threshold_ms"]) for r in rows}

    @staticmethod
    def get_threshold(instance: str, db_path: Optional[str] = None) -> Optional[float]:
        with db_read(db_path) as conn:
            row = conn.execute(
                "SELECT threshold_ms FROM slow_thresholds WHERE instance = ?", (instance,)
            ).fetchone()
            return float(row["threshold_ms"]) if row else None

    @staticmethod
    def set_threshold(instance: str, threshold_ms: float, updated_by: Optional[str] = None,
                       db_path: Optional[str] = None):
        ms = max(0.0, float(threshold_ms))
        with db_transaction(db_path) as conn:
            conn.execute(
                """INSERT INTO slow_thresholds (instance, threshold_ms, updated_by, updated_at)
                   VALUES (?, ?, ?, ?)
                   ON CONFLICT(instance) DO UPDATE SET
                       threshold_ms = excluded.threshold_ms,
                       updated_by = excluded.updated_by,
                       updated_at = excluded.updated_at""",
                (instance, ms, updated_by, time.time()),
            )
        return ms

    @staticmethod
    def delete_threshold(instance: str, db_path: Optional[str] = None) -> bool:
        with db_transaction(db_path) as conn:
            cur = conn.execute("DELETE FROM slow_thresholds WHERE instance = ?", (instance,))
            return cur.rowcount > 0


class AvailabilityBucketRepository:
    @staticmethod
    def save_buckets(buckets: List[Dict[str, Any]], source: str, db_path: Optional[str] = None):
        """Upsert hourly rows produced by Prometheus server `source`.
        Non-whitelisted instances are dropped here — they never reach disk."""
        source = norm_source(source)
        if not source:
            raise ValueError("save_buckets: source (Prometheus server) is required")
        wl = AVAIL_TARGET_WHITELIST
        allows_all = (wl is None) or _source_allows_non_matching(source, wl)
        if not allows_all:
            wl_set = set(wl)
            rogue = sorted({b["instance"] for b in buckets if b.get("instance") not in wl_set})
            if rogue:
                logger.error("availability: refusing to store %d non-whitelisted instance(s) from %s: %s",
                             len(rogue), source, rogue[:20])
                buckets = [b for b in buckets if b.get("instance") in wl_set]
        if not buckets:
            return
        now = time.time()
        with db_transaction(db_path) as conn:
            conn.executemany("""
                INSERT INTO availability_buckets (
                    source, instance, job, bucket_start, bucket_end,
                    uptime_seconds, downtime_seconds, unknown_seconds, coverage_seconds,
                    sample_count, availability_pct, incident_count, avg_latency_ms, updated_at,
                    outage_json
                ) VALUES (
                    :source, :instance, :job, :bucket_start, :bucket_end,
                    :uptime_seconds, :downtime_seconds, :unknown_seconds, :coverage_seconds,
                    :sample_count, :availability_pct, :incident_count, :avg_latency_ms, :updated_at,
                    :outage_json
                )
                ON CONFLICT(source, job, instance, bucket_start) DO UPDATE SET
                    bucket_end = excluded.bucket_end,
                    uptime_seconds = excluded.uptime_seconds,
                    downtime_seconds = excluded.downtime_seconds,
                    unknown_seconds = excluded.unknown_seconds,
                    coverage_seconds = excluded.coverage_seconds,
                    sample_count = excluded.sample_count,
                    availability_pct = excluded.availability_pct,
                    incident_count = excluded.incident_count,
                    avg_latency_ms = excluded.avg_latency_ms,
                    updated_at = excluded.updated_at,
                    outage_json = CASE
                        WHEN excluded.outage_json IS NOT NULL AND excluded.outage_json != ''
                        THEN excluded.outage_json
                        ELSE availability_buckets.outage_json
                    END
                -- A zero-coverage re-aggregation (source Prometheus unreachable,
                -- failed over, or past its retention) means "no data now", not
                -- "this hour was never observed" — it must not erase an hour
                -- that was already materialized from real telemetry.
                WHERE excluded.coverage_seconds > 0 OR availability_buckets.coverage_seconds <= 0
            """, [
                {
                    "source": source,
                    "instance": b["instance"],
                    "job": b.get("job", "blackbox"),
                    "bucket_start": float(b["bucket_start"]),
                    "bucket_end": float(b["bucket_end"]),
                    "uptime_seconds": float(b.get("uptime_seconds", 0.0)),
                    "downtime_seconds": float(b.get("downtime_seconds", 0.0)),
                    "unknown_seconds": float(b.get("unknown_seconds", 0.0)),
                    "coverage_seconds": float(b.get("coverage_seconds", 0.0)),
                    "sample_count": int(b.get("sample_count", 0)),
                    "availability_pct": float(b["availability_pct"]) if b.get("availability_pct") is not None else None,
                    "incident_count": int(b.get("incident_count", 0)),
                    "avg_latency_ms": float(b.get("avg_latency_ms", 0.0)),
                    "updated_at": float(b.get("updated_at", now)),
                    "outage_json": b["outage_json"] if isinstance(b.get("outage_json"), str) else (
                        json.dumps(b["outage_json"]) if b.get("outage_json") is not None else None
                    ),
                }
                for b in buckets
            ])

    @staticmethod
    def get_bucket_records(
        job: str,
        start_time: float,
        end_time: float,
        instances: Optional[List[str]] = None,
        db_path: Optional[str] = None,
        *,
        source: str,
    ) -> List[Dict[str, Any]]:
        """Rows of ONE Prometheus server (`source`, required) for whitelisted
        instances only. There is deliberately no cross-server form."""
        source = norm_source(source)
        if not source:
            raise ValueError("get_bucket_records: source (Prometheus server) is required")
        with db_read(db_path) as conn:
            query = """
                SELECT id, source, instance, job, bucket_start, bucket_end,
                       uptime_seconds, downtime_seconds, unknown_seconds, coverage_seconds,
                       sample_count, availability_pct, incident_count, avg_latency_ms, updated_at,
                       outage_json
                FROM (
                    SELECT *,
                        ROW_NUMBER() OVER (
                            PARTITION BY instance, bucket_start
                            -- Real coverage first: a newer zero-coverage row
                            -- (another job label written while telemetry was
                            -- unreachable) must not shadow observed history.
                            ORDER BY (coverage_seconds > 0) DESC, updated_at DESC, id DESC
                        ) AS rn
                    FROM availability_buckets
                    WHERE source = ?
                      AND (
                          job = ?
                          OR ? = 'all'
                          OR (? = 'blackbox' AND (job LIKE 'blackbox%' OR job = 'blackbox_icmp' OR job LIKE 'blackbox-ping%'))
                          OR (? = 'node' AND (job LIKE 'node%' OR job = 'node_exporter' OR job = 'nodeexporter'))
                      )
                      AND bucket_end > ?
                      AND bucket_start < ?
            """
            params: List[Any] = [source, job, job, job, job, start_time, end_time]
            if instances:
                placeholders = ",".join("?" for _ in instances)
                query += f" AND instance IN ({placeholders})"
                params.extend(instances)
            query += """
                )
                WHERE rn = 1
                ORDER BY instance ASC, bucket_start ASC
            """
            rows = [dict(r) for r in conn.execute(query, params).fetchall()]
        # Hard guard: a result set for one server must never carry another's rows.
        foreign = {r["source"] for r in rows} - {source}
        if foreign:
            raise AssertionError(f"get_bucket_records({source!r}) returned rows from {sorted(foreign)}")
        wl = AVAIL_TARGET_WHITELIST
        if wl is None or _source_allows_non_matching(source, wl):
            return rows
        wl_set = set(wl)
        return [r for r in rows if r.get("instance") in wl_set]

    @staticmethod
    def get_latest_bucket_end(job: str = 'all', db_path: Optional[str] = None, *, source: str) -> Optional[float]:
        with db_read(db_path) as conn:
            row = conn.execute(
                """SELECT MAX(bucket_end) as max_end FROM availability_buckets
                   WHERE source = ? AND (
                       job = ?
                       OR ? = 'all'
                       OR (? = 'blackbox' AND (job LIKE 'blackbox%' OR job = 'blackbox_icmp' OR job LIKE 'blackbox-ping%'))
                       OR (? = 'node' AND (job LIKE 'node%' OR job = 'node_exporter' OR job = 'nodeexporter'))
                   )""",
                (norm_source(source), job, job, job, job)
            ).fetchone()
            return float(row["max_end"]) if row and row["max_end"] is not None else None

    @staticmethod
    def get_instance_bucket_coverage(
        instances: Optional[List[str]] = None, db_path: Optional[str] = None, *, source: str
    ) -> Dict[str, Tuple[float, int]]:
        """`{instance: (earliest_bucket_start, distinct_hours_materialized)}`.

        The pair is what the depth backfill needs to spot both ways history can
        be incomplete: a start that doesn't reach the retention floor (shallow),
        and an hour count short of the span it claims to cover (holes, e.g. the
        aggregator was down for a stretch).

        Hours are counted DISTINCT so an instance scraped by two jobs isn't
        credited twice. An instance absent from the map has no buckets at all.
        A fleet-wide aggregate would let one long-lived target hide every newer
        target's missing history, so this is deliberately per-instance.
        """
        # Past ~900 placeholders SQLite starts refusing the IN list, so filter
        # in Python instead of binding one parameter per instance.
        inline = bool(instances) and len(instances) <= 900
        with db_read(db_path) as conn:
            query = (
                "SELECT instance, MIN(bucket_start) AS min_start, "
                "COUNT(DISTINCT bucket_start) AS hours FROM availability_buckets WHERE source = ?"
            )
            params: List[Any] = [norm_source(source)]
            if inline:
                query += " AND instance IN (%s)" % ",".join("?" for _ in instances)
                params.extend(instances)
            query += " GROUP BY instance"
            rows = conn.execute(query, params).fetchall()

        wanted = None if inline or not instances else set(instances)
        return {
            r["instance"]: (float(r["min_start"]), int(r["hours"]))
            for r in rows
            if r["min_start"] is not None and (wanted is None or r["instance"] in wanted)
        }

    @staticmethod
    def prune_old_buckets(retention_seconds: float = 35 * 86400, db_path: Optional[str] = None) -> int:
        cutoff = time.time() - retention_seconds
        with db_transaction(db_path) as conn:
            cur = conn.execute("DELETE FROM availability_buckets WHERE bucket_end < ?", (cutoff,))
            return cur.rowcount

    @staticmethod
    def clear_all_buckets(db_path: Optional[str] = None):
        with db_transaction(db_path) as conn:
            conn.execute("DELETE FROM availability_buckets")


class AggregationLeaseRepository:
    @staticmethod
    def acquire_or_renew(lease_name: str, owner_id: str, ttl_sec: float = 30.0, db_path: Optional[str] = None) -> bool:
        now = time.time()
        with db_transaction(db_path) as conn:
            cur = conn.execute("""
                UPDATE aggregation_leases
                SET owner_id = ?, acquired_at = ?, expires_at = ?
                WHERE lease_name = ? AND (expires_at < ? OR owner_id = ?)
            """, (owner_id, now, now + ttl_sec, lease_name, now, owner_id))
            if cur.rowcount > 0:
                return True
            try:
                conn.execute("""
                    INSERT INTO aggregation_leases (lease_name, owner_id, acquired_at, expires_at)
                    VALUES (?, ?, ?, ?)
                """, (lease_name, owner_id, now, now + ttl_sec))
                return True
            except sqlite3.IntegrityError:
                return False

    @staticmethod
    def release(lease_name: str, owner_id: str, db_path: Optional[str] = None):
        with db_transaction(db_path) as conn:
            conn.execute("DELETE FROM aggregation_leases WHERE lease_name = ? AND owner_id = ?", (lease_name, owner_id))
