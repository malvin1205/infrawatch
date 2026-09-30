"""Self-check for DependencyRepository.create_dependencies (dashboard bulk
"Parent host"): one batch gets unique ids and replaces any existing parent.

Run: python -m alarm.storage.test_bulk_dependencies
"""
import os
import tempfile

from alarm.storage.schema import init_db
from alarm.storage.repositories.inventory import DependencyRepository as Repo


def main():
    db = os.path.join(tempfile.mkdtemp(), "t.db")
    init_db(db)
    Repo.create_dependency(parent="old-gw", child="h1", db_path=db)

    deps = Repo.create_dependencies(parent="sw1", children=["h1", "h2", "h3"], db_path=db)
    assert len({d["id"] for d in deps}) == 3, "ids must be unique within one batch"
    assert Repo.get_parent_map(db_path=db) == {"h1": "sw1", "h2": "sw1", "h3": "sw1"}
    assert len(Repo.list_dependencies(db_path=db)) == 3, "old parent link replaced, not duplicated"

    removed = Repo.delete_dependencies_for_children(["h1", "h3", "never-linked"], db_path=db)
    assert sorted(removed) == ["h1", "h3"], removed
    assert Repo.get_parent_map(db_path=db) == {"h2": "sw1"}
    print("ok")


if __name__ == "__main__":
    main()
