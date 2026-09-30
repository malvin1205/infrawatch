"""Self-check for host resources (port 9100 check + node exporter numbers).
Run: python -m pytest alarm/core/monitoring/test_host_resources.py"""
import os
import socket
import tempfile
import threading
import time

from alarm.core.monitoring import host_resources as hr

SRC = "http://prom-a:9090"


def _reset():
    hr._port_cache.clear()
    hr._res_cache.clear()
    hr._detail_cache.clear()


def test_ip_of_strips_port_scheme_and_path():
    assert hr.ip_of("192.168.9.18") == "192.168.9.18"
    assert hr.ip_of("192.168.9.18:9100") == "192.168.9.18"
    assert hr.ip_of("http://10.0.0.5:8080/metrics") == "10.0.0.5"
    assert hr.ip_of("https://erp.inconis.com") is None
    assert hr.ip_of("gitlab-omnibus-services") is None
    assert hr.ip_of("999.1.1.1") is None


def test_aliases_map_non_ip_cards():
    with tempfile.TemporaryDirectory() as d:
        path = os.path.join(d, "host_aliases.txt")
        with open(path, "w") as fh:
            fh.write("# comment\ngitlab-omnibus-services 192.168.9.40\nhttps://erp.nti.co.id = 192.168.9.41\nbad-line nope\n")
        al = hr.load_aliases(path)
        assert al == {"gitlab-omnibus-services": "192.168.9.40", "https://erp.nti.co.id": "192.168.9.41"}
        assert hr.resolve("gitlab-omnibus-services", al) == ("192.168.9.40", True)
        assert hr.resolve("https://erp.nti.co.id", al) == ("192.168.9.41", True)
        assert hr.resolve("192.168.9.18:9100", al) == ("192.168.9.18", False)
        assert hr.resolve("https://nti.co.id", al) == (None, False)


def _vec(*rows):
    return [{"metric": m, "value": [1790000000, str(v)]} for m, v in rows]


def test_parse_drops_port_non_ip_and_nan():
    got = hr.parse_by_ip(_vec(({"instance": "10.0.0.5:9100", "mountpoint": "/"}, 42.5),
                              ({"instance": "svc-name:9100"}, 1), ({"instance": "10.0.0.6:9100"}, "NaN")))
    assert got == {"10.0.0.5": (42.5, {"instance": "10.0.0.5:9100", "mountpoint": "/"})}


def _fake_query(tables):
    def q(expr, source):
        for key, e in hr.FLEET_QUERIES.items():
            if e == expr:
                return tables.get(key, [])
        return []
    return q


FLEET = {
    "up": _vec(({"instance": "10.0.0.5:9100"}, 1), ({"instance": "10.0.0.7:9100"}, 0)),
    "cpu_pct": _vec(({"instance": "10.0.0.5:9100"}, 12.34)),
    "mem_total": _vec(({"instance": "10.0.0.5:9100"}, 8 * 2**30)),
    "mem_avail": _vec(({"instance": "10.0.0.5:9100"}, 2 * 2**30)),
    "disk_pct": _vec(({"instance": "10.0.0.5:9100", "mountpoint": "/var"}, 91.26)),
    "load_per_core": _vec(({"instance": "10.0.0.5:9100"}, 0.456)),
    "uptime": _vec(({"instance": "10.0.0.5:9100"}, 86400 * 3)),
    "age": _vec(({"instance": "10.0.0.5:9100"}, 12)),
}


def test_build_resources_and_stale():
    _reset()
    data = hr.fleet_resources(SRC, query=_fake_query(FLEET), now=1000.0)
    r = data["10.0.0.5"]
    assert r == {"up": 1, "exporter": "10.0.0.5:9100", "cpu_pct": 12.3, "mem_total_bytes": 8 * 2**30,
                 "mem_used_bytes": 6 * 2**30, "mem_pct": 75.0, "disk_pct": 91.3, "disk_mount": "/var",
                 "load_per_core": 0.46, "uptime_sec": 259200, "age_sec": 12, "stale": False}
    # up == 0 and nothing else: listed (Prometheus knows it) but stale, no numbers at all
    assert data["10.0.0.7"] == {"up": 0, "exporter": "10.0.0.7:9100", "stale": True}
    # old samples are stale too
    old = dict(FLEET, age=_vec(({"instance": "10.0.0.5:9100"}, 999)))
    _reset()
    assert hr.fleet_resources(SRC, query=_fake_query(old), now=1000.0)["10.0.0.5"]["stale"] is True


def test_resource_cache_ttl_and_refresh():
    _reset()
    calls = []
    q = _fake_query(FLEET)
    counting = lambda e, s: calls.append(e) or q(e, s)
    hr.fleet_resources(SRC, query=counting, now=1000.0)
    n = len(calls)
    assert n == len(hr.FLEET_QUERIES), "one query per metric for the whole fleet"
    hr.fleet_resources(SRC, query=counting, now=1000.0 + hr.RESOURCE_TTL_SEC - 1)
    assert len(calls) == n, "served from cache inside the TTL"
    hr.fleet_resources(SRC, query=counting, now=1000.0 + hr.RESOURCE_TTL_SEC + 1)
    assert len(calls) == 2 * n, "re-read after the TTL"
    hr.fleet_resources(SRC, query=counting, now=1000.0 + hr.RESOURCE_TTL_SEC + 2, refresh=True)
    assert len(calls) == 3 * n, "refresh bypasses the cache"
    hr.fleet_resources("http://prom-b:9090", query=counting, now=1000.0 + hr.RESOURCE_TTL_SEC + 2)
    assert len(calls) == 4 * n, "cached per Prometheus server"


