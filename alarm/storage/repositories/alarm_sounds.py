"""Alarm sound metadata repository for InfraWatch.

Manages sound records stored in SQLite while audio files are stored in the managed data/alarm-sounds/ directory.
"""
import time
from typing import List, Dict, Any, Optional

try:
    from alarm.storage.connection import db_read, db_transaction
except (ImportError, ValueError):
    from storage.connection import db_read, db_transaction


class AlarmSoundRepository:
    """Repository for querying, inserting, and deleting alarm sound metadata."""

    @staticmethod
    def list_sounds(db_path: Optional[str] = None) -> List[Dict[str, Any]]:
        """List all registered alarm sounds, built-in first, then newest custom sounds."""
        with db_read(db_path) as conn:
            rows = conn.execute("""
                SELECT id, name, source, filename, duration, file_size, mime_type, created_at, created_by
                FROM alarm_sounds
                ORDER BY CASE WHEN source = 'builtin' THEN 0 ELSE 1 END ASC, created_at DESC
            """).fetchall()

            return [
                {
                    "id": r["id"],
                    "name": r["name"],
                    "source": r["source"],
                    "filename": r["filename"],
                    "duration": r["duration"],
                    "file_size": r["file_size"],
                    "mime_type": r["mime_type"],
                    "created_at": r["created_at"],
                    "created_by": r["created_by"],
                    "is_builtin": r["source"] == "builtin"
                }
                for r in rows
            ]

    @staticmethod
    def get_sound(sound_id: str, db_path: Optional[str] = None) -> Optional[Dict[str, Any]]:
        """Retrieve a specific sound record by ID."""
        if not sound_id:
            return None
        with db_read(db_path) as conn:
            r = conn.execute("""
                SELECT id, name, source, filename, duration, file_size, mime_type, created_at, created_by
                FROM alarm_sounds
                WHERE id = ?
            """, (sound_id,)).fetchone()

            if not r:
                return None

            return {
                "id": r["id"],
                "name": r["name"],
                "source": r["source"],
                "filename": r["filename"],
                "duration": r["duration"],
                "file_size": r["file_size"],
                "mime_type": r["mime_type"],
                "created_at": r["created_at"],
                "created_by": r["created_by"],
                "is_builtin": r["source"] == "builtin"
            }

    @staticmethod
    def create_sound(
        sound_id: str,
        name: str,
        source: str,
        filename: str,
        duration: Optional[float] = None,
        file_size: int = 0,
        mime_type: str = "audio/mpeg",
        created_by: str = "system",
        db_path: Optional[str] = None
    ) -> Dict[str, Any]:
        """Insert a new sound metadata record into the database."""
        now = time.time()
        with db_transaction(db_path) as conn:
            conn.execute("""
                INSERT INTO alarm_sounds (id, name, source, filename, duration, file_size, mime_type, created_at, created_by)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """, (sound_id, name, source, filename, duration, file_size, mime_type, now, created_by))

        return {
            "id": sound_id,
            "name": name,
            "source": source,
            "filename": filename,
            "duration": duration,
            "file_size": file_size,
            "mime_type": mime_type,
            "created_at": now,
            "created_by": created_by,
            "is_builtin": source == "builtin"
        }

    @staticmethod
    def delete_sound(sound_id: str, db_path: Optional[str] = None) -> bool:
        """Delete a sound metadata record by ID. Builtin sound cannot be deleted."""
        if sound_id == "alarm-default":
            return False
        with db_transaction(db_path) as conn:
            cursor = conn.execute("DELETE FROM alarm_sounds WHERE id = ? AND source != 'builtin'", (sound_id,))
            return cursor.rowcount > 0
