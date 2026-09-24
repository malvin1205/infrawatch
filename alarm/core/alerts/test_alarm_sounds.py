"""Unit tests for Custom Alarm Sound feature and AlarmSoundRepository."""
import io
import os
import shutil
import tempfile
import pytest

from storage.schema import init_db
from storage.repositories.alarm_sounds import AlarmSoundRepository
from core.alerts.alarm_sounds import (
    save_uploaded_sound,
    resolve_sound_file_path,
    delete_custom_sound,
    import_youtube_sound,
    is_valid_audio_magic_bytes,
    get_sounds_dir,
    get_builtin_sound_path,
)
from core.alerts.alarm_policy import (
    validate_alarm_policy,
    get_alarm_policy,
    save_alarm_policy,
    DEFAULT_ALARM_POLICY,
    reset_alarm_policy_cache,
)


@pytest.fixture(autouse=True)
def temp_environment(monkeypatch):
    """Isolate DB, sounds directory, and policy file for each test."""
    temp_dir = tempfile.mkdtemp(prefix="iw_sound_test_")
    db_path = os.path.join(temp_dir, "test.db")
    sounds_dir = os.path.join(temp_dir, "alarm-sounds")
    policy_file = os.path.join(temp_dir, "alarm_policy.json")

    monkeypatch.setenv("INFRAWATCH_DB_PATH", db_path)
    monkeypatch.setenv("INFRAWATCH_DATA_DIR", temp_dir)
    monkeypatch.setenv("INFRAWATCH_SOUNDS_DIR", sounds_dir)

    import core.alerts.alarm_policy as ap_mod
    import core.alerts.alarm_sounds as as_mod
    monkeypatch.setattr(ap_mod, "POLICY_FILE", policy_file)
    monkeypatch.setattr(as_mod, "ALARM_SOUNDS_DIR", sounds_dir)

    init_db(db_path)
    reset_alarm_policy_cache()

    yield

    shutil.rmtree(temp_dir, ignore_errors=True)
    reset_alarm_policy_cache()


def test_builtin_sound_always_present():
    """Verify built-in alarm sound exists by default."""
    sounds = AlarmSoundRepository.list_sounds()
    assert len(sounds) >= 1
    default_sound = next((s for s in sounds if s["id"] == "alarm-default"), None)
    assert default_sound is not None
    assert default_sound["name"] == "InfraWatch Default"
    assert default_sound["is_builtin"] is True


def test_magic_bytes_validation():
    """Verify audio magic bytes header inspection."""
    # Valid MP3 (ID3 header)
    assert is_valid_audio_magic_bytes(b"ID3\x03\x00\x00\x00\x00\x00\x00", ".mp3") is True
    # Valid MP3 (MPEG sync frame)
    assert is_valid_audio_magic_bytes(b"\xff\xfb\x90\x64\x00\x00\x00\x00", ".mp3") is True

    # Valid WAV (RIFF...WAVE)
    assert is_valid_audio_magic_bytes(b"RIFF\x24\x00\x00\x00WAVEfmt ", ".wav") is True

    # Valid OGG (OggS)
    assert is_valid_audio_magic_bytes(b"OggS\x00\x02\x00\x00\x00\x00", ".ogg") is True

    # Reject executable / script / HTML
    assert is_valid_audio_magic_bytes(b"MZ\x90\x00\x03\x00\x00\x00", ".mp3") is False
    assert is_valid_audio_magic_bytes(b"\x7fELF\x02\x01\x01\x00", ".wav") is False
    assert is_valid_audio_magic_bytes(b"#!/bin/bash\necho bad", ".ogg") is False
    assert is_valid_audio_magic_bytes(b"<!DOCTYPE html><html>", ".mp3") is False


def test_upload_valid_mp3_sound():
    """Test successful upload of valid MP3 sound file."""
    fake_mp3 = b"ID3\x03\x00\x00\x00\x00\x00\x20" + b"\x00" * 500
    ok, err, sound = save_uploaded_sound(
        file_bytes=fake_mp3,
        original_filename="server_room_siren.mp3",
        custom_name="Server Room Siren",
        created_by="operator1"
    )
    assert ok is True
    assert err is None
    assert sound is not None
    assert sound["name"] == "Server Room Siren"
    assert sound["source"] == "upload"
    assert sound["is_builtin"] is False
    assert sound["id"].startswith("alarm-custom-")

    # Verify presence in database
    retrieved = AlarmSoundRepository.get_sound(sound["id"])
    assert retrieved is not None
    assert retrieved["id"] == sound["id"]
    assert retrieved["name"] == "Server Room Siren"

    # Verify physical file existence
    path, mime = resolve_sound_file_path(sound["id"])
    assert os.path.isfile(path)
    assert mime == "audio/mpeg"


