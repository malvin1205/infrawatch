"""Host resources (CPU / RAM / disk) for the target drawer.

Two questions, answered on demand when a host's detail opens:

  1. Is there a node exporter at IP:9100, as seen from THIS server? A TCP
     connect plus one `GET /` capped at 4 KB (the exporter's landing page, not
     /metrics) — cached for PORT_TTL. Never asked for a host whose ping is down.
  2. What does Prometheus hold for that IP's :9100 target? One instant query
     per metric for every node exporter at once, cached RESOURCE_TTL per
     Prometheus server. Nothing is written to SQLite.

The port check and the Prometheus data are independent: a firewall can hide
:9100 from this server while Prometheus (another host) still scrapes it, so a
"closed" port next to real numbers is reported as such, not as an error.

Not covered: VMs inside a hypervisor are invisible to the host's node
exporter (a later phase could read the `proxmox` job); windows_exporter
(usually :9182) exposes different metrics and is only recognised, never priced.
"""
from __future__ import annotations

import ipaddress
import os
import socket
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from typing import Any, Callable, Dict, Optional, Tuple
from urllib.parse import quote

try:
    from . import client as _pc
    from .primitives import _extract_host
except (ImportError, ValueError):  # pragma: no cover - alarm/ on sys.path
    from core.monitoring import client as _pc
    from core.monitoring.primitives import _extract_host

EXPORTER_PORT = 9100
PORT_TIMEOUT_SEC = float(os.environ.get("HOST_RES_PORT_TIMEOUT", "1.5"))
PORT_TTL_SEC = float(os.environ.get("HOST_RES_PORT_TTL", str(15 * 60)))
RESOURCE_TTL_SEC = float(os.environ.get("HOST_RES_TTL", "20"))
# Older than this (or up == 0) the numbers are shown greyed as stale.
STALE_AFTER_SEC = float(os.environ.get("HOST_RES_STALE_AFTER", "180"))
PORT_CONCURRENCY = int(os.environ.get("HOST_RES_PORT_CONCURRENCY", "4"))
LANDING_MAX_BYTES = 4096

# Only :9100 targets, so another exporter on the same IP (:9105, :9165,
# :8405...) never answers for the host.
_SEL = 'instance=~".+:%d"' % EXPORTER_PORT
_FS = 'fstype!~"tmpfs|overlay|squashfs|devtmpfs|ramfs|nsfs|autofs|fuse\\\\..*",' + _SEL
_NET_SKIP = 'device!~"lo|veth.*|docker.*|br-.*|virbr.*|cali.*|flannel.*|cni.*|tap.*|fwbr.*|fwpr.*|fwln.*|vmbr.*"'
FLEET_QUERIES = {
    "up": f"max by (instance) (up{{{_SEL}}})",
    "cpu_pct": f'100 * (1 - avg by (instance) (rate(node_cpu_seconds_total{{mode="idle",{_SEL}}}[5m])))',
    "mem_total": f"node_memory_MemTotal_bytes{{{_SEL}}}",
    "mem_avail": f"node_memory_MemAvailable_bytes{{{_SEL}}}",
    "disk_pct": f"topk by (instance) (1, 100 * (1 - node_filesystem_avail_bytes{{{_FS}}} / (node_filesystem_size_bytes{{{_FS}}} > 0)))",
    "load_per_core": f'node_load1{{{_SEL}}} / on (instance) count by (instance) (node_cpu_seconds_total{{mode="idle",{_SEL}}})',
    "uptime": f"time() - node_boot_time_seconds{{{_SEL}}}",
    "age": f"time() - timestamp(node_boot_time_seconds{{{_SEL}}})",
}

_pool = ThreadPoolExecutor(max_workers=PORT_CONCURRENCY, thread_name_prefix="host-res")
_port_sem = threading.BoundedSemaphore(PORT_CONCURRENCY)
_port_cache: Dict[str, Tuple[float, Dict[str, Any]]] = {}
_port_locks: Dict[str, threading.Lock] = {}
_res_cache: Dict[str, Tuple[float, Dict[str, Dict[str, Any]]]] = {}
_detail_cache: Dict[Tuple[str, str], Tuple[float, Dict[str, Any]]] = {}
_guard = threading.Lock()


# ── addressing ────────────────────────────────────────────────────────────────

