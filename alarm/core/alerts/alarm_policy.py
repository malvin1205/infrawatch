"""Alarm Policy configuration and persistence for InfraWatch.

Governs the audible alarm lifecycle independently from monitoring truth:
  DOWN -> Initial Delay -> Ring -> Cooldown -> Ring -> ... -> ACK -> (Silence or Reminder) -> RECOVERY

All monitoring/SLA/downtime calculations remain strictly independent and immediate.
"""
import copy
import json
import logging
import os
import threading
from typing import Any, Dict, Optional, Tuple

logger = logging.getLogger("infrawatch.alarm_policy")

try:
    from config import DATA_DIR
except ImportError:
    from alarm.config import DATA_DIR

try:
    from storage.repositories.alarm_sounds import AlarmSoundRepository
except ImportError:
    from alarm.storage.repositories.alarm_sounds import AlarmSoundRepository

POLICY_FILE = os.path.join(DATA_DIR, "alarm_policy.json")

# Default policy preserving safe, conservative defaults:
DEFAULT_ALARM_POLICY: Dict[str, Any] = {
    "initial_delay_s": 15,              # 0s = alarm immediately
    "ring_duration_s": 10,              # duration siren sounds
    "repeat_interval_s": 120,           # cooldown between rings while unacked
    "repeat_enabled": True,             # whether repeat alarming is active
    "ack_behavior": "remind",           # "silence" | "remind"
    "ack_reminder_interval_s": 300,     # wait time after ACK before reminder
    "ack_reminder_ring_duration_s": 10, # duration reminder siren sounds
    "ack_quiet_s": 300,                 # silence right after an ACK, before the first reminder
    "repeat_limit": 0,                  # stop repeating after N repeats (0 = until acknowledged)
    "new_outage_mode": "ring",          # "ring": a new outage rings at once and restarts the
                                        # repeat cycle, even mid-cooldown | "wait": next scheduled ring
    "sound_id": "alarm-default",        # active alarm sound ID
    "sound_start_s": None,              # clip start within the sound (None = whole file)
    "sound_end_s": None,                # clip end within the sound
}

# Clip length bounds. The max matches the longest ring (ring_duration_s <= 300):
# a longer clip would never be heard to its end.
CLIP_MIN_S = 1.0
CLIP_MAX_S = 300.0

# Standard presets for convenience:
ALARM_PRESETS: Dict[str, Dict[str, Any]] = {
    "immediate": {
        "initial_delay_s": 0,
        "ring_duration_s": 10,
        "repeat_interval_s": 60,
        "repeat_enabled": True,
        "ack_behavior": "remind",
        "ack_reminder_interval_s": 300,
        "ack_reminder_ring_duration_s": 10,
        "ack_quiet_s": 300,
        "repeat_limit": 0,
        "new_outage_mode": "ring",
        "sound_id": "alarm-default",
        "sound_start_s": None,
        "sound_end_s": None,
    },
    "short_transient": {
        "initial_delay_s": 15,
        "ring_duration_s": 10,
        "repeat_interval_s": 120,
        "repeat_enabled": True,
        "ack_behavior": "remind",
        "ack_reminder_interval_s": 300,
        "ack_reminder_ring_duration_s": 10,
        "ack_quiet_s": 300,
        "repeat_limit": 0,
        "new_outage_mode": "ring",
        "sound_id": "alarm-default",
        "sound_start_s": None,
        "sound_end_s": None,
    },
    "standard": {
        "initial_delay_s": 30,
        "ring_duration_s": 15,
        "repeat_interval_s": 180,
        "repeat_enabled": True,
        "ack_behavior": "silence",
        "ack_reminder_interval_s": 300,
        "ack_reminder_ring_duration_s": 10,
        "ack_quiet_s": 300,
        "repeat_limit": 0,
        "new_outage_mode": "ring",
        "sound_id": "alarm-default",
        "sound_start_s": None,
        "sound_end_s": None,
    },
}

_policy_lock = threading.RLock()
_cached_policy: Optional[Dict[str, Any]] = None
_cached_mtime: Optional[float] = None
_cached_policy_file: Optional[str] = None


def reset_alarm_policy_cache() -> None:
    """Clear in-memory policy cache."""
    global _cached_policy, _cached_mtime, _cached_policy_file
    with _policy_lock:
        _cached_policy = None
        _cached_mtime = None
        _cached_policy_file = None


