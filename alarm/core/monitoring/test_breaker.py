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