def test_upload_rejects_invalid_extension_and_content():
    """Test validation rejection of forbidden extensions and forged contents."""
    # Bad extension
    ok, err, _ = save_uploaded_sound(
        file_bytes=b"some bytes",
        original_filename="malicious.exe",
        custom_name="Dangerous Executable"
    )
    assert ok is False
    assert "Unsupported audio format" in err

    # Renamed text/script with .mp3 extension
    ok, err, _ = save_uploaded_sound(
        file_bytes=b"This is just plain text, not an audio file",
        original_filename="fake.mp3",
        custom_name="Fake Audio"
    )
    assert ok is False
    assert "header" in err.lower()


def test_upload_rejects_oversized_file():
    """Test rejection of files exceeding size limit."""
    huge_bytes = b"ID3" + b"\x00" * (11 * 1024 * 1024)
    ok, err, _ = save_uploaded_sound(
        file_bytes=huge_bytes,
        original_filename="too_large.mp3",
        custom_name="Huge Sound"
    )
    assert ok is False
    assert "exceeds maximum size limit" in err


def test_delete_built_in_sound_forbidden():
    """Built-in alarm-default sound must never be deleted."""
    ok, err = delete_custom_sound("alarm-default")
    assert ok is False
    assert "Cannot delete built-in" in err


def test_delete_active_policy_sound_blocked():
    """Active sound referenced in the current Alarm Policy must be protected from deletion."""
    fake_wav = b"RIFF\x24\x00\x00\x00WAVEfmt \x10\x00\x00\x00\x01\x00\x01\x00\x44\xac\x00\x00\x88\x58\x01\x00\x02\x00\x10\x00data\x00\x00\x00\x00"
    ok, _, sound = save_uploaded_sound(fake_wav, "alert.wav", "Active Siren")
    assert ok is True

    # Attempt delete while active
    ok, err = delete_custom_sound(sound["id"], active_sound_id=sound["id"])
    assert ok is False
    assert "currently active" in err

    # Attempt delete after switching active sound
    ok, err = delete_custom_sound(sound["id"], active_sound_id="alarm-default")
    assert ok is True
    assert err is None
    assert AlarmSoundRepository.get_sound(sound["id"]) is None


def test_resolve_sound_fallback_on_missing_file():
    """Missing or deleted audio file on disk must cleanly fallback to built-in sound without crashing."""
    # Unknown ID
    path, mime = resolve_sound_file_path("alarm-custom-nonexistent")
    assert os.path.isfile(path)
    assert path.endswith("alarm.mp3")

    # Registered in DB but missing from disk
    fake_mp3 = b"ID3\x03\x00\x00\x00\x00\x00\x20" + b"\x00" * 100
    ok, _, sound = save_uploaded_sound(fake_mp3, "temp.mp3", "Temporary")
    assert ok is True
    sound_path, _ = resolve_sound_file_path(sound["id"])
    assert os.path.isfile(sound_path)

    # Delete file from disk manually
    os.remove(sound_path)
    fallback_path, fallback_mime = resolve_sound_file_path(sound["id"])
    assert os.path.isfile(fallback_path)
    assert fallback_path.endswith("alarm.mp3")


def test_alarm_policy_sound_id_persistence():
    """Test policy validation, defaults, and persistence with sound_id."""
    policy = get_alarm_policy()
    assert policy.get("sound_id") == "alarm-default"

    # Register custom sound
    fake_mp3 = b"ID3\x03\x00\x00\x00\x00\x00\x20" + b"\x00" * 100
    ok, _, sound = save_uploaded_sound(fake_mp3, "bell.mp3", "NOC Bell")
    assert ok is True

    # Save policy with custom sound_id
    ok, err, saved = save_alarm_policy({"sound_id": sound["id"], "initial_delay_s": 20})
    assert ok is True
    assert saved["sound_id"] == sound["id"]
    assert saved["initial_delay_s"] == 20

    # Retrieve and verify persistence
    reset_alarm_policy_cache()
    reloaded = get_alarm_policy()
    assert reloaded["sound_id"] == sound["id"]
    assert reloaded["initial_delay_s"] == 20


def test_youtube_import_url_validation(monkeypatch):
    """Test YouTube URL structure validation and missing dependency guidance."""
    # Invalid URL format
    ok, err, _ = import_youtube_sound("https://example.com/not-youtube")
    assert ok is False
    assert "Invalid YouTube URL format" in err

    # Simulate missing yt-dlp
    import sys
    monkeypatch.setitem(sys.modules, "yt_dlp", None)
    ok, err, _ = import_youtube_sound("https://www.youtube.com/watch?v=dQw4w9WgXcQ")
    assert ok is False
    assert "yt-dlp" in err
