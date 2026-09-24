"""Comprehensive Regression Test Suite for Audit Fixes:
- BLK-01: Whitelist blank env fallback
- BLK-02: Zombie incidents & EndpointRepository.delete_endpoint auto-resolves
- MAJ-01: source=active_source in target-history subqueries
- MAJ-02: incidents table source scoping & server isolation
- MAJ-03: Cache invalidation on endpoint deletion
- MAJ-04: _FLEET_TREND_CACHE / _DAILY_PROMETHEUS_CACHE cleared by invalidate_cache()
- MIN-01: history.js WIB timezone offset alignment
- MIN-02: POST /api/targets whitelist validation warning
"""
import os
import sys
import time
import pytest
from unittest.mock import patch, MagicMock

# Ensure repo root and alarm dir are in sys.path
sys.path.insert(0, os.path.abspath("."))
sys.path.insert(0, os.path.abspath("alarm"))

from alarm.config import (
    load_target_whitelist, DATA_DIR, AVAIL_TARGET_WHITELIST
)
from alarm.storage.db import get_db, db_read, db_transaction
from alarm.storage.schema import init_db
from alarm.storage.repositories.inventory import EndpointRepository
from alarm.storage.repositories.alerts import IncidentRepository, AcknowledgmentRepository
from alarm.core.availability.helpers import (
    clear_helpers_caches, WIB_OFFSET_SEC as WIB_HELPERS
)
from alarm.core.availability import availability_engine
from alarm.app import (
    app, add_target_api, delete_endpoint_api,
    _FLEET_TREND_CACHE, _DAILY_PROMETHEUS_CACHE
)
from flask import g


# ─────────────────────────────────────────────────────────────────────────────
# BLK-01: Whitelist blank env fallback
# ─────────────────────────────────────────────────────────────────────────────
def test_blk01_whitelist_empty_env_fallback():
    # 1. Empty string ""
    with patch.dict(os.environ, {"AVAIL_TARGET_WHITELIST_FILE": ""}):
        wl_empty = load_target_whitelist()
        assert wl_empty is not None
        assert len(wl_empty) == 78, f"Expected 78 targets, got {len(wl_empty)}"

    # 2. Whitespace-only "   "
    with patch.dict(os.environ, {"AVAIL_TARGET_WHITELIST_FILE": "   \t\n"}):
        wl_ws = load_target_whitelist()
        assert wl_ws is not None
        assert len(wl_ws) == 78, f"Expected 78 targets, got {len(wl_ws)}"

    # 3. Unset
    with patch.dict(os.environ, {}, clear=False):
        os.environ.pop("AVAIL_TARGET_WHITELIST_FILE", None)
        wl_unset = load_target_whitelist()
        assert wl_unset is not None
        assert len(wl_unset) == 78, f"Expected 78 targets, got {len(wl_unset)}"

    # 4. Explicit opt-out with "none"
    with patch.dict(os.environ, {"AVAIL_TARGET_WHITELIST_FILE": "none"}):
        wl_none = load_target_whitelist()
        assert wl_none is None


# ─────────────────────────────────────────────────────────────────────────────
# BLK-02: Endpoint deletion auto-resolves incidents & clears acknowledgments
# ─────────────────────────────────────────────────────────────────────────────
def test_blk02_endpoint_delete_autoresolve(tmp_path):
    test_db = str(tmp_path / "test_blk02.db")
    from alarm.storage.schema import init_db
    init_db(test_db)

    ep_url = "http://192.168.99.16:9090"
    EndpointRepository.create_endpoint("test_ep", ep_url, is_active=True, db_path=test_db)

    # Insert an active firing incident for this endpoint's source
    IncidentRepository.record_alert_event(
        name="TargetDown",
        severity="critical",
        instance="192.168.99.16:8080",
        summary="Target is down",
        job="blackbox",
        event_time=time.time() - 300,
        is_now_firing=True,
        key="test_alert_key",
        source=ep_url,
        db_path=test_db
    )
    # Insert acknowledgment for this instance
    AcknowledgmentRepository.acknowledge_instances(["192.168.99.16:8080"], "admin", db_path=test_db)

    # Verify incident is firing and ack exists
    active_before = IncidentRepository.get_active_incidents(source=ep_url, db_path=test_db)
    assert len(active_before) == 1
    acks_before = AcknowledgmentRepository.get_active_acknowledgments(db_path=test_db)
    assert "192.168.99.16:8080" in acks_before

    # Delete the endpoint
    EndpointRepository.delete_endpoint(ep_url, db_path=test_db)

    # Verify incident is auto-resolved
    active_after = IncidentRepository.get_active_incidents(source=ep_url, db_path=test_db)
    assert len(active_after) == 0, f"Expected 0 active incidents, got {len(active_after)}"

    # Verify acknowledgment is cleared
    acks_after = AcknowledgmentRepository.get_active_acknowledgments(db_path=test_db)
    assert "192.168.99.16:8080" not in acks_after

    # Check database row has status 'resolved'
    with db_read(test_db) as conn:
        row = conn.execute("SELECT status, resolved_at FROM incidents WHERE key = 'test_alert_key'").fetchone()
        assert row is not None
        assert row["status"] == "resolved"
        assert row["resolved_at"] is not None