def test_failed_prometheus_read_is_none_not_empty():
    _reset()
    assert hr.fleet_resources(SRC, query=lambda e, s: None, now=1.0) is None


class _Sock:
    def __init__(self, body=b"", recv_error=None):
        self.body, self.recv_error, self.sent = body, recv_error, b""

    def settimeout(self, t):
        pass

    def sendall(self, data):
        self.sent += data

    def recv(self, n):
        if self.recv_error:
            raise self.recv_error
        out, self.body = self.body[:n], self.body[n:]
        return out

    def close(self):
        pass


def test_probe_port_open_closed_timeout_and_kind():
    node = _Sock(b"HTTP/1.1 200 OK\r\n\r\n<html><title>Node Exporter</title>" + b"x" * 10000)
    r = hr.probe_port("10.0.0.5", connect=lambda addr, timeout: node, now=5.0)
    assert r["state"] == "open" and r["kind"] == "node_exporter" and r["checked_at"] == 5.0
    assert node.sent.startswith(b"GET / HTTP/1.0") and len(node.body) > 0, "reads at most 4 KB, never /metrics"
    win = _Sock(b"HTTP/1.1 200 OK\r\n\r\n<h1>windows_exporter</h1>")
    assert hr.probe_port("10.0.0.6", connect=lambda a, timeout: win)["kind"] == "windows_exporter"
    other = _Sock(recv_error=socket.timeout())
    assert hr.probe_port("10.0.0.8", connect=lambda a, timeout: other) ["kind"] == "other"

    def refuse(addr, timeout):
        raise ConnectionRefusedError()

    def hang(addr, timeout):
        raise socket.timeout()

    assert hr.probe_port("10.0.0.9", connect=refuse)["state"] == "closed"
    assert hr.probe_port("10.0.0.9", connect=hang)["state"] == "timeout"


def test_port_cache_ttl_refresh_and_single_probe_per_host():
    _reset()
    calls = []
    probe = lambda ip: calls.append(ip) or {"state": "open", "kind": "node_exporter", "checked_at": 0}
    hr.check_port("10.0.0.5", now=100.0, probe=probe)
    hr.check_port("10.0.0.5", now=100.0 + hr.PORT_TTL_SEC - 1, probe=probe)
    assert calls == ["10.0.0.5"]
    hr.check_port("10.0.0.5", now=200.0, probe=probe, refresh=True)
    assert len(calls) == 2, "Recheck re-probes"
    hr.check_port("10.0.0.5", now=100.0 + hr.PORT_TTL_SEC + 300, probe=probe)
    assert len(calls) == 3, "re-probed after the TTL"


def test_port_checks_never_exceed_the_concurrency_limit():
    _reset()
    running, peak, lock = [0], [0], threading.Lock()

    def slow(ip):
        with lock:
            running[0] += 1
            peak[0] = max(peak[0], running[0])
        time.sleep(0.05)
        with lock:
            running[0] -= 1
        return {"state": "closed", "kind": None, "checked_at": 0}

    threads = [threading.Thread(target=hr.check_port, args=(f"10.1.0.{i}",), kwargs={"probe": slow})
               for i in range(20)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert 1 < peak[0] <= hr.PORT_CONCURRENCY, peak


def test_report_statuses_and_no_zero_values():
    _reset()
    hr._res_cache[SRC] = (time.time(), hr.build_resources({k: hr.parse_by_ip(v) for k, v in FLEET.items()}))
    probe_open = {"state": "open", "kind": "node_exporter", "checked_at": time.time()}
    probe_closed = {"state": "timeout", "kind": None, "checked_at": time.time()}
    hr._port_cache["10.0.0.5"] = (time.time(), probe_open)
    r = hr.host_report("10.0.0.5", SRC)
    assert r["status"] == "open_scraped" and r["resources"]["cpu_pct"] == 12.3
    hr._port_cache["10.0.0.5"] = (time.time(), probe_closed)
    assert hr.host_report("10.0.0.5", SRC)["status"] == "closed_scraped", "firewall: closed here, scraped there"
    hr._port_cache["10.0.0.9"] = (time.time(), probe_open)
    r = hr.host_report("10.0.0.9", SRC)
    assert r["status"] == "open_not_scraped" and "resources" not in r, "no data -> no field, never zeros"
    hr._port_cache["10.0.0.10"] = (time.time(), probe_closed)
    assert hr.host_report("10.0.0.10", SRC)["status"] == "closed"
    # ping down: never probed, even with a cold cache
    r = hr.host_report("10.0.0.11", SRC, host_down=True)
    assert r["status"] == "not_checked_down" and r["port"] is None and "10.0.0.11" not in hr._port_cache
    assert hr.host_report("https://erp.inconis.com", SRC)["status"] == "no_ip"
    hr._port_cache["10.0.0.5"] = (time.time(), {"state": "open", "kind": "windows_exporter", "checked_at": 0})
    r = hr.host_report("10.0.0.5", SRC)
    assert r["status"] == "windows_exporter" and "resources" not in r, "node numbers never shown for Windows"
