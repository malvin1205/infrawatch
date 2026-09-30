"""Self-check for MaintenanceRepository:
1. many windows created in one burst (bulk maintenance) get unique ids;
2. End Early cuts a running window at `now` instead of deleting it, so the
   elapsed maintenance stays excluded from SLA; Cancel deletes a future one;
3. the "Include in SLA" flag round-trips.

Run: python -m alarm.storage.test_maintenance_windows
"""
import os
import tempfile

from alarm.storage.schema import init_db
from alarm.storage.repositories.inventory import MaintenanceRepository as Repo


def main():
    db = os.path.join(tempfile.mkdtemp(), "t.db")
    init_db(db)

    ids = {Repo.create_window("instance", f"h{i}", "", 100.0, 200.0, db_path=db)["id"] for i in range(20)}
    assert len(ids) == 20, "bulk-created ids must be unique"

    running = Repo.create_window("instance", "run", "", 100.0, 500.0, db_path=db)["id"]
    future = Repo.create_window("instance", "fut", "", 400.0, 500.0, sla_excluded=False, db_path=db)["id"]
    assert Repo.delete_window(running, now=300.0, db_path=db)
    assert Repo.delete_window(future, now=300.0, db_path=db)
    by_id = {w["id"]: w for w in Repo.list_windows(db_path=db)}
    assert by_id[running]["end_epoch"] == 300.0, "running window cut at now, not deleted"
    assert future not in by_id, "future window cancelled outright"
    assert not Repo.delete_window("missing", db_path=db)

    kept = Repo.create_window("instance", "inc", "", 100.0, 200.0, sla_excluded=False, db_path=db)["id"]
    flags = {w["id"]: w["sla_excluded"] for w in Repo.list_windows(db_path=db)}
    assert flags[kept] is False and flags[running] is True
    print("ok")


if __name__ == "__main__":
    main()
