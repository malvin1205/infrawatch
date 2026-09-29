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


def test_dead_active_endpoint_reads_failover_cache_instead_of_retrying():
    """Active endpoint down, failover answered: the next call within the cache
    TTL must be served from the failover's cache entry, not re-wait the dead
    active's connect timeout."""
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
         mock.patch.object(client, "LAST_WORKING_PROMETHEUS_URL", None), \
         mock.patch.object(client, "_DEFAULT_PROM_URL", None):
        assert client.fetch_prometheus_json("/q", cache_ttl=60)[1] == alive
        n = len(calls)
        assert client.fetch_prometheus_json("/q", cache_ttl=60)[1] == alive
    assert len(calls) == n, calls[n:]