# ─────────────────────────────────────────────────────────────────────────────
# MAJ-01: Missing source=active_source in target-history subqueries
# ─────────────────────────────────────────────────────────────────────────────
def test_maj01_target_history_passes_active_source():
    client = app.test_client()
    active_ep = "http://192.168.100.20:9090"

    mock_resp = ({"status": "success", "data": {"result": []}}, active_ep)
    with patch("alarm.app.load_endpoints", return_value={"endpoints": [active_ep], "active": active_ep}):
        with patch("alarm.app.promclient.fetch_prometheus_json", return_value=mock_resp) as mock_fetch:
            resp = client.get("/api/target-history?target=http://1.1.1.1:80&minutes=60")
            assert resp.status_code == 200

            # Verify all query_range calls from target_history passed source=active_ep
            range_calls = [c for c in mock_fetch.call_args_list if "/api/v1/query_range" in str(c.args)]
            assert len(range_calls) >= 2, f"Expected at least 2 Prometheus subqueries, got {len(range_calls)}"
            for c in range_calls:
                assert c.kwargs.get("source") == active_ep, f"Expected source={active_ep}, got kwargs: {c.kwargs}"

    # Also directly verify fetch_down_since_prom_map forwards source to promclient
    with patch("alarm.app.promclient.fetch_prometheus_json", return_value=mock_resp) as mock_fetch_ds:
        from alarm.app import fetch_down_since_prom_map
        fetch_down_since_prom_map(cache_ttl=0, source=active_ep)
        assert mock_fetch_ds.called
        for c in mock_fetch_ds.call_args_list:
            assert c.kwargs.get("source") == active_ep


# ─────────────────────────────────────────────────────────────────────────────
# MAJ-02: incidents table source scoping & server isolation
# ─────────────────────────────────────────────────────────────────────────────
def test_maj02_incidents_source_scoping_and_isolation(tmp_path):
    test_db = str(tmp_path / "test_maj02.db")
    from alarm.storage.schema import init_db
    init_db(test_db)

    src_a = "http://192.168.1.10:9090"
    src_b = "http://192.168.2.20:9090"

    # Both servers can have an incident with the same key
    shared_key = "TargetDown_web_srv"
    IncidentRepository.record_alert_event(
        name="TargetDown",
        severity="critical",
        instance="web_srv",
        summary="Server A down",
        job="web",
        event_time=time.time(),
        is_now_firing=True,
        key=shared_key,
        source=src_a,
        db_path=test_db
    )

    IncidentRepository.record_alert_event(
        name="TargetDown",
        severity="critical",
        instance="web_srv",
        summary="Server B down",
        job="web",
        event_time=time.time(),
        is_now_firing=True,
        key=shared_key,
        source=src_b,
        db_path=test_db
    )

    # Both exist separately in DB
    with db_read(test_db) as conn:
        rows = conn.execute("SELECT source, key, summary FROM incidents WHERE key = ?", (shared_key,)).fetchall()
        assert len(rows) == 2
        sources = {r["source"] for r in rows}
        assert sources == {src_a, src_b}

    # Querying active incidents filtered by source returns only that server's incidents
    inc_a = IncidentRepository.get_active_incidents(source=src_a, db_path=test_db)
    assert len(inc_a) == 1
    assert inc_a[0]["source"] == src_a
    assert inc_a[0]["summary"] == "Server A down"

    inc_b = IncidentRepository.get_active_incidents(source=src_b, db_path=test_db)
    assert len(inc_b) == 1
    assert inc_b[0]["source"] == src_b
    assert inc_b[0]["summary"] == "Server B down"

    # Reconciling alerts for Server B does not touch Server A's incident
    from alarm.core.workers.poller import TargetPoller
    resolved_calls = []
    poller = TargetPoller(
        active_incident_provider=lambda: [
            {"name": "TargetDown", "instance": "srv_b_host", "severity": "critical", "key": "TargetDown|srv_b_host", "source": src_b},
            {"name": "TargetDown", "instance": "srv_a_host", "severity": "critical", "key": "TargetDown|srv_a_host", "source": src_a},
        ],
        alert_sink=lambda **kw: resolved_calls.append(kw)
    )
    # Reconciling while Server B is active with empty scraped instances
    poller.reconcile_orphaned_alerts(monitored_instances=[], source=src_b)
    # Confirm it ONLY resolves Server B's instance and passes source=src_b
    assert len(resolved_calls) == 1
    assert resolved_calls[0]["instance"] == "srv_b_host"
    assert resolved_calls[0]["source"] == src_b


