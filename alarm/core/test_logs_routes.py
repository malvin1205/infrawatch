"""/logs and /history: acker names only for signed-in users; /logs pages past
the old 200-row JSON cap. Run: python -m pytest alarm/core/test_logs_routes.py"""
import alarm.app as alarm_app
from alarm.storage.repositories.alerts import IncidentRepository, AcknowledgmentRepository

SRC = "http://prom-a:9090"


def _seed(n_events):
    for i in range(n_events):
        IncidentRepository.record_alert_event(
            name="TargetDown", severity="critical", instance="10.9.9.9", summary="s", job="blackbox",
            event_time=1000.0 + i, is_now_firing=(i % 2 == 0), source=SRC)
    AcknowledgmentRepository.acknowledge_instances(["10.9.9.9"], username="alice", now=5000.0)


def test_acker_name_hidden_from_anonymous_readers(monkeypatch):
    _seed(3)  # ends firing
    client = alarm_app.app.test_client()
    row = [r for r in client.get("/history?source=all").get_json() if r["instance"] == "10.9.9.9"][0]
    assert row["acknowledged_by"] == "operator" and row["acknowledged_at"]
    monkeypatch.setitem(alarm_app._redact_ackers.__globals__, "get_current_authenticated_user",
                        lambda: {"id": 1, "username": "t", "role": "admin"})
    row = [r for r in client.get("/history?source=all").get_json() if r["instance"] == "10.9.9.9"][0]
    assert row["acknowledged_by"] == "alice"


def test_logs_serve_more_than_the_old_cap():
    _seed(260)
    client = alarm_app.app.test_client()
    rows = client.get("/logs?limit=300").get_json()
    assert len(rows) > 200, len(rows)
    assert all("source" in r for r in rows)
