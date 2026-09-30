"""Only "Exclude from SLA" maintenance windows are carved out of availability;
"Include in SLA" ones mute alarms but their time still counts.

Run: python -m pytest alarm/core/availability/test_maintenance_sla_flag.py
"""
from unittest import mock

from alarm.core.availability import engine as eng_mod
from alarm.core.availability.engine import AvailabilityEngine

WINDOWS = [
    {"id": "ex", "scope": "instance", "target": "h1", "start": 100.0, "end": 200.0, "sla_excluded": True},
    {"id": "in", "scope": "instance", "target": "h2", "start": 100.0, "end": 200.0, "sla_excluded": False},
    {"id": "legacy", "scope": "instance", "target": "h3", "start": 100.0, "end": 200.0},  # pre-flag row
]


def test_only_excluded_windows_reach_sla():
    with mock.patch.object(eng_mod, "load_maintenance_windows", return_value=WINDOWS):
        got = AvailabilityEngine._resolve_maintenance_windows(
            mock.Mock(), 0.0, 1000.0, "all", ["h1", "h2", "h3"], "http://p:9090")
    assert set(got) == {"h1", "h3"}, got
