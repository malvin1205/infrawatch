"""Poller: exporter targets become incidents, and incident times are the
real edges in Prometheus' samples, not the moment the poll noticed.

Run: python -m pytest alarm/core/workers/test_poller_edges.py
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))

from core.workers.poller import TargetPoller, find_edge  # noqa: E402

NOW = 1_790_000_000.0


def test_find_edge():
    s = [(0, 1), (2, 1), (4, 0), (6, 0)]
    assert find_edge(s, to_up=False) == 4, "first 0 of the current outage"
    assert find_edge(s + [(8, 1), (10, 1)], to_up=True) == 8, "first 1 of the recovery"
    assert find_edge([(0, 0), (2, 0)], to_up=False) is None, "down the whole window: no edge seen"
    assert find_edge(s, to_up=True) is None, "not in that state now"
    assert find_edge([], to_up=False) is None and find_edge(None, to_up=True) is None


class _Query:
    def __init__(self, probe, up, samples, down_since=None):
        self.probe, self.up, self.samples, self.down_since = probe, up, samples, down_since or {}
        self.selectors = []

    def fetch_all_probe_metrics(self, **k):
        return dict(self.probe), {}, {}

    def fetch_up_map(self):
        return dict(self.up)

    def fetch_down_since_prom_map(self):
        return dict(self.down_since)

    def fetch_recent_samples(self, selector, lookback_sec, source=None):
        self.selectors.append(selector)
        inst = selector.split('instance="')[1].split('"')[0]
        return self.samples.get(inst)


class _State:
    def __init__(self, jobs):
        self.jobs = jobs

    def get_monitored_instances(self):
        return list(self.jobs)

    def get_scraped_instances(self):
        return list(self.jobs)

    def get_instance_job_map(self):
        return dict(self.jobs)


def _run(query, jobs, state=None):
    events = []
    p = TargetPoller(
        query_adapter=query, state_adapter=_State(jobs),
        alert_sink=lambda **kw: events.append(kw),
        active_incident_provider=lambda: [],
        maintenance_loader=lambda: [], maintenance_checker=lambda inst, windows=None: False,
        state=dict(state or {}), last_webhook_at_ref=[0.0],
    )
    p.poll_once(now=NOW)
    return {e["instance"]: e for e in events if e["name"] == "TargetDown"}


def test_exporter_down_becomes_an_incident_timed_at_its_first_failed_scrape():
    q = _Query(probe={"10.0.0.1": "1"}, up={"10.0.0.1": "1", "10.0.0.5:9100": "0"},
               samples={"10.0.0.5:9100": [(NOW - 120, 1), (NOW - 60, 0), (NOW, 0)]},
               down_since={"10.0.0.5:9100": NOW - 120})
    ev = _run(q, {"10.0.0.1": "blackbox-ping-internal", "10.0.0.5:9100": "nodeexporter"},
              state={"10.0.0.1": "up", "10.0.0.5:9100": "up"})
    assert set(ev) == {"10.0.0.5:9100"}, ev
    assert ev["10.0.0.5:9100"]["is_now_firing"] is True
    assert ev["10.0.0.5:9100"]["event_time"] == NOW - 60, "the first 0 sample, not the poll"
    assert ev["10.0.0.5:9100"]["job"] == "nodeexporter"
    assert q.selectors == ['up{instance="10.0.0.5:9100",job="nodeexporter"}'], "its `up`, scoped to its job"


def test_probe_wins_over_up_for_blackbox_targets():
    # up == 1 (blackbox exporter reachable) must not mask probe_success == 0
    q = _Query(probe={"10.0.0.1": "0"}, up={"10.0.0.1": "1"},
               samples={"10.0.0.1": [(NOW - 30, 1), (NOW - 20, 0), (NOW, 0)]})
    ev = _run(q, {"10.0.0.1": "blackbox-ping-internal"}, state={"10.0.0.1": "up"})
    assert ev["10.0.0.1"]["is_now_firing"] is True and ev["10.0.0.1"]["event_time"] == NOW - 20
    assert q.selectors[0].startswith("probe_success{")


def test_recovery_is_timed_at_the_first_good_sample():
    q = _Query(probe={"10.0.0.1": "1"}, up={},
               samples={"10.0.0.1": [(NOW - 90, 0), (NOW - 45, 1), (NOW, 1)]})
    ev = _run(q, {"10.0.0.1": "blackbox"}, state={"10.0.0.1": "down"})
    assert ev["10.0.0.1"]["is_now_firing"] is False and ev["10.0.0.1"]["event_time"] == NOW - 45


def test_cold_start_outage_older_than_the_lookback_uses_down_since():
    """App started while a host had been down for days: its incident starts
    when Prometheus last saw it up, not when the app booted."""
    q = _Query(probe={"10.0.0.9": "0"}, up={},
               samples={"10.0.0.9": [(NOW - 800, 0), (NOW, 0)]},
               down_since={"10.0.0.9": NOW - 5 * 86400})
    ev = _run(q, {"10.0.0.9": "blackbox-ping-internal"})
    assert ev["10.0.0.9"]["event_time"] == NOW - 5 * 86400


def test_no_samples_falls_back_to_the_poll_time():
    q = _Query(probe={"10.0.0.1": "1"}, up={}, samples={})
    ev = _run(q, {"10.0.0.1": "blackbox"}, state={"10.0.0.1": "down"})
    assert ev["10.0.0.1"]["event_time"] == NOW


def test_grace_is_measured_on_the_sample_timeline_for_exporters_too():
    """One failed scrape 5s ago (on Prometheus' clock) is held, even for an
    exporter with no probe-based down-since and an app clock that lags."""
    q = _Query(probe={"10.0.0.1": "1"}, up={"10.0.0.5:9100": "0"},
               samples={"10.0.0.5:9100": [(NOW - 20, 1), (NOW + 8, 0), (NOW + 13, 0)]})
    jobs = {"10.0.0.1": "blackbox", "10.0.0.5:9100": "nodeexporter"}
    st = {"10.0.0.1": "up", "10.0.0.5:9100": "up"}
    assert _run(q, jobs, state=st) == {}
    q.samples["10.0.0.5:9100"] += [(NOW + 30, 0)]
    ev = _run(q, jobs, state=st)
    assert ev["10.0.0.5:9100"]["event_time"] == NOW + 8
