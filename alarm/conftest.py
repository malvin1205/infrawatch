"""Test isolation: runs before any test module imports the app.

Importing app.py starts the alert poller and the availability aggregator
against the configured Prometheus and alarm/data/infrawatch.db. Under pytest
that wrote real incidents, event logs and audit rows into the production DB —
including one with a clock a test had patched (a "resolved" event dated in the
future). Every test run gets a throwaway data dir and DB instead, and no
background threads.
"""
import glob
import os
import shutil
import tempfile

_tmp = tempfile.mkdtemp(prefix="infrawatch-test-")
# The shipped *.example files are fixtures some tests read (e.g. the target
# whitelist), never the live copies next to them.
for _f in glob.glob(os.path.join(os.path.dirname(__file__), "data", "*.example")):
    shutil.copy(_f, _tmp)
os.environ["INFRAWATCH_DATA_DIR"] = _tmp
os.environ["INFRAWATCH_DB_PATH"] = os.path.join(_tmp, "infrawatch.db")
os.environ["DISABLE_ALERT_POLLER"] = "1"
os.environ["DISABLE_AVAILABILITY_AGGREGATOR"] = "1"