def ip_of(instance: str) -> Optional[str]:
    """IPv4 address of a card's instance ("10.0.0.5", "10.0.0.5:9100",
    "http://10.0.0.5:8080/x"), or None when it is a name/URL host."""
    host = _extract_host(instance)
    try:
        return str(ipaddress.IPv4Address(host))
    except (ipaddress.AddressValueError, ValueError):
        return None


_alias_cache: Tuple[float, Dict[str, str]] = (-1.0, {})


def alias_file() -> str:
    try:
        from config import DATA_DIR  # type: ignore
    except ImportError:
        from alarm.config import DATA_DIR  # type: ignore
    return os.environ.get("HOST_RES_ALIAS_FILE") or os.path.join(DATA_DIR, "host_aliases.txt")


def load_aliases(path: Optional[str] = None) -> Dict[str, str]:
    """Optional `<card instance or host> <IPv4>` lines (also `name = ip` or
    `name,ip`; `#` comments) for cards that aren't an IP — a service name or
    URL. Re-read when the file changes; missing file = no aliases."""
    global _alias_cache
    path = path or alias_file()
    try:
        mtime = os.path.getmtime(path)
    except OSError:
        return {}
    if mtime == _alias_cache[0]:
        return _alias_cache[1]
    out: Dict[str, str] = {}
    with open(path, encoding="utf-8") as fh:
        for line in fh:
            parts = line.split("#", 1)[0].replace("=", " ").replace(",", " ").split()
            if len(parts) == 2 and ip_of(parts[1]):
                out[parts[0].lower()] = parts[1]
    _alias_cache = (mtime, out)
    return out


def resolve(instance: str, aliases: Optional[Dict[str, str]] = None) -> Tuple[Optional[str], bool]:
    """(ip, from_alias) for a card's instance."""
    aliases = load_aliases() if aliases is None else aliases
    for key in (str(instance).strip().lower(), _extract_host(instance)):
        if key in aliases:
            return aliases[key], True
    return ip_of(instance), False


# ── port check ────────────────────────────────────────────────────────────────

def _classify_landing(body: bytes) -> str:
    low = body.lower()
    if b"windows_exporter" in low or b"windows exporter" in low:
        return "windows_exporter"
    if b"node exporter" in low or b"node_exporter" in low:
        return "node_exporter"
    return "other"


def probe_port(ip: str, port: int = EXPORTER_PORT, timeout: float = PORT_TIMEOUT_SEC,
               connect: Callable = socket.create_connection, now: Optional[float] = None) -> Dict[str, Any]:
    """TCP connect to ip:port, then read at most LANDING_MAX_BYTES of `GET /`
    to tell a node exporter from something else listening there."""
    t0 = time.monotonic()
    checked_at = time.time() if now is None else now
    try:
        sock = connect((ip, port), timeout=timeout)
    except socket.timeout:
        return {"state": "timeout", "kind": None, "checked_at": checked_at,
                "ms": round((time.monotonic() - t0) * 1000)}
    except OSError:
        return {"state": "closed", "kind": None, "checked_at": checked_at,
                "ms": round((time.monotonic() - t0) * 1000)}
    kind = "other"
    try:
        sock.settimeout(timeout)
        sock.sendall(b"GET / HTTP/1.0\r\nHost: %s\r\nConnection: close\r\n\r\n" % ip.encode())
        body = b""
        while len(body) < LANDING_MAX_BYTES:
            chunk = sock.recv(LANDING_MAX_BYTES - len(body))
            if not chunk:
                break
            body += chunk
        kind = _classify_landing(body)
    except OSError:
        pass  # open, but no HTTP answer in time: something, not an exporter we know
    finally:
        try:
            sock.close()
        except OSError:
            pass
    return {"state": "open", "kind": kind, "checked_at": checked_at,
            "ms": round((time.monotonic() - t0) * 1000)}


def check_port(ip: str, refresh: bool = False, now: Optional[float] = None,
               probe: Callable[..., Dict[str, Any]] = probe_port) -> Dict[str, Any]:
    """Cached probe_port. At most PORT_CONCURRENCY probes run at once across
    the app; requests for the same IP queue behind one probe and reuse it."""
    now = time.time() if now is None else now
    with _guard:
        lock = _port_locks.setdefault(ip, threading.Lock())
    with lock:
        hit = _port_cache.get(ip)
        # refresh: reuse only a probe made at/after this request (a Recheck
        # that queued behind another one for the same host).
        if hit and now - hit[0] < PORT_TTL_SEC and (not refresh or hit[0] >= now):
            return hit[1]
        with _port_sem:
            result = probe(ip)
        _port_cache[ip] = (now, result)
        return result


