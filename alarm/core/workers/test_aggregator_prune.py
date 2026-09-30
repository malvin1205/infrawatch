"""Prune keeps each server's buckets as long as its own Prometheus retention
(never less than the configured floor), instead of one global 35d cutoff that
deleted a 60d server's backfilled history every cycle.

Run: python -m pytest alarm/core/workers/test_aggregator_prune.py
"""
import os
import tempfile
import time
from functools import partial

from alarm.core.workers.aggregator import AvailabilityAggregator
from alarm.storage.connection import db_transaction
from alarm.storage.repositories.availability import AvailabilityBucketRepository as Repo
from alarm.storage.schema import init_db

DAY = 86400.0
LONG, SHORT, DOWN = "http://long:9090", "http://short:9090", "http://down:9090"
RETENTION = {LONG: 60 * DAY, SHORT: 15 * DAY, DOWN: None}  # DOWN: unreachable right now


class Engine:
    @staticmethod
    def _prom_retention_seconds(src):
        return RETENTION[src]

    @staticmethod
    def _backfill_depth(src):
        return RETENTION[src] or 35 * DAY


class BoundRepo:
    def __init__(self, db):
        self.list_sources = partial(Repo.list_sources, db_path=db)
        self.prune_old_buckets = partial(Repo.prune_old_buckets, db_path=db)


def test_prune_follows_each_servers_retention():
    db = os.path.join(tempfile.mkdtemp(), "t.db")
    init_db(db)
    now = time.time()
    with db_transaction(db) as conn:
        for src in (LONG, SHORT, DOWN, ""):
            for age_days in (10, 30, 50, 70):
                end = now - age_days * DAY
                conn.execute(
                    "INSERT INTO availability_buckets (source, instance, job, bucket_start, bucket_end, uptime_seconds,"
                    " downtime_seconds, unknown_seconds, coverage_seconds, sample_count, availability_pct,"
                    " incident_count, updated_at) VALUES (?, 'h1', 'j', ?, ?, 3600, 0, 0, 3600, 1, 100, 0, ?)",
                    (src, end - 3600, end, now))

    AvailabilityAggregator(engine=Engine, bucket_repo=BoundRepo(db), retention_sec=int(35 * DAY))._prune()

    with db_transaction(db) as conn:
        kept = {}
        for r in conn.execute("SELECT source, bucket_end FROM availability_buckets"):
            kept.setdefault(r["source"], []).append(round((now - r["bucket_end"]) / DAY))
    assert sorted(kept[LONG]) == [10, 30, 50], kept      # 60d retention
    assert sorted(kept[SHORT]) == [10, 30], kept          # 15d retention, 35d floor
    assert sorted(kept[""]) == [10, 30], kept             # legacy rows: floor only
    assert sorted(kept[DOWN]) == [10, 30, 50, 70], kept   # retention unknown: not pruned on a guess
