"""Self-checks for availability bucket storage:

1. A zero-coverage (no data) bucket never erases or shadows an hour already
   materialized from real telemetry.
2. Per-server isolation: a result set for server A never contains a row from
   server B (or a legacy row of unknown origin), even for the same instance.
3. Whitelist: non-whitelisted instances are refused on write and dropped on read.

Run: python -m alarm.storage.test_bucket_no_data_overwrite
"""
import os
import sqlite3
import tempfile
from unittest.mock import patch

from alarm.storage.schema import init_db
from alarm.storage.repositories import availability as repo_mod
from alarm.storage.repositories.availability import AvailabilityBucketRepository as Repo

H = 3600.0
A, B = "http://prom-a:9090", "http://prom-b:9090"


def row(job, cov, up, updated, inst="h1"):
    return {"instance": inst, "job": job, "bucket_start": 0.0, "bucket_end": H,
            "uptime_seconds": up, "downtime_seconds": cov - up, "unknown_seconds": H - cov,
            "coverage_seconds": cov, "sample_count": 120 if cov else 0,
            "availability_pct": (up / cov * 100.0) if cov else None, "updated_at": updated}


def _db():
    db = os.path.join(tempfile.mkdtemp(), "t.db")
    init_db(db)
    return db


def test_no_data_never_masks_real_hour():
    db = _db()
    with patch.object(repo_mod, "AVAIL_TARGET_WHITELIST", None):
        Repo.save_buckets([row("ping", H, H, 1.0)], A, db_path=db)
        Repo.save_buckets([row("ping", 0.0, 0.0, 2.0)], A, db_path=db)       # same job, no data
        Repo.save_buckets([row("blackbox", 0.0, 0.0, 3.0)], A, db_path=db)   # other job, no data, newer
        recs = Repo.get_bucket_records("all", 0.0, H, db_path=db, source=A)
        assert len(recs) == 1 and recs[0]["job"] == "ping" and recs[0]["coverage_seconds"] == H, recs
        Repo.save_buckets([row("ping", H, 1800.0, 4.0)], A, db_path=db)      # real replaces real
        recs = Repo.get_bucket_records("all", 0.0, H, db_path=db, source=A)
        assert recs[0]["uptime_seconds"] == 1800.0, recs


def test_server_a_never_sees_server_b_rows():
    db = _db()
    with patch.object(repo_mod, "AVAIL_TARGET_WHITELIST", None):
        Repo.save_buckets([row("icmp", H, H, 1.0)], A, db_path=db)          # A: h1 up
        Repo.save_buckets([row("icmp", H, 0.0, 9.0)], B, db_path=db)        # B: same h1, down, newer
        with sqlite3.connect(db) as c:                                       # legacy row, origin unknown
            c.execute("INSERT INTO availability_buckets (source, instance, job, bucket_start, bucket_end,"
                      " coverage_seconds, uptime_seconds, updated_at) VALUES ('', 'h1', 'legacy', 0, 3600, 3600, 0, 99)")
        ra = Repo.get_bucket_records("all", 0.0, H, db_path=db, source=A)
        rb = Repo.get_bucket_records("all", 0.0, H, db_path=db, source=B + "/")  # trailing slash normalized
        assert {r["source"] for r in ra} == {A} and ra[0]["uptime_seconds"] == H, ra
        assert {r["source"] for r in rb} == {B} and rb[0]["uptime_seconds"] == 0.0, rb
        assert Repo.get_latest_bucket_end(source=A, db_path=db) == H
        assert set(Repo.get_instance_bucket_coverage(["h1"], db_path=db, source=A)) == {"h1"}
        assert Repo.get_instance_bucket_coverage(["h1"], db_path=db, source="http://prom-c:9090") == {}
        for bad in ("", None):
            try:
                Repo.get_bucket_records("all", 0.0, H, db_path=db, source=bad)
                raise AssertionError("unscoped read must be refused")
            except ValueError:
                pass


def test_non_whitelisted_refused_on_write_and_read():
    db = _db()
    with patch.object(repo_mod, "AVAIL_TARGET_WHITELIST", None):
        Repo.save_buckets([row("icmp", H, H, 1.0, inst="rogue")], A, db_path=db)   # pre-existing rogue row
    with patch.object(repo_mod, "AVAIL_TARGET_WHITELIST", frozenset({"8.8.8.8"})):
        Repo.save_buckets([row("icmp", H, H, 2.0, inst="8.8.8.8"), row("icmp", H, H, 2.0, inst="10.9.9.9")], A, db_path=db)
        recs = Repo.get_bucket_records("all", 0.0, H, db_path=db, source=A)
        assert [r["instance"] for r in recs] == ["8.8.8.8"], recs
    with sqlite3.connect(db) as c:
        assert c.execute("SELECT COUNT(*) FROM availability_buckets WHERE instance='10.9.9.9'").fetchone()[0] == 0


def test_whitelist_loader_fails_closed():
    from alarm.config import load_target_whitelist
    d = tempfile.mkdtemp()
    empty, bad = os.path.join(d, "empty.txt"), os.path.join(d, "bad.txt")
    open(empty, "w").close()
    open(bad, "w").write("8.8.8.8;1.1.1.1\n!!garbage entry\n9.9.9.9 # ok\nnode_exporter:9100\n")
    assert load_target_whitelist(os.path.join(d, "missing.txt")) == frozenset()
    assert load_target_whitelist(empty) == frozenset()
    assert load_target_whitelist(bad) == frozenset({"9.9.9.9", "node_exporter:9100"})
    assert load_target_whitelist("none") is None


if __name__ == "__main__":
    for name, fn in list(globals().items()):
        if name.startswith("test_") and callable(fn):
            fn()
            print("ok ", name)
    print("all checks passed")
