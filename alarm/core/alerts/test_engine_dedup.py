"""record_alert_event: SQLite decides what is a transition, not status.json.
Run: python -m pytest alarm/core/alerts/test_engine_dedup.py"""
import os
import tempfile
from unittest.mock import patch

from alarm.storage import json_store
from alarm.storage.schema import init_db
from alarm.storage.repositories.alerts import IncidentRepository
from alarm.core.alerts import engine

SRC = "http://prom-a:9090"


def _fresh():
    d = tempfile.mkdtemp()
    db = os.path.join(d, "t.db")
    init_db(db)
    files = {n: os.path.join(d, n + ".json") for n in ("status", "logs", "history", "archive")}
    return db, files


def _call(db, files, sent, **kw):
    real = IncidentRepository.record_alert_event
    args = dict(name="TargetDown", severity="critical", instance="10.0.0.1", summary="s", job="blackbox",
                key="TargetDown|10.0.0.1", source=SRC)
    args.update(kw)
    with patch.object(json_store, "STATUS_FILE", files["status"]), \
            patch.object(json_store, "LOGS_FILE", files["logs"]), \
            patch.object(json_store, "HISTORY_FILE", files["history"]), \
            patch.object(json_store, "HISTORY_ARCHIVE_FILE", files["archive"]), \
            patch.object(engine, "get_active_maintenance", lambda *a, **k: None), \
            patch.object(engine, "dispatch_alert_async", lambda **k: sent.append(k["is_now_firing"])), \
            patch.object(IncidentRepository, "record_alert_event", staticmethod(lambda **k: real(db_path=db, **k))):
        return engine.record_alert_event(**args)


def _status(files):
    return json_store.load_json(files["status"], {}).get("alerts", [])


def test_resolve_goes_through_when_the_cache_lost_the_firing_alert():
    db, files = _fresh()
    sent = []
    assert _call(db, files, sent, event_time=100.0, is_now_firing=True)
    json_store.save_json(files["status"], {"status": "NORMAL", "alerts": []})  # cache restored/reset
    assert _call(db, files, sent, event_time=160.0, is_now_firing=False), "SQLite still firing -> real resolve"
    (row,) = IncidentRepository.get_history(source=SRC, db_path=db)
    assert row["status"] == "resolved" and row["duration_seconds"] == 60.0
    assert sent == [True, False]


def test_repeat_is_dropped_and_the_stale_cache_is_healed_without_telegram():
    db, files = _fresh()
    sent = []
    _call(db, files, sent, event_time=100.0, is_now_firing=True)
    json_store.save_json(files["status"], {"status": "NORMAL", "alerts": []})
    assert not _call(db, files, sent, event_time=130.0, is_now_firing=True), "already firing in SQLite"
    assert sent == [True], "no second 'went offline' message"
    assert [a["key"] for a in _status(files)] == ["TargetDown|10.0.0.1"], "cache healed from SQLite"


def test_same_alert_on_another_server_is_its_own_incident():
    db, files = _fresh()
    sent = []
    assert _call(db, files, sent, event_time=100.0, is_now_firing=True)
    assert _call(db, files, sent, event_time=110.0, is_now_firing=True, source="http://prom-b:9090")
    assert len(_status(files)) == 2
    assert _call(db, files, sent, event_time=150.0, is_now_firing=False)
    assert [a["source"] for a in _status(files)] == ["http://prom-b:9090"]


def test_cache_decides_only_when_sqlite_is_down():
    db, files = _fresh()
    sent = []
    broken = patch.object(IncidentRepository, "record_alert_event",
                          staticmethod(lambda **k: (_ for _ in ()).throw(RuntimeError("db locked"))))
    with patch.object(json_store, "STATUS_FILE", files["status"]), \
            patch.object(json_store, "LOGS_FILE", files["logs"]), \
            patch.object(json_store, "HISTORY_FILE", files["history"]), \
            patch.object(json_store, "HISTORY_ARCHIVE_FILE", files["archive"]), \
            patch.object(engine, "get_active_maintenance", lambda *a, **k: None), \
            patch.object(engine, "dispatch_alert_async", lambda **k: sent.append(k["is_now_firing"])), broken:
        ev = dict(name="TargetDown", severity="critical", instance="10.0.0.1", summary="s", job="blackbox",
                  key="TargetDown|10.0.0.1", source=SRC)
        assert engine.record_alert_event(event_time=1.0, is_now_firing=True, **ev)
        assert not engine.record_alert_event(event_time=2.0, is_now_firing=True, **ev)
    assert sent == [True]


def test_history_json_fallback_keeps_one_entry_per_key_like_sqlite():
    db, files = _fresh()
    sent = []
    for t0 in (100.0, 300.0):
        _call(db, files, sent, event_time=t0, is_now_firing=True)
        _call(db, files, sent, event_time=t0 + 60, is_now_firing=False)
    h = json_store.load_json(files["history"], [])
    assert len(h) == 1, h
    assert h[0]["occurrences"] == 2 and h[0]["total_down_seconds"] == 120.0 and h[0]["first_seen"] == 100.0
