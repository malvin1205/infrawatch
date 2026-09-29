"""Poller alerts carry the target's real Prometheus job, so Incident History's
and the Live Alert Log's job filters (and job-scoped maintenance) work.

Run: python -m pytest alarm/core/workers/test_alert_job.py
"""
import os
import sys
import tempfile
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))

from core.workers.poller import TargetPoller  # noqa: E402
from storage.schema import init_db  # noqa: E402
from storage.repositories.alerts import EventLogRepository, IncidentRepository  # noqa: E402


class State:
    def get_monitored_instances(self):
        return ["10.0.0.1", "10.0.0.2"]

    get_scraped_instances = get_monitored_instances

    def get_instance_job_map(self):
        return {"10.0.0.1": "blackbox-ping-internal"}  # 10.0.0.2: job unknown


class Queries:
    def fetch_all_probe_metrics(self, **_):
        return {"10.0.0.1": "0", "10.0.0.2": "0"}, {}, {}

    def fetch_down_since_prom_map(self):
        return {"10.0.0.1": time.time() - 3600, "10.0.0.2": time.time() - 3600}


class NoSlowThresholds:
    @staticmethod
    def get_all():
        return {}


def test_poller_alert_uses_target_job():
    sent = []
    TargetPoller(
        query_adapter=Queries(), state_adapter=State(),
        alert_sink=lambda **kw: sent.append((kw["instance"], kw["job"])),
        active_incident_provider=lambda: [],
        maintenance_loader=lambda: [], maintenance_checker=lambda inst, windows=None: False,
        slow_threshold_repo=NoSlowThresholds, last_webhook_at_ref=[0.0],
    ).poll_once()
    assert sorted(sent) == [("10.0.0.1", "blackbox-ping-internal"), ("10.0.0.2", "blackbox")], sent


def test_refire_heals_job_and_logs_filter_by_job():
    db = os.path.join(tempfile.mkdtemp(), "t.db")
    init_db(db)
    ev = dict(name="TargetDown", severity="critical", instance="10.0.0.1", summary="down",
              key="TargetDown|10.0.0.1", source="http://prom:9090", db_path=db)
    IncidentRepository.record_alert_event(job="blackbox", event_time=1000.0, is_now_firing=True, **ev)
    IncidentRepository.record_alert_event(job="", event_time=1100.0, is_now_firing=False, **ev)
    IncidentRepository.record_alert_event(job="blackbox-ping-internal", event_time=1200.0, is_now_firing=True, **ev)
    IncidentRepository.record_alert_event(job="", event_time=1300.0, is_now_firing=False, **ev)
    (row,) = IncidentRepository.get_history(source="http://prom:9090", db_path=db)
    assert row["job"] == "blackbox-ping-internal", row

    jobs = {r["job"] for r in EventLogRepository.get_logs(limit=50, job="blackbox-ping-internal", db_path=db)}
    assert jobs == {"blackbox-ping-internal"}, jobs


if __name__ == "__main__":
    test_poller_alert_uses_target_job()
    test_refire_heals_job_and_logs_filter_by_job()
    print("ok")
