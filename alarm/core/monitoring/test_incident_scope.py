"""Another endpoint's firing incidents never fold into the active server's
host list (they showed up as phantom hosts and in the parent-host picker).

Run: python -m pytest alarm/core/monitoring/test_incident_scope.py
"""
from types import SimpleNamespace

from alarm.core.monitoring.engine import FleetStateEngine

A, B = "http://a.test:9090", "http://b.test:9090"
INCIDENTS = [
    {"instance": "a-host", "job": "blackbox", "source": A},
    {"instance": "b-host", "job": "blackbox", "source": B},
]
NO_TARGETS = {"status": "success", "data": {"activeTargets": []}}


def test_job_map_folds_in_only_the_active_servers_incidents():
    prom = SimpleNamespace(
        fetch_prometheus_json=lambda *a, **k: (NO_TARGETS, A),
        load_endpoints=lambda: {"active": A, "endpoints": [A, B]},
    )
    eng = FleetStateEngine(prom_client=prom, active_incident_provider=lambda: INCIDENTS,
                           deleted_targets_loader=lambda: [])
    assert set(eng.get_instance_job_map("all")) == {"a-host"}
    assert set(eng.get_instance_job_map("all", source=B)) == {"b-host"}