def cached_port(ip: str, now: Optional[float] = None) -> Optional[Dict[str, Any]]:
    now = time.time() if now is None else now
    hit = _port_cache.get(ip)
    return hit[1] if hit and now - hit[0] < PORT_TTL_SEC else None


# ── Prometheus ────────────────────────────────────────────────────────────────

def _query(expr: str, source: str, timeout: float = 10.0) -> Optional[list]:
    raw, _ = _pc.fetch_prometheus_json(f"/api/v1/query?query={quote(expr)}", use_cache=False,
                                       timeout=timeout, source=source)
    if not raw or raw.get("status") != "success":
        return None
    return raw.get("data", {}).get("result", [])


def parse_by_ip(result: Optional[list]) -> Dict[str, Tuple[float, Dict[str, str]]]:
    """Instant-query vector -> {ip: (value, labels)}; the port is dropped here.
    Non-IP instances are skipped; NaN/Inf values too."""
    out: Dict[str, Tuple[float, Dict[str, str]]] = {}
    for r in result or []:
        labels = r.get("metric", {})
        ip = ip_of(labels.get("instance", ""))
        try:
            val = float(r.get("value", [None, None])[1])
        except (TypeError, ValueError):
            continue
        if ip is None or val != val or val in (float("inf"), float("-inf")):
            continue
        out[ip] = (val, labels)
    return out


def build_resources(maps: Dict[str, Dict[str, Tuple[float, Dict[str, str]]]],
                    stale_after: float = STALE_AFTER_SEC) -> Dict[str, Dict[str, Any]]:
    """{ip: resources} for every IP with any node exporter data. A metric the
    host doesn't report is absent, never 0."""
    ips = set()
    for m in maps.values():
        ips.update(m)
    out: Dict[str, Dict[str, Any]] = {}
    for ip in ips:
        get = lambda k: maps.get(k, {}).get(ip)
        r: Dict[str, Any] = {}
        up = get("up")
        if up:
            r["up"] = int(up[0])
            r["exporter"] = up[1].get("instance")
        if get("cpu_pct"):
            r["cpu_pct"] = round(max(0.0, min(100.0, get("cpu_pct")[0])), 1)
        total, avail = get("mem_total"), get("mem_avail")
        if total and avail and total[0] > 0:
            used = max(0.0, total[0] - avail[0])
            r.update(mem_total_bytes=int(total[0]), mem_used_bytes=int(used),
                     mem_pct=round(100.0 * used / total[0], 1))
        disk = get("disk_pct")
        if disk:
            r.update(disk_pct=round(max(0.0, min(100.0, disk[0])), 1), disk_mount=disk[1].get("mountpoint"))
        if get("load_per_core"):
            r["load_per_core"] = round(get("load_per_core")[0], 2)
        if get("uptime"):
            r["uptime_sec"] = int(get("uptime")[0])
        age = get("age")
        if age:
            r["age_sec"] = int(max(0.0, age[0]))
            r.setdefault("exporter", age[1].get("instance"))
        has_numbers = any(k in r for k in ("cpu_pct", "mem_pct", "disk_pct", "load_per_core", "uptime_sec"))
        r["stale"] = r.get("up") == 0 or not has_numbers or r.get("age_sec", 0) > stale_after
        out[ip] = r
    return out


def fleet_resources(source: str, refresh: bool = False, now: Optional[float] = None,
                    query: Callable[[str, str], Optional[list]] = _query) -> Optional[Dict[str, Dict[str, Any]]]:
    """Resources of every :9100 target on `source`, RESOURCE_TTL-cached per
    server. None when Prometheus could not be read."""
    now = time.time() if now is None else now
    with _guard:
        lock = _port_locks.setdefault("prom:" + source, threading.Lock())
    with lock:  # single flight per server: N open drawers, one set of queries
        hit = _res_cache.get(source)
        if hit and now - hit[0] < RESOURCE_TTL_SEC and (not refresh or hit[0] >= now):
            return hit[1]
        futs = {k: _pool.submit(query, expr, source) for k, expr in FLEET_QUERIES.items()}
        results = {k: f.result() for k, f in futs.items()}
        if results["up"] is None:
            return hit[1] if hit else None
        data = build_resources({k: parse_by_ip(v) for k, v in results.items()})
        _res_cache[source] = (now, data)
        return data


