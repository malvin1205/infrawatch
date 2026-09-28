"""Regression checks for /api/target-history's Response Time Trend data.

- The instance regex fallback is a backtick (raw) PromQL string. The old
  double-quoted ".*1\\.0\\.0\\.1.*" was a Prometheus parse error, so every
  fallback 400'd and the lookup fell through to ALL series by substring.
- Series are matched to the target exactly (1.0.0.1 never picks up 1.0.0.10).
- The latency line averages successful probes per step; window stats (avg /
  p95 / max) come from raw successful-probe samples; the window and step are
  returned so the chart can plot against the requested range.
"""
from unittest.mock import patch
from urllib.parse import unquote, urlparse, parse_qs

from alarm.app import app

EP = "http://192.168.100.20:9090"
T0 = 1_790_000_000


def _fake_prom(calls):
    def fetch(path, **kwargs):
        q = parse_qs(urlparse(path).query)
        expr = unquote(q.get("query", [""])[0])
        calls.append(expr)
        if "query_range" in path:
            if expr.startswith("avg_over_time((probe_duration_seconds"):
                # The decoy host comes FIRST, like an unordered result would.
                return ({"status": "success", "data": {"result": [
                    {"metric": {"instance": "1.0.0.10"}, "values": [[T0, "999"], [T0 + 60, "999"]]},
                    {"metric": {"instance": "1.0.0.1"}, "values": [[T0, "12.5"], [T0 + 60, "13.5"]]},
                ]}}, EP)
            if expr.startswith("probe_success"):
                return ({"status": "success", "data": {"result": [
                    {"metric": {"instance": "1.0.0.1"}, "values": [[T0, "1"], [T0 + 60, "1"]]},
                ]}}, EP)
            return ({"status": "success", "data": {"result": []}}, EP)
        val = {"avg_over_time": "9.9", "quantile_over_time": "22.4", "max_over_time": "821.2"}
        for k, v in val.items():
            if expr.startswith(k):
                return ({"status": "success", "data": {"result": [
                    {"metric": {"instance": "1.0.0.10"}, "value": [T0, "5000"]},
                    {"metric": {"instance": "1.0.0.1"}, "value": [T0, v]},
                ]}}, EP)
        return ({"status": "success", "data": {"result": []}}, EP)
    return fetch


def _get(target="1.0.0.1", minutes=10080):
    calls = []
    with patch("alarm.app.load_endpoints", return_value={"endpoints": [EP], "active": EP}), \
            patch("alarm.app.promclient.fetch_prometheus_json", side_effect=_fake_prom(calls)):
        resp = app.test_client().get(f"/api/target-history?target={target}&minutes={minutes}")
    assert resp.status_code == 200
    return resp.get_json(), calls


def test_regex_selectors_are_raw_strings():
    _, calls = _get()
    assert not any('=~".*' in c or '=~"' in c for c in calls), [c for c in calls if '=~"' in c]
    # The fallback that does get used is anchored and raw.
    data, calls = _get(target="http://1.0.0.1/")
    assert any("instance=~`(https?://)?1\\.0\\.0\\.1/?`" in c for c in calls)
    assert not any(c.strip().startswith("probe_duration_seconds * 1000") for c in calls), \
        "no unfiltered all-series fallback"


def test_latency_matches_exact_target_not_substring():
    data, _ = _get()
    assert [v for _, v in data["latency_points"]] == [12.5, 13.5], "1.0.0.10's 999ms must not leak in"


def test_latency_line_excludes_failed_probes_and_is_averaged():
    _, calls = _get()
    line = [c for c in calls if c.startswith("avg_over_time((probe_duration_seconds")]
    assert line and "and probe_success" in line[0] and "== 1" in line[0]


def test_window_stats_and_range_are_returned():
    data, _ = _get(minutes=10080)
    assert data["latency_stats"] == {"avg": 9.9, "p95": 22.4, "max": 821.2}
    assert data["range_end"] - data["range_start"] == 10080 * 60
    assert data["latency_step"] == max(15, int(10080 * 60 / 300))
