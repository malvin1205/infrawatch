"""Orphan-reconcile check.

The one thing that must not regress: reconcile_orphaned_alerts has to be given
the SCRAPED instance set. Handed get_monitored_instances() instead — which
folds every active incident's instance back into the monitored set — every
orphan vouches for itself and nothing is ever resolved. That is what kept a
switched-away Prometheus endpoint's outages firing forever, re-injected into
/instances as phantom "Alertmanager" hosts.

Run: python alarm/core/workers/test_orphan_reconcile.py
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))

from core.workers.poller import TargetPoller  # noqa: E402


def _poller(incidents, resolved):
    return TargetPoller(
        active_incident_provider=lambda: incidents,
        alert_sink=lambda **kw: resolved.append((kw["instance"], kw["is_now_firing"])),
    )


def test_orphan_resolved_when_absent_from_scraped_set():
    incidents = [
        {"name": "TargetDown", "instance": "10.0.0.1", "severity": "critical", "key": "TargetDown|10.0.0.1"},
        {"name": "SlowResponse", "instance": "10.0.0.2", "severity": "warning", "key": "SlowResponse|10.0.0.2"},
    ]
    resolved = []
    # Only 10.0.0.2 is still scraped: 10.0.0.1 belongs to the old endpoint.
    _poller(incidents, resolved).reconcile_orphaned_alerts(["10.0.0.2"])
    assert resolved == [("10.0.0.1", False)], resolved


def test_scraped_instance_is_left_firing():
    incidents = [{"name": "TargetDown", "instance": "10.0.0.1", "severity": "critical", "key": "TargetDown|10.0.0.1"}]
    resolved = []
    _poller(incidents, resolved).reconcile_orphaned_alerts(["10.0.0.1"])
    assert resolved == [], resolved


def test_non_poller_owned_alert_is_never_touched():
    incidents = [{"name": "DiskFull", "instance": "10.0.0.9", "severity": "critical", "key": "DiskFull|10.0.0.9"}]
    resolved = []
    _poller(incidents, resolved).reconcile_orphaned_alerts(["10.0.0.1"])
    assert resolved == [], resolved


if __name__ == "__main__":
    test_orphan_resolved_when_absent_from_scraped_set()
    test_scraped_instance_is_left_firing()
    test_non_poller_owned_alert_is_never_touched()
    print("ok")
