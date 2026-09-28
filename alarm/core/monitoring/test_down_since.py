"""fetch_down_since_prom_map must date an outage from the LAST up sample, not
the first failure in the lookback window."""
from unittest import mock

from alarm.core.monitoring import queries


def _resp(instance, ts):
    return {"status": "success", "data": {"result": [{"metric": {"instance": instance}, "value": [0, str(ts)]}]}}


def test_flapping_target_uses_last_up_not_first_down():
    def fake(path, **_kw):
        q = __import__("urllib.parse").parse.unquote(path)
        if "[1d:1m]" in q:
            return {"status": "success", "data": {"result": []}}, None
        if "== 1)[32d:1h]" in q:
            return _resp("h", 5000), None   # last up: recovered, then dropped again
        if "== 0)[32d:1h]" in q:
            return _resp("h", 1000), None   # first-ever failure, days earlier
        return None, None

    with mock.patch.object(queries._pc, "fetch_prometheus_json", side_effect=fake):
        assert queries.fetch_down_since_prom_map(cache_ttl=0)["h"] == 5000.0


def test_never_up_target_falls_back_to_first_down():
    def fake(path, **_kw):
        q = __import__("urllib.parse").parse.unquote(path)
        if "== 0)[32d:1h]" in q:
            return _resp("h", 1000), None
        return {"status": "success", "data": {"result": []}}, None

    with mock.patch.object(queries._pc, "fetch_prometheus_json", side_effect=fake):
        assert queries.fetch_down_since_prom_map(cache_ttl=0)["h"] == 1000.0


def test_up_since_recovers_after_down():
    def fake(path, **_kw):
        q = __import__("urllib.parse").parse.unquote(path)
        if "== 0)[1d:1m]" in q:
            return _resp("h", 8000), None   # last down timestamp
        return {"status": "success", "data": {"result": []}}, None

    with mock.patch.object(queries._pc, "fetch_prometheus_json", side_effect=fake):
        assert queries.fetch_up_since_prom_map(cache_ttl=0)["h"] == 8000.0


def test_up_since_continuous_up_falls_back_to_earliest():
    def fake(path, **_kw):
        q = __import__("urllib.parse").parse.unquote(path)
        if "== 1)[32d:1h]" in q:
            return _resp("h", 2000), None   # earliest up
        return {"status": "success", "data": {"result": []}}, None

    with mock.patch.object(queries._pc, "fetch_prometheus_json", side_effect=fake):
        assert queries.fetch_up_since_prom_map(cache_ttl=0)["h"] == 2000.0



def test_up_since_not_claimed_across_telemetry_gap():
    """Last DOWN days ago, but Prometheus has no data until 9000: uptime is only
    provable from 9000 ("≥"), not from the old DOWN."""
    def fake(path, **_kw):
        q = __import__("urllib.parse").parse.unquote(path)
        if "== 0)[32d:1m]" in q:
            return _resp("h", 1000), None   # last down, long ago
        if "unless probe_success offset 15m" in q:
            return _resp("h", 9000), None   # telemetry resumed here
        return {"status": "success", "data": {"result": []}}, None

    with mock.patch.object(queries._pc, "fetch_prometheus_json", side_effect=fake):
        up, basis = queries.fetch_up_since_prom_map(cache_ttl=0, with_basis=True)
    assert up["h"] == 9000.0
    assert basis["h"] == "telemetry"


def test_up_since_uses_observed_down_when_data_is_continuous():
    def fake(path, **_kw):
        q = __import__("urllib.parse").parse.unquote(path)
        if "== 0)[32d:1m]" in q:
            return _resp("h", 5000), None
        if "unless probe_success offset 15m" in q:
            return _resp("h", 100), None    # run started before the down: no gap since
        return {"status": "success", "data": {"result": []}}, None

    with mock.patch.object(queries._pc, "fetch_prometheus_json", side_effect=fake):
        up, basis = queries.fetch_up_since_prom_map(cache_ttl=0, with_basis=True)
    assert up["h"] == 5000.0 and "h" not in basis
    # Old call shape still returns the plain map.
    with mock.patch.object(queries._pc, "fetch_prometheus_json", side_effect=fake):
        assert queries.fetch_up_since_prom_map(cache_ttl=0) == {"h": 5000.0}


def test_up_since_wide_lookup_is_minute_resolution():
    seen = []

    def fake(path, **_kw):
        seen.append(__import__("urllib.parse").parse.unquote(path))
        return {"status": "success", "data": {"result": []}}, None

    with mock.patch.object(queries._pc, "fetch_prometheus_json", side_effect=fake):
        queries.fetch_up_since_prom_map(cache_ttl=0)
    assert any("probe_success == 0)[32d:1m]" in q for q in seen)
    assert not any("== 0)[32d:1h]" in q for q in seen), "1h rounding dated a 17:58 recovery 17:00"


def test_lookback_edge_is_flagged_as_bound():
    """Never UP in 32d: the value is the window's edge and slides with time,
    so it's reported as a bound ("≥"), not an outage start."""
    now = 1_790_000_000
    assert queries.down_since_is_window_bound(now - queries.DOWN_SINCE_LOOKBACK_SEC + 300, now)
    assert not queries.down_since_is_window_bound(now - 86400, now)
    assert not queries.down_since_is_window_bound(0, now)
