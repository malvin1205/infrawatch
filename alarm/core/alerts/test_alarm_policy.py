"""Tests for Alarm Policy schema, validation, persistence, and REST endpoints."""
import json
import os
import sys
import tempfile
import pytest

sys.path.insert(0, os.path.abspath("."))
sys.path.insert(0, os.path.abspath("alarm"))

from alarm.core.alerts.alarm_policy import (
    DEFAULT_ALARM_POLICY, ALARM_PRESETS,
    validate_alarm_policy, get_alarm_policy, save_alarm_policy
)


def test_default_alarm_policy_structure():
    assert DEFAULT_ALARM_POLICY["initial_delay_s"] == 15
    assert DEFAULT_ALARM_POLICY["ring_duration_s"] == 10
    assert DEFAULT_ALARM_POLICY["repeat_interval_s"] == 120
    assert DEFAULT_ALARM_POLICY["repeat_enabled"] is True
    assert DEFAULT_ALARM_POLICY["ack_behavior"] == "remind"
    assert DEFAULT_ALARM_POLICY["ack_reminder_interval_s"] == 300
    assert DEFAULT_ALARM_POLICY["ack_reminder_ring_duration_s"] == 10


def test_validate_alarm_policy_valid_inputs():
    valid_payload = {
        "initial_delay_s": 0,  # 0s immediate
        "ring_duration_s": 5,
        "repeat_interval_s": 30,
        "repeat_enabled": False,
        "ack_behavior": "silence",
        "ack_reminder_interval_s": 60,
        "ack_reminder_ring_duration_s": 5,
    }
    ok, err, cleaned = validate_alarm_policy(valid_payload)
    assert ok is True
    assert err is None
    assert cleaned == valid_payload


def test_validate_alarm_policy_boundaries():
    # Negative delay
    ok, err, _ = validate_alarm_policy({"initial_delay_s": -1})
    assert ok is False
    assert "initial_delay_s" in err

    # Zero ring duration
    ok, err, _ = validate_alarm_policy({"ring_duration_s": 0})
    assert ok is False
    assert "ring_duration_s" in err

    # Below minimum repeat interval
    ok, err, _ = validate_alarm_policy({"repeat_interval_s": 2})
    assert ok is False
    assert "repeat_interval_s" in err

    # Invalid boolean
    ok, err, _ = validate_alarm_policy({"repeat_enabled": "true"})
    assert ok is False
    assert "repeat_enabled" in err

    # Invalid ack_behavior
    ok, err, _ = validate_alarm_policy({"ack_behavior": "ignore"})
    assert ok is False
    assert "ack_behavior" in err


def test_save_and_get_alarm_policy(monkeypatch, tmp_path):
    test_file = str(tmp_path / "alarm_policy.json")
    monkeypatch.setattr("alarm.core.alerts.alarm_policy.POLICY_FILE", test_file, raising=False)
    if "core.alerts.alarm_policy" in sys.modules:
        monkeypatch.setattr("core.alerts.alarm_policy.POLICY_FILE", test_file, raising=False)

    # Initial get should return defaults
    pol = get_alarm_policy()
    assert pol["initial_delay_s"] == 15

    # Save custom policy
    update = {
        "initial_delay_s": 25,
        "ring_duration_s": 12,
        "ack_behavior": "silence"
    }
    ok, err, saved = save_alarm_policy(update)
    assert ok is True
    assert err is None
    assert saved["initial_delay_s"] == 25
    assert saved["ring_duration_s"] == 12
    assert saved["ack_behavior"] == "silence"
    # Unchanged fields remain defaults
    assert saved["repeat_interval_s"] == 120

    # Fetch again from disk/cache
    reloaded = get_alarm_policy()
    assert reloaded["initial_delay_s"] == 25
    assert reloaded["ring_duration_s"] == 12
    assert reloaded["ack_behavior"] == "silence"


def test_alarm_policy_api_endpoints(monkeypatch, tmp_path):
    test_file = str(tmp_path / "alarm_policy.json")
    monkeypatch.setattr("alarm.core.alerts.alarm_policy.POLICY_FILE", test_file, raising=False)
    if "core.alerts.alarm_policy" in sys.modules:
        monkeypatch.setattr("core.alerts.alarm_policy.POLICY_FILE", test_file, raising=False)

    import app as alarm_app
    client = alarm_app.app.test_client()

    with client.session_transaction() as sess:
        sess["user_id"] = 1
        sess["epoch"] = 0

    # 1. GET endpoint
    res = client.get("/api/settings/alarm-policy")
    assert res.status_code == 200
    data = res.get_json()
    assert data["ok"] is True
    assert "policy" in data
    assert "presets" in data
    assert data["policy"]["initial_delay_s"] == 15

    # 2. POST endpoint valid
    post_res = client.post("/api/settings/alarm-policy", json={
        "initial_delay_s": 0,
        "ring_duration_s": 5,
        "repeat_interval_s": 45,
        "repeat_enabled": True,
        "ack_behavior": "remind",
        "ack_reminder_interval_s": 90,
        "ack_reminder_ring_duration_s": 5,
    })
    assert post_res.status_code == 200
    post_data = post_res.get_json()
    assert post_data["ok"] is True
    assert post_data["policy"]["initial_delay_s"] == 0
    assert post_data["policy"]["ring_duration_s"] == 5

    # 3. POST endpoint invalid
    bad_res = client.post("/api/settings/alarm-policy", json={"initial_delay_s": -10})
    assert bad_res.status_code == 400
    bad_data = bad_res.get_json()
    assert bad_data["ok"] is False
    assert "error" in bad_data