def validate_alarm_policy(data: Any) -> Tuple[bool, Optional[str], Dict[str, Any]]:
    """Validate policy fields and ranges. Returns (is_valid, error_msg, cleaned_policy)."""
    if not isinstance(data, dict):
        return False, "Policy payload must be a JSON object", {}

    cleaned: Dict[str, Any] = {}

    # 1. initial_delay_s: 0 to 3600 seconds
    if "initial_delay_s" in data:
        val = data["initial_delay_s"]
        if not isinstance(val, (int, float)) or isinstance(val, bool):
            return False, "initial_delay_s must be a number", {}
        val_int = int(round(val))
        if not (0 <= val_int <= 3600):
            return False, "initial_delay_s must be between 0 and 3600 seconds", {}
        cleaned["initial_delay_s"] = val_int

    # 2. ring_duration_s: 1 to 300 seconds
    if "ring_duration_s" in data:
        val = data["ring_duration_s"]
        if not isinstance(val, (int, float)) or isinstance(val, bool):
            return False, "ring_duration_s must be a number", {}
        val_int = int(round(val))
        if not (1 <= val_int <= 300):
            return False, "ring_duration_s must be between 1 and 300 seconds", {}
        cleaned["ring_duration_s"] = val_int

    # 3. repeat_interval_s: 5 to 86400 seconds
    if "repeat_interval_s" in data:
        val = data["repeat_interval_s"]
        if not isinstance(val, (int, float)) or isinstance(val, bool):
            return False, "repeat_interval_s must be a number", {}
        val_int = int(round(val))
        if not (5 <= val_int <= 86400):
            return False, "repeat_interval_s must be between 5 and 86400 seconds", {}
        cleaned["repeat_interval_s"] = val_int

    # 4. repeat_enabled: bool
    if "repeat_enabled" in data:
        val = data["repeat_enabled"]
        if not isinstance(val, bool):
            return False, "repeat_enabled must be a boolean", {}
        cleaned["repeat_enabled"] = val

    # 5. ack_behavior: "silence" | "remind"
    if "ack_behavior" in data:
        val = str(data["ack_behavior"]).strip().lower()
        if val not in ("silence", "remind"):
            return False, "ack_behavior must be either 'silence' or 'remind'", {}
        cleaned["ack_behavior"] = val

    # 6. ack_reminder_interval_s: 5 to 86400 seconds
    if "ack_reminder_interval_s" in data:
        val = data["ack_reminder_interval_s"]
        if not isinstance(val, (int, float)) or isinstance(val, bool):
            return False, "ack_reminder_interval_s must be a number", {}
        val_int = int(round(val))
        if not (5 <= val_int <= 86400):
            return False, "ack_reminder_interval_s must be between 5 and 86400 seconds", {}
        cleaned["ack_reminder_interval_s"] = val_int

    # 7. ack_reminder_ring_duration_s: 1 to 300 seconds
    if "ack_reminder_ring_duration_s" in data:
        val = data["ack_reminder_ring_duration_s"]
        if not isinstance(val, (int, float)) or isinstance(val, bool):
            return False, "ack_reminder_ring_duration_s must be a number", {}
        val_int = int(round(val))
        if not (1 <= val_int <= 300):
            return False, "ack_reminder_ring_duration_s must be between 1 and 300 seconds", {}
        cleaned["ack_reminder_ring_duration_s"] = val_int

    # 7b. ack_quiet_s: 0 to 86400 seconds of silence after an ACK
    if "ack_quiet_s" in data:
        val = data["ack_quiet_s"]
        if not isinstance(val, (int, float)) or isinstance(val, bool):
            return False, "ack_quiet_s must be a number", {}
        val_int = int(round(val))
        if not (0 <= val_int <= 86400):
            return False, "ack_quiet_s must be between 0 and 86400 seconds", {}
        cleaned["ack_quiet_s"] = val_int

    # 7c. repeat_limit: 0 (no limit) to 1000 repeats
    if "repeat_limit" in data:
        val = data["repeat_limit"]
        if not isinstance(val, (int, float)) or isinstance(val, bool) or val != int(val):
            return False, "repeat_limit must be a whole number", {}
        if not (0 <= int(val) <= 1000):
            return False, "repeat_limit must be between 0 and 1000", {}
        cleaned["repeat_limit"] = int(val)

    # 7d. new_outage_mode: "ring" | "wait"
    if "new_outage_mode" in data:
        val = str(data["new_outage_mode"]).strip().lower()
        if val not in ("ring", "wait"):
            return False, "new_outage_mode must be either 'ring' or 'wait'", {}
        cleaned["new_outage_mode"] = val

    # 8. sound_id: string ID of registered sound (defaults to alarm-default if absent or invalid)
    if "sound_id" in data:
        val = str(data["sound_id"]).strip()
        if not val or val == "alarm-default":
            cleaned["sound_id"] = "alarm-default"
        else:
            try:
                sound_rec = AlarmSoundRepository.get_sound(val)
                if sound_rec:
                    cleaned["sound_id"] = val
                else:
                    logger.warning("Unknown sound_id '%s' passed in policy, defaulting to alarm-default", val)
                    cleaned["sound_id"] = "alarm-default"
            except Exception:
                cleaned["sound_id"] = "alarm-default"

    # 9. sound_start_s / sound_end_s: optional clip of the sound, sent as a pair.
    #    Both None = play the whole file.
    if "sound_start_s" in data or "sound_end_s" in data:
        start, end = data.get("sound_start_s"), data.get("sound_end_s")
        if start is None and end is None:
            cleaned["sound_start_s"] = None
            cleaned["sound_end_s"] = None
        else:
            for name, val in (("sound_start_s", start), ("sound_end_s", end)):
                if not isinstance(val, (int, float)) or isinstance(val, bool) or val != val:
                    return False, f"{name} must be a number (or both null for the whole file)", {}
            start, end = round(float(start), 1), round(float(end), 1)
            if start < 0:
                return False, "sound_start_s must be 0 or more", {}
            if end <= start:
                return False, "sound_end_s must be after sound_start_s", {}
            if not (CLIP_MIN_S <= end - start <= CLIP_MAX_S):
                return False, f"Clip length must be between {CLIP_MIN_S:g} and {CLIP_MAX_S:g} seconds", {}
            # Only yt-dlp's duration is exact; upload durations are estimates
            # (128 kbps guess for MP3), so the browser, which reads the real
            # length, enforces this for those.
            sid = cleaned.get("sound_id")
            if sid and sid != "alarm-default":
                try:
                    rec = AlarmSoundRepository.get_sound(sid)
                except Exception:
                    rec = None
                dur = rec and rec.get("source") == "youtube" and rec.get("duration")
                if dur and end > float(dur) + 0.5:
                    return False, f"sound_end_s ({end:g}s) is past the end of the sound ({float(dur):g}s)", {}
            cleaned["sound_start_s"] = start
            cleaned["sound_end_s"] = end

    return True, None, cleaned