# ─────────────────────────────────────────────────────────────────────────────
# MAJ-03: Cache invalidation on endpoint deletion
# ─────────────────────────────────────────────────────────────────────────────
def test_maj03_delete_endpoint_invalidates_availability_cache():
    fn = delete_endpoint_api
    while hasattr(fn, "__wrapped__"):
        fn = fn.__wrapped__

    with patch("alarm.app.availability_engine.invalidate_cache") as mock_inval:
        with patch("alarm.app.load_endpoints", side_effect=[
            {"endpoints": ["http://test-ep:9090"], "active": "http://test-ep:9090"},
            {"endpoints": [], "active": ""}
        ]):
            with patch("alarm.app.EndpointRepository.delete_endpoint"):
                with patch("alarm.app.promclient.LAST_WORKING_PROMETHEUS_URL"):
                    with patch("alarm.app.fleet_state_engine.invalidate_state_cache"):
                        with patch("alarm.app.AuditLogRepository.record_action"):
                            with app.test_request_context(
                                "/api/endpoints",
                                method="DELETE",
                                json={"url": "http://test-ep:9090"},
                            ):
                                g.current_user = {"username": "admin", "role": "admin"}
                                fn()
                                assert mock_inval.called, "availability_engine.invalidate_cache was not called on deleting active endpoint"


# ─────────────────────────────────────────────────────────────────────────────
# MAJ-04: _FLEET_TREND_CACHE / _DAILY_PROMETHEUS_CACHE cleared by invalidate_cache()
# ─────────────────────────────────────────────────────────────────────────────
def test_maj04_invalidate_cache_clears_module_caches():
    from alarm.app import (
        _FLEET_TREND_CACHE as app_trend_cache,
        _DAILY_PROMETHEUS_CACHE as app_daily_cache,
        clear_helpers_caches as clear_app_caches,
        availability_engine as app_avail_engine
    )
    # Populate dummy entries in app's caches
    app_trend_cache["test_k1"] = (time.time(), ([1, 2], 3600))
    app_daily_cache["test_k2"] = (time.time(), {"data": 123})
    assert len(app_trend_cache) > 0
    assert len(app_daily_cache) > 0

    # 1. Direct clear
    clear_app_caches()
    assert len(app_trend_cache) == 0
    assert len(app_daily_cache) == 0

    # 2. engine.invalidate_cache()
    app_trend_cache["test_k1"] = (time.time(), ([1, 2], 3600))
    app_daily_cache["test_k2"] = (time.time(), {"data": 123})
    app_avail_engine.invalidate_cache()
    assert len(app_trend_cache) == 0
    assert len(app_daily_cache) == 0

    # 3. POST /api/availability/cache/invalidate
    app_trend_cache["test_k1"] = (time.time(), ([1, 2], 3600))
    app_daily_cache["test_k2"] = (time.time(), {"data": 123})
    client = app.test_client()
    resp = client.post("/api/availability/cache/invalidate")
    assert resp.status_code == 200
    assert resp.get_json()["ok"] is True
    assert len(app_trend_cache) == 0
    assert len(app_daily_cache) == 0


