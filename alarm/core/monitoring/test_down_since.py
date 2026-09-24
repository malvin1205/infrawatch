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