def get_alarm_policy() -> Dict[str, Any]:
    """Retrieve the active Alarm Policy, falling back to defaults if not set."""
    global _cached_policy, _cached_mtime, _cached_policy_file
    with _policy_lock:
        if _cached_policy_file != POLICY_FILE:
            _cached_policy = None
            _cached_mtime = None
            _cached_policy_file = POLICY_FILE

        if os.path.exists(POLICY_FILE):
            try:
                mtime = os.path.getmtime(POLICY_FILE)
                if _cached_policy is not None and _cached_mtime == mtime:
                    return copy.deepcopy(_cached_policy)
                with open(POLICY_FILE, "r", encoding="utf-8") as f:
                    data = json.load(f)
                ok, _, cleaned = validate_alarm_policy(data)
                merged = copy.deepcopy(DEFAULT_ALARM_POLICY)
                if ok:
                    merged.update(cleaned)
                    # Policies saved before ack_quiet_s existed waited one
                    # reminder interval before the first reminder: keep that.
                    if "ack_quiet_s" not in cleaned and "ack_reminder_interval_s" in cleaned:
                        merged["ack_quiet_s"] = cleaned["ack_reminder_interval_s"]
                _cached_policy = merged
                _cached_mtime = mtime
                return copy.deepcopy(merged)
            except Exception as e:
                logger.warning("Failed to read alarm policy from %s: %s", POLICY_FILE, e)

        # Fallback to defaults
        res = copy.deepcopy(DEFAULT_ALARM_POLICY)
        _cached_policy = res
        _cached_mtime = None
        return res


def save_alarm_policy(new_policy: Dict[str, Any]) -> Tuple[bool, Optional[str], Dict[str, Any]]:
    """Validate and atomically persist new Alarm Policy to disk."""
    global _cached_policy, _cached_mtime
    ok, err, cleaned = validate_alarm_policy(new_policy)
    if not ok:
        return False, err, {}

    with _policy_lock:
        try:
            current = get_alarm_policy()
            # A clip belongs to one sound: switching sound without sending a
            # new clip drops the old one instead of cutting the new file at
            # the old sound's timestamps.
            if ("sound_id" in cleaned and cleaned["sound_id"] != current.get("sound_id")
                    and "sound_start_s" not in cleaned):
                cleaned["sound_start_s"] = None
                cleaned["sound_end_s"] = None
            current.update(cleaned)
            tmp_file = f"{POLICY_FILE}.tmp.{os.getpid()}"
            with open(tmp_file, "w", encoding="utf-8") as f:
                json.dump(current, f, indent=2)
            os.replace(tmp_file, POLICY_FILE)
            _cached_policy = copy.deepcopy(current)
            _cached_mtime = os.path.getmtime(POLICY_FILE)
            return True, None, current
        except Exception as e:
            logger.error("Failed to save alarm policy to %s: %s", POLICY_FILE, e)
            return False, f"Failed to save policy: {str(e)}", {}