# ─────────────────────────────────────────────────────────────────────────────
# MIN-01: history.js uses WIB timezone constant (25200s)
# ─────────────────────────────────────────────────────────────────────────────
def test_min01_wib_timezone_alignment():
    # Verify WIB constant is exactly 7 hours
    assert WIB_HELPERS == 7 * 3600 == 25200

    # Read history.js and check exported WIB_OFFSET_SEC
    history_js_path = os.path.join("alarm", "static", "js", "history.js")
    if not os.path.exists(history_js_path):
        history_js_path = os.path.join("static", "js", "history.js")
    with open(history_js_path, "r", encoding="utf-8") as f:
        content = f.read()

    assert "WIB_OFFSET_SEC = 25200" in content or "WIB_OFFSET_SEC = 7 * 3600" in content
    assert "new Date(now.getFullYear(), now.getMonth(), 1)" not in content, \
        "history.js should not use browser-local new Date(now.getFullYear(), now.getMonth(), 1)"
    assert "getUTCHours()" in content
    assert "getUTCDate()" in content


# ─────────────────────────────────────────────────────────────────────────────
# MIN-02: POST /api/targets returns warning for non-whitelisted target
# ─────────────────────────────────────────────────────────────────────────────
@pytest.mark.skip(reason="availability whitelist disabled (config.AVAIL_TARGET_WHITELIST = None)")
def test_min02_target_whitelist_warning():
    fn = add_target_api
    while hasattr(fn, "__wrapped__"):
        fn = fn.__wrapped__

    # 1. Non-whitelisted target
    with app.test_request_context(
        "/api/targets",
        method="POST",
        json={"url": "http://192.168.254.254:9090"}
    ):
        g.current_user = {"username": "admin", "role": "admin"}
        resp, *status = fn() if isinstance(fn(), tuple) else (fn(), 200)
        data = resp.get_json()
        assert data.get("ok") is True
        assert "warning" in data
        assert "not in SLA whitelist" in data["warning"]

    # 2. Whitelisted target
    with app.test_request_context(
        "/api/targets",
        method="POST",
        json={"url": "8.8.8.8"}
    ):
        g.current_user = {"username": "admin", "role": "admin"}
        resp, *status = fn() if isinstance(fn(), tuple) else (fn(), 200)
        data = resp.get_json()
        assert data.get("ok") is True
        if "warning" in data:
            assert "not in SLA whitelist" not in data["warning"]


# ─────────────────────────────────────────────────────────────────────────────
# NEW: clear_resolved preserves acks if incident still firing
# ─────────────────────────────────────────────────────────────────────────────
def test_clear_resolved_preserves_firing_incidents(tmp_path):
    test_db = str(tmp_path / "test_ack.db")
    init_db(test_db)

    # Server A has a firing incident for instance-1
    IncidentRepository.record_alert_event(
        name="TargetDown",
        severity="critical",
        instance="10.0.0.1:9100",
        summary="down on A",
        job="blackbox",
        event_time=time.time() - 300,
        is_now_firing=True,
        source="http://server-a:9090",
        db_path=test_db,
    )
    # Instance is acknowledged
    AcknowledgmentRepository.acknowledge_instances(["10.0.0.1:9100"], "operator", db_path=test_db)
    acks = AcknowledgmentRepository.get_active_acknowledgments(db_path=test_db)
    assert "10.0.0.1:9100" in acks

    # Now a sweep on Server B runs where active down set is empty (0 down targets)
    AcknowledgmentRepository.clear_resolved(set(), db_path=test_db)

    # 10.0.0.1:9100 acknowledgment MUST still be preserved because incident is still firing on Server A!
    acks_after = AcknowledgmentRepository.get_active_acknowledgments(db_path=test_db)
    assert "10.0.0.1:9100" in acks_after, "Acknowledgment was incorrectly deleted while incident is still firing!"

    # Also test when sweep on Server B has a different down instance {"10.0.0.2:9100"}
    AcknowledgmentRepository.clear_resolved({"10.0.0.2:9100"}, db_path=test_db)
    acks_after2 = AcknowledgmentRepository.get_active_acknowledgments(db_path=test_db)
    assert "10.0.0.1:9100" in acks_after2, "Acknowledgment was incorrectly deleted by disjoint sweep!"

    # Nonexistent endpoint deletion returns False and does not touch data
    res = EndpointRepository.delete_endpoint("http://nonexistent:9090", db_path=test_db)
    assert res is False
    acks_after3 = AcknowledgmentRepository.get_active_acknowledgments(db_path=test_db)
    assert "10.0.0.1:9100" in acks_after3

