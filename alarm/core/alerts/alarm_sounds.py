"""Alarm Sound Management for InfraWatch.

Handles audio file upload, validation, storage, and retrieval for the Alarm Policy.
Supports built-in sound, custom audio files (MP3, WAV, OGG), and external audio import abstraction.
"""
import glob
import io
import logging
import os
import re
import uuid
import wave
from typing import Any, Dict, Optional, Tuple

logger = logging.getLogger("infrawatch.alarm_sounds")

try:
    from config import DATA_DIR, ALARM_DIR
except ImportError:
    from alarm.config import DATA_DIR, ALARM_DIR

try:
    from storage.repositories.alarm_sounds import AlarmSoundRepository
except ImportError:
    from alarm.storage.repositories.alarm_sounds import AlarmSoundRepository

ALARM_SOUNDS_DIR = os.environ.get("INFRAWATCH_SOUNDS_DIR") or os.path.join(DATA_DIR, "alarm-sounds")

ALLOWED_EXTENSIONS = {".mp3", ".wav", ".ogg", ".m4a", ".webm"}
MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024  # 10 MB

MIME_TYPE_MAP = {
    ".mp3": "audio/mpeg",
    ".wav": "audio/wav",
    ".ogg": "audio/ogg",
    ".m4a": "audio/mp4",
    ".webm": "audio/webm",
}


def get_sounds_dir() -> str:
    """Return managed directory for custom alarm sound files, ensuring it exists."""
    os.makedirs(ALARM_SOUNDS_DIR, exist_ok=True)
    return ALARM_SOUNDS_DIR


def get_builtin_sound_path() -> str:
    """Return filesystem path to the built-in InfraWatch alarm sound."""
    return os.path.join(ALARM_DIR, "static", "audio", "alarm.mp3")


def is_valid_audio_magic_bytes(header: bytes, ext: str) -> bool:
    """Check magic bytes to ensure file is genuinely the claimed audio type and not executable/script."""
    if not header or len(header) < 4:
        return False

    # Block common executable and script signatures
    dangerous_signatures = [
        b"MZ",           # Windows PE executable
        b"\x7fELF",      # Linux ELF executable
        b"\xfe\xed\xfa", # Mach-O binary
        b"\xce\xfa\xed",
        b"#!",           # Shebang script
        b"<?php",        # PHP script
        b"<html",        # HTML document
        b"<!DOCTYPE",
        b"PK\x03\x04",   # ZIP / JAR / APK
    ]
    for sig in dangerous_signatures:
        if header.startswith(sig) or (header.lower().startswith(b"<!doctype") or header.lower().startswith(b"<html")):
            return False

    if ext == ".mp3":
        # ID3 header: b'ID3' at offset 0
        if header.startswith(b"ID3"):
            return True
        # Raw MPEG-1/2 Audio Layer III sync word (first 11 bits are 1s, e.g. 0xFF 0xFB, 0xFF 0xF3, 0xFF 0xF2, 0xFF 0xFA)
        if header[0] == 0xFF and (header[1] & 0xE0) == 0xE0:
            return True
        return False

    if ext == ".wav":
        # RIFF header: starts with b'RIFF' and has b'WAVE' at offset 8
        if len(header) >= 12 and header.startswith(b"RIFF") and header[8:12] == b"WAVE":
            return True
        return False

    if ext == ".ogg":
        # Ogg container: starts with b'OggS'
        if header.startswith(b"OggS"):
            return True
        return False

    if ext == ".m4a":
        # ISO base media container (mp4/m4a) with 'ftyp' at offset 4 or box header
        if (len(header) >= 8 and header[4:8] == b"ftyp") or header.startswith(b"\x00\x00\x00"):
            return True
        return False

    if ext == ".webm":
        # EBML container: starts with 0x1A 0x45 0xDF 0xA3
        if header.startswith(b"\x1a\x45\xdf\xa3"):
            return True
        return False

    return False


