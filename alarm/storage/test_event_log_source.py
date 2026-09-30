"""event_logs.source: migrated onto an existing DB and used to scope /logs.
Run: python -m pytest alarm/storage/test_event_log_source.py"""
import os
import sqlite3
import tempfile

from alarm.storage.schema import init_db
from alarm.storage.repositories.alerts import EventLogRepository, IncidentRepository


def test_old_db_gets_the_column_backfilled_from_incidents():
    db = os.path.join(tempfile.mkdtemp(), "t.db")
    init_db(db)
    c = sqlite3.connect(db)
    # Recreate the pre-migration table (no source column) with one old row.
    c.executescript("""
        DROP TABLE event_logs;
        CREATE TABLE event_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, event TEXT NOT NULL, name TEXT NOT NULL,
            severity TEXT NOT NULL, instance TEXT NOT NULL, summary TEXT, job TEXT, time REAL NOT NULL,
            duration_seconds REAL, latency_ms REAL, fingerprint TEXT);
        INSERT INTO event_logs (event, name, severity, instance, time, fingerprint)
            VALUES ('firing', 'TargetDown', 'critical', '10.0.0.1', 100, 'TargetDown|10.0.0.1');
        INSERT INTO incidents (source, key, fingerprint, name, severity, instance, status, started_at, updated_at)
            VALUES ('http://prom-a:9090', 'TargetDown|10.0.0.1', 'TargetDown|10.0.0.1', 'TargetDown', 'critical',
                    '10.0.0.1', 'firing', 100, 100);
        PRAGMA user_version = 0;
    """)
    c.commit()
    c.close()
    init_db(db)
    (row,) = EventLogRepository.get_logs(db_path=db)
    assert row["source"] == "http://prom-a:9090" and row["key"] == "TargetDown|10.0.0.1"


def test_logs_are_written_with_and_filtered_by_source():
    db = os.path.join(tempfile.mkdtemp(), "t.db")
    init_db(db)
    for src, t in (("http://prom-a:9090", 100.0), ("http://prom-b:9090", 110.0)):
        IncidentRepository.record_alert_event(name="TargetDown", severity="critical", instance="10.0.0.1",
                                              summary="s", job="blackbox", event_time=t, is_now_firing=True,
                                              source=src, db_path=db)
    assert len(EventLogRepository.get_logs(db_path=db)) == 2
    (b,) = EventLogRepository.get_logs(source="http://prom-b:9090/", db_path=db)
    assert b["source"] == "http://prom-b:9090" and b["time"] == 110.0
    assert EventLogRepository.RETENTION_LIMIT == 5000
