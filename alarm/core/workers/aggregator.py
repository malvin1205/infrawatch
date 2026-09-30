"""AvailabilityAggregator: background worker responsible for periodic hourly
availability bucket rollups and retention pruning under an elected lease.
"""
import logging
import os
import threading
import time
from typing import Optional, Dict, Any

try:
    from core.availability import availability_engine
    from storage import AggregationLeaseRepository, AvailabilityBucketRepository
except (ImportError, ValueError):
    from alarm.core.availability import availability_engine
    from alarm.storage import AggregationLeaseRepository, AvailabilityBucketRepository

logger = logging.getLogger("infrawatch.aggregator")

_AVAIL_AGGREGATOR_WORKER_ID = f"worker-{os.getpid()}"
AVAIL_AGGREGATE_INTERVAL_SECONDS = float(os.environ.get("AVAIL_AGGREGATE_INTERVAL", "60.0"))
AVAIL_BUCKET_RETENTION_SECONDS = int(os.environ.get("AVAIL_BUCKET_RETENTION_SECONDS", str(35 * 86400)))


class AvailabilityAggregator:
    """Encapsulates the availability aggregation lease, loop, and health monitoring."""

    def __init__(
        self,
        engine=None,
        lease_repo=None,
        bucket_repo=None,
        worker_id: Optional[str] = None,
        interval_sec: Optional[float] = None,
        retention_sec: Optional[int] = None,
        last_tick_ref: Optional[list] = None,
    ):
        self.engine = engine or availability_engine
        self.lease_repo = lease_repo or AggregationLeaseRepository
        self.bucket_repo = bucket_repo or AvailabilityBucketRepository
        self.worker_id = worker_id or _AVAIL_AGGREGATOR_WORKER_ID
        self.interval_sec = interval_sec if interval_sec is not None else AVAIL_AGGREGATE_INTERVAL_SECONDS
        self.retention_sec = retention_sec if retention_sec is not None else AVAIL_BUCKET_RETENTION_SECONDS
        self._last_tick_ref = last_tick_ref

        self._last_tick = 0.0
        self._stop_event = threading.Event()
        self._thread: Optional[threading.Thread] = None
        self._started = False

    def aggregate_once(self, now: Optional[float] = None) -> int:
        """Execute one aggregation cycle if elected leader. Returns count of upserted buckets."""
        curr_time = now if now is not None else time.time()
        self._last_tick = curr_time
        if self._last_tick_ref is not None:
            self._last_tick_ref[0] = curr_time

        is_leader = False
        try:
            is_leader = self.lease_repo.acquire_or_renew(
                lease_name="avail_aggregator",
                owner_id=self.worker_id,
                ttl_sec=self.interval_sec * 2.5,
            )
        except Exception:
            logger.exception("Availability aggregator: lease acquisition failed")
            return 0

        if not is_leader:
            return 0

        upserted = 0
        try:
            upserted = self.engine.aggregate_hourly_buckets(now=curr_time)
        except Exception:
            logger.exception("Availability aggregator: aggregate_hourly_buckets failed")

        try:
            self._prune()
        except Exception:
            logger.exception("Availability aggregator: prune_old_buckets failed")

        return upserted

    def _prune(self) -> None:
        """Per server: keep buckets for as long as that server's Prometheus
        retains data (what backfill fills to), never less than retention_sec.
        One global 35d cutoff deleted the 35-60d a 60d-retention server had
        just been backfilled with, every cycle. A server whose retention can't
        be read right now is skipped, not pruned on a guess.
        ponytail: a server that is never reachable again keeps its rows
        forever; prune it by hand (or delete the endpoint) if that matters."""
        for src in self.bucket_repo.list_sources():
            if src and not self.engine._prom_retention_seconds(src):
                continue
            depth = self.engine._backfill_depth(src) if src else 0.0
            self.bucket_repo.prune_old_buckets(max(self.retention_sec, depth), source=src)

    def get_health(self, now: Optional[float] = None) -> Dict[str, Any]:
        """Compute and return health status dictionary for /health reporting."""
        curr_time = now if now is not None else time.time()
        enabled = (
            os.environ.get("DISABLE_AVAILABILITY_AGGREGATOR") != "1"
            and os.environ.get("DISABLE_ALERT_POLLER") != "1"
        )
        tick_age = (curr_time - self._last_tick) if self._last_tick > 0.0 else None
        is_ok = not enabled or (tick_age is not None and tick_age < self.interval_sec * 3)

        return {
            "ok": is_ok,
            "last_tick_seconds_ago": round(tick_age, 1) if tick_age is not None else None,
            "enabled": enabled,
        }

    def start(self) -> bool:
        """Start the background aggregator daemon thread."""
        if self._started:
            return False
        self._started = True
        self._stop_event.clear()

        def _loop():
            while not self._stop_event.is_set():
                try:
                    self.aggregate_once()
                except Exception as e:
                    logger.error(f"Availability aggregator error: {e}", exc_info=True)
                self._stop_event.wait(self.interval_sec)

        self._thread = threading.Thread(target=_loop, name="availability-aggregator", daemon=True)
        self._thread.start()
        logger.info(f"Availability aggregator started (interval: {self.interval_sec}s)")
        return True

    def stop(self) -> None:
        """Stop the background aggregator daemon thread."""
        self._stop_event.set()
        self._started = False


# Module-level defaults and compatibility re-exports
_LAST_AGGREGATOR_TICK = [0.0]
availability_aggregator = AvailabilityAggregator(last_tick_ref=_LAST_AGGREGATOR_TICK)


def _availability_aggregation_windows(now, latest_end):
    """Backward compatibility wrapper delegating to availability_engine."""
    return availability_engine._availability_aggregation_windows(now, latest_end)


def _aggregate_availability_cycle():
    """Backward compatibility entry point for a single aggregation cycle."""
    return availability_aggregator.aggregate_once()


def start_availability_aggregator():
    """Backward compatibility entry point to launch the aggregator background thread."""
    return availability_aggregator.start()
