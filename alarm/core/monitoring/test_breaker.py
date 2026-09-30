"""A failed source fetch serves the last good answer, and while the breaker is
open it does so without touching the network again."""
from unittest import mock

from alarm.core.monitoring import client

BASE = "http://prom.test:9090"


def test_source_fetch_serves_stale_and_skips_network_while_tripped():
    client.PROMETHEUS_CACHE.clear()
    client._FAILED_CANDIDATES.clear()
    calls = []

    def fake_fetch(url, timeout=None):
        calls.append(url)
        return '{"status":"success","data":{"n":1}}' if len(calls) == 1 else None

    with mock.patch.object(client, "fetch_url", side_effect=fake_fetch), \
         mock.patch.object(client, "_filter_safe_candidates", side_effect=lambda urls: urls):
        assert client._fetch_from_source("/q", BASE, True, 0.0, None)[0]["data"]["n"] == 1
        # TTL 0: refetch fails -> stale served, breaker opens
        assert client._fetch_from_source("/q", BASE, True, 0.0, None)[0]["data"]["n"] == 1
        # Breaker open: stale again, no third network call
        assert client._fetch_from_source("/q", BASE, True, 0.0, None)[0]["data"]["n"] == 1
    assert len(calls) == 2, calls


def test_dead_active_endpoint_never_fails_over_to_another_server():
    """Endpoints are unrelated fleets: a dead active endpoint reads as down —
    never as another registered server's data — and while the breaker is open
    the next poll fails fast instead of re-waiting the connect timeout."""
    dead, alive = "http://dead.test:9090", "http://alive.test:9090"
    client.PROMETHEUS_CACHE.clear()
    client._FAILED_CANDIDATES.clear()
    calls = []

    def fake_fetch(url, timeout=None):
        calls.append(url)
        return '{"status":"success","data":{"n":1}}' if url.startswith(alive) else None

    eps = {"active": dead, "endpoints": [dead, alive]}
    with mock.patch.object(client, "fetch_url", side_effect=fake_fetch), \
         mock.patch.object(client, "_filter_safe_candidates", side_effect=lambda urls: urls), \
         mock.patch.object(client, "load_endpoints", return_value=eps), \
         mock.patch.object(client, "LAST_WORKING_PROMETHEUS_URL", alive), \
         mock.patch.object(client, "_DEFAULT_PROM_URL", None):
        assert client.fetch_prometheus_json("/q", cache_ttl=60) == (None, None)
        assert client.fetch_prometheus_json("/q", cache_ttl=60) == (None, None)
    assert calls == [f"{dead}/q"], calls


def test_heavy_query_failure_does_not_open_breaker():
    """A backfill chunk given a long timeout failing must not make the next
    query fail without trying; a normal-sized failure still opens it."""
    client.PROMETHEUS_CACHE.clear()
    client._FAILED_CANDIDATES.clear()
    calls = []

    def fake_fetch(url, timeout=None):
        calls.append(url)
        return None if url.endswith("/slow") else '{"status":"success","data":{"n":1}}'

    with mock.patch.object(client, "fetch_url", side_effect=fake_fetch), \
         mock.patch.object(client, "_filter_safe_candidates", side_effect=lambda urls: urls):
        assert client.fetch_prometheus_json("/slow", source=BASE, timeout=60.0) == (None, None)
        assert client.fetch_prometheus_json("/chunk", source=BASE)[0]["data"]["n"] == 1
        assert client.fetch_prometheus_json("/slow", source=BASE) == (None, None)   # opens the breaker
        assert client.fetch_prometheus_json("/other", source=BASE) == (None, None)  # fails fast
    assert calls == [f"{BASE}/slow", f"{BASE}/chunk", f"{BASE}/slow"], calls