def host_detail(source: str, ip: str, now: Optional[float] = None,
                query: Callable[[str, str], Optional[list]] = _query) -> Dict[str, Any]:
    """Per-partition and per-interface figures for ONE host (lazy: only when
    its section is expanded)."""
    now = time.time() if now is None else now
    hit = _detail_cache.get((source, ip))
    if hit and now - hit[0] < RESOURCE_TTL_SEC:
        return hit[1]
    one = 'instance="%s:%d"' % (ip, EXPORTER_PORT)
    fs = _FS.replace(_SEL, one)
    q = {
        "size": f"node_filesystem_size_bytes{{{fs}}}",
        "avail": f"node_filesystem_avail_bytes{{{fs}}}",
        "rx": f"rate(node_network_receive_bytes_total{{{one},{_NET_SKIP}}}[5m])",
        "tx": f"rate(node_network_transmit_bytes_total{{{one},{_NET_SKIP}}}[5m])",
    }
    futs = {k: _pool.submit(query, expr, source) for k, expr in q.items()}
    res = {k: f.result() or [] for k, f in futs.items()}
    avail = {(r["metric"].get("mountpoint"), r["metric"].get("device")): float(r["value"][1]) for r in res["avail"]}
    parts = []
    for r in res["size"]:
        key = (r["metric"].get("mountpoint"), r["metric"].get("device"))
        size = float(r["value"][1])
        if size <= 0 or key not in avail:
            continue
        parts.append({"mount": key[0], "device": key[1], "fstype": r["metric"].get("fstype"),
                      "size_bytes": int(size), "used_pct": round(100.0 * (1 - avail[key] / size), 1)})
    parts.sort(key=lambda p: -p["used_pct"])
    tx = {r["metric"].get("device"): float(r["value"][1]) for r in res["tx"]}
    net = sorted(({"device": r["metric"].get("device"), "rx_bps": round(float(r["value"][1]) * 8),
                   "tx_bps": round(tx.get(r["metric"].get("device"), 0.0) * 8)} for r in res["rx"]),
                 key=lambda n: -(n["rx_bps"] + n["tx_bps"]))
    out = {"partitions": parts, "network": net}
    _detail_cache[(source, ip)] = (now, out)
    return out


# ── the drawer's report ───────────────────────────────────────────────────────

def port_status(port: Optional[Dict[str, Any]], scraped: bool, host_down: bool, ip: Optional[str]) -> str:
    """One word for the drawer's status line."""
    if ip is None:
        return "no_ip"
    if port is None:
        return "not_checked_down" if host_down else "not_checked"
    if port.get("kind") == "windows_exporter":
        return "windows_exporter"
    if port["state"] == "open":
        if port.get("kind") == "other":
            return "open_other"
        return "open_scraped" if scraped else "open_not_scraped"
    return "closed_scraped" if scraped else "closed"


def host_report(instance: str, source: str, host_down: bool = False, refresh: bool = False,
                detail: bool = False, now: Optional[float] = None) -> Dict[str, Any]:
    ip, via_alias = resolve(instance)
    port = None
    if ip is not None:
        if host_down:
            port = cached_port(ip, now)  # never probe a host whose ping is down
        else:
            port = check_port(ip, refresh=refresh, now=now)
    fleet = fleet_resources(source, refresh=refresh, now=now) if ip else None
    res = (fleet or {}).get(ip) if ip else None
    if port and port.get("kind") == "windows_exporter":
        res = None  # node_* numbers don't describe a Windows host
    out: Dict[str, Any] = {
        "ok": True, "instance": instance, "ip": ip, "alias": via_alias, "source": source,
        "port": dict(port, number=EXPORTER_PORT) if port else None,
        "prometheus_ok": fleet is not None or ip is None,
        "status": port_status(port, bool(res), host_down, ip),
    }
    if res:
        out["resources"] = res
        if detail:
            out["detail"] = host_detail(source, ip, now=now)
    return out