def estimate_audio_duration(file_path: str, ext: str) -> Optional[float]:
    """Attempt to estimate audio duration in seconds using standard library where possible."""
    try:
        if ext == ".wav":
            with wave.open(file_path, "rb") as w:
                frames = w.getnframes()
                rate = w.getframerate()
                if rate > 0:
                    return round(frames / float(rate), 2)
        elif ext == ".mp3":
            # Check ID3v2 TLEN tag if present
            with open(file_path, "rb") as f:
                head = f.read(1024)
                if head.startswith(b"ID3"):
                    tlen_idx = head.find(b"TLEN")
                    if tlen_idx != -1 and tlen_idx + 10 < len(head):
                        size_bytes = head[tlen_idx + 4 : tlen_idx + 8]
                        # TLEN payload is ASCII text millisecond count
                        val_raw = head[tlen_idx + 10 : tlen_idx + 24].decode("latin1", errors="ignore")
                        num_match = re.search(r"\d+", val_raw)
                        if num_match:
                            ms = float(num_match.group(0))
                            if ms > 0:
                                return round(ms / 1000.0, 2)
            # Fallback estimation for 128kbps standard audio
            file_size = os.path.getsize(file_path)
            if file_size > 0:
                est = file_size / (128 * 1024 / 8)
                return round(min(max(est, 1.0), 300.0), 2)
    except Exception as e:
        logger.debug("Failed to read audio duration for %s: %s", file_path, e)
    return None


def sanitize_sound_name(raw_name: str) -> str:
    """Sanitize user-provided sound label, stripping tags and dangerous characters."""
    if not raw_name:
        return "Custom Sound"
    clean = re.sub(r"[<>\"\'&;]+", "", raw_name).strip()
    clean = re.sub(r"\s+", " ", clean)
    if not clean:
        return "Custom Sound"
    return clean[:60]


def save_uploaded_sound(
    file_bytes: bytes,
    original_filename: str,
    custom_name: Optional[str] = None,
    created_by: str = "system"
) -> Tuple[bool, Optional[str], Optional[Dict[str, Any]]]:
    """Validate and persist an uploaded audio file.
    
    Returns (ok, error_msg, sound_record).
    """
    if not file_bytes:
        return False, "Uploaded file is empty", None

    file_size = len(file_bytes)
    if file_size > MAX_FILE_SIZE_BYTES:
        return False, f"Audio file exceeds maximum size limit of {MAX_FILE_SIZE_BYTES // (1024 * 1024)}MB", None

    _, ext = os.path.splitext(original_filename or "")
    ext = ext.lower()
    if ext not in ALLOWED_EXTENSIONS:
        return False, f"Unsupported audio format '{ext}'. Allowed formats: MP3, WAV, OGG", None

    # Inspect magic bytes
    if not is_valid_audio_magic_bytes(file_bytes[:512], ext):
        return False, f"File content does not match a valid {ext[1:].upper()} audio file header", None

    sound_id = f"alarm-custom-{uuid.uuid4().hex[:8]}"
    storage_filename = f"{sound_id}{ext}"
    target_dir = get_sounds_dir()
    target_path = os.path.join(target_dir, storage_filename)

    try:
        with open(target_path, "wb") as f:
            f.write(file_bytes)
    except Exception as e:
        logger.error("Failed to write custom sound file %s: %s", target_path, e)
        return False, f"Failed to save audio file to disk: {str(e)}", None

    duration = estimate_audio_duration(target_path, ext)
    mime_type = MIME_TYPE_MAP.get(ext, "audio/mpeg")

    display_name = sanitize_sound_name(
        custom_name if custom_name and custom_name.strip() else os.path.splitext(original_filename)[0]
    )

    try:
        sound_record = AlarmSoundRepository.create_sound(
            sound_id=sound_id,
            name=display_name,
            source="upload",
            filename=storage_filename,
            duration=duration,
            file_size=file_size,
            mime_type=mime_type,
            created_by=created_by,
        )
        return True, None, sound_record
    except Exception as e:
        logger.error("Failed to insert sound metadata for %s: %s", sound_id, e)
        try:
            if os.path.exists(target_path):
                os.remove(target_path)
        except Exception:
            pass
        return False, f"Failed to record sound metadata: {str(e)}", None


def resolve_sound_file_path(sound_id: str) -> Tuple[str, str]:
    """Resolve sound ID to an absolute file path and MIME type.
    
    If custom sound is missing from disk, cleanly falls back to the built-in sound.
    """
    builtin_path = get_builtin_sound_path()

    if not sound_id or sound_id == "alarm-default":
        return builtin_path, "audio/mpeg"

    sound = AlarmSoundRepository.get_sound(sound_id)
    if not sound:
        logger.warning("Requested sound_id '%s' not found, falling back to built-in sound", sound_id)
        return builtin_path, "audio/mpeg"

    safe_filename = os.path.basename(sound["filename"])
    custom_path = os.path.join(get_sounds_dir(), safe_filename)

    if not os.path.isfile(custom_path):
        logger.warning(
            "Custom audio file for sound '%s' missing at %s, falling back to built-in sound",
            sound_id,
            custom_path,
        )
        return builtin_path, "audio/mpeg"

    return custom_path, sound.get("mime_type", "audio/mpeg")