def test_sound_clip_validation():
    ok, _, c = validate_alarm_policy({"sound_start_s": 80, "sound_end_s": 95})
    assert ok and c == {"sound_start_s": 80.0, "sound_end_s": 95.0}
    ok, _, c = validate_alarm_policy({"sound_start_s": None, "sound_end_s": None})
    assert ok and c == {"sound_start_s": None, "sound_end_s": None}
    for bad, word in (({"sound_start_s": 10}, "sound_end_s"),           # half a pair
                      ({"sound_start_s": 20, "sound_end_s": 10}, "after"),
                      ({"sound_start_s": -1, "sound_end_s": 5}, "0 or more"),
                      ({"sound_start_s": 10, "sound_end_s": 10.5}, "between"),   # < 1s
                      ({"sound_start_s": 0, "sound_end_s": 301}, "between"),     # > 300s
                      ({"sound_start_s": True, "sound_end_s": 5}, "number")):
        ok, err, _ = validate_alarm_policy(bad)
        assert not ok and word in err, (bad, err)


def test_sound_clip_past_youtube_duration_rejected(monkeypatch):
    from alarm.core.alerts import alarm_policy as ap
    monkeypatch.setattr(ap.AlarmSoundRepository, "get_sound",
                        staticmethod(lambda sid, db_path=None: {"id": sid, "source": "youtube", "duration": 240}))
    ok, err, _ = validate_alarm_policy({"sound_id": "yt", "sound_start_s": 230, "sound_end_s": 250})
    assert not ok and "past the end" in err
    ok, _, c = validate_alarm_policy({"sound_id": "yt", "sound_start_s": 80, "sound_end_s": 95})
    assert ok and c["sound_end_s"] == 95.0


def test_switching_sound_drops_old_clip(monkeypatch, tmp_path):
    from alarm.core.alerts import alarm_policy as ap
    monkeypatch.setattr(ap, "POLICY_FILE", str(tmp_path / "p.json"))
    ap.reset_alarm_policy_cache()
    monkeypatch.setattr(ap.AlarmSoundRepository, "get_sound",
                        staticmethod(lambda sid, db_path=None: {"id": sid, "source": "upload", "duration": None}))
    ok, _, saved = save_alarm_policy({"sound_id": "a", "sound_start_s": 5, "sound_end_s": 9})
    assert ok and saved["sound_end_s"] == 9.0
    ok, _, saved = save_alarm_policy({"sound_id": "b"})
    assert saved["sound_start_s"] is None and saved["sound_end_s"] is None
    ok, _, saved = save_alarm_policy({"sound_id": "b", "sound_start_s": 1, "sound_end_s": 3})
    assert get_alarm_policy()["sound_end_s"] == 3.0


def test_refined_timing_fields():
    ok, _, c = validate_alarm_policy({"ack_quiet_s": 30, "repeat_limit": 3, "new_outage_mode": "wait"})
    assert ok and c == {"ack_quiet_s": 30, "repeat_limit": 3, "new_outage_mode": "wait"}
    for bad, word in (({"ack_quiet_s": -1}, "ack_quiet_s"), ({"repeat_limit": 1.5}, "whole"),
                      ({"repeat_limit": 1001}, "1000"), ({"new_outage_mode": "later"}, "ring")):
        ok, err, _ = validate_alarm_policy(bad)
        assert not ok and word in err, (bad, err)


def test_old_policy_file_keeps_first_reminder_timing(monkeypatch, tmp_path):
    from alarm.core.alerts import alarm_policy as ap
    f = tmp_path / "p.json"
    f.write_text(json.dumps({"ack_reminder_interval_s": 10}))
    monkeypatch.setattr(ap, "POLICY_FILE", str(f))
    ap.reset_alarm_policy_cache()
    pol = get_alarm_policy()
    assert pol["ack_quiet_s"] == 10 and pol["repeat_limit"] == 0 and pol["new_outage_mode"] == "ring"