def delete_custom_sound(sound_id: str, active_sound_id: Optional[str] = None) -> Tuple[bool, Optional[str]]:
    """Delete a custom sound record and its file.
    
    Guards built-in sound and currently active policy sound.
    """
    if sound_id == "alarm-default":
        return False, "Cannot delete built-in InfraWatch alarm sound."

    if active_sound_id and sound_id == active_sound_id:
        return False, "Cannot delete the sound currently active in Alarm Policy. Switch to another sound or InfraWatch Default first."

    sound = AlarmSoundRepository.get_sound(sound_id)
    if not sound:
        return False, f"Sound '{sound_id}' not found."

    safe_filename = os.path.basename(sound["filename"])
    custom_path = os.path.join(get_sounds_dir(), safe_filename)

    try:
        if os.path.isfile(custom_path):
            os.remove(custom_path)
    except Exception as e:
        logger.warning("Failed to remove sound file %s: %s", custom_path, e)

    deleted = AlarmSoundRepository.delete_sound(sound_id)
    if not deleted:
        return False, f"Failed to delete sound '{sound_id}' from database."

    return True, None


def import_youtube_sound(
    url: str,
    custom_name: Optional[str] = None,
    created_by: str = "system"
) -> Tuple[bool, Optional[str], Optional[Dict[str, Any]]]:
    """Validate YouTube URL and extract audio if supported backend is available.
    
    Provides a complete abstraction that rejects invalid URLs and returns clean guidance
    when host extraction dependencies are not installed.
    """
    if not url or not isinstance(url, str):
        return False, "YouTube URL is required", None

    url = url.strip()
    yt_regex = r"^https?:\/\/(www\.)?(youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/shorts\/)([a-zA-Z0-9_-]{11})"
    match = re.match(yt_regex, url)
    if not match:
        return False, "Invalid YouTube URL format. Expected: https://www.youtube.com/watch?v=... or https://youtu.be/...", None

    video_id = match.group(3)

    # Check if yt-dlp is available in the environment
    try:
        import yt_dlp
    except ImportError:
        return False, (
            "YouTube audio extraction requires yt-dlp on the host server. "
            "Please upload an MP3, WAV, or OGG audio file directly instead."
        ), None

    # If yt_dlp is installed, extract audio safely
    try:
        import shutil
        has_ffmpeg = bool(shutil.which("ffmpeg"))
        sound_id = f"alarm-custom-yt-{video_id[:8]}"
        target_dir = get_sounds_dir()
        out_template = os.path.join(target_dir, f"{sound_id}.%(ext)s")

        ydl_opts = {
            "outtmpl": out_template,
            "quiet": True,
            "no_warnings": True,
            "socket_timeout": 20,
            "retries": 2,
        }

        if has_ffmpeg:
            ydl_opts["format"] = "bestaudio/best"
            ydl_opts["postprocessors"] = [{
                "key": "FFmpegExtractAudio",
                "preferredcodec": "mp3",
                "preferredquality": "192",
            }]
        else:
            # Standalone audio formats supported natively by modern browsers without ffmpeg conversion
            ydl_opts["format"] = "ba[ext=m4a]/ba[ext=mp3]/ba[ext=webm]/ba"

        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            info = ydl.extract_info(url, download=True)
            title = info.get("title", f"YouTube Audio ({video_id})")
            duration = info.get("duration")

        # Locate the downloaded file
        candidates = glob.glob(os.path.join(target_dir, f"{sound_id}.*"))
        if not candidates:
            return False, "Failed to locate extracted audio file on disk.", None

        actual_path = candidates[0]
        actual_filename = os.path.basename(actual_path)
        _, ext = os.path.splitext(actual_filename)
        ext = ext.lower()
        file_size = os.path.getsize(actual_path)
        mime_type = MIME_TYPE_MAP.get(ext, "audio/mp4" if ext == ".m4a" else "audio/mpeg")

        display_name = sanitize_sound_name(custom_name if custom_name and custom_name.strip() else title)

        sound_record = AlarmSoundRepository.create_sound(
            sound_id=sound_id,
            name=display_name,
            source="youtube",
            filename=actual_filename,
            duration=duration,
            file_size=file_size,
            mime_type=mime_type,
            created_by=created_by,
        )
        return True, None, sound_record
    except Exception as e:
        logger.error("Failed to extract YouTube audio from %s: %s", url, e)
        return False, f"Failed to download audio from YouTube: {str(e)}", None
