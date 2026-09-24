"""Shared constants for InfraWatch.

Deployment-tunable knobs and fixed identifiers used across the request
handlers, the monitoring-state engine, the availability pipeline, and the
background workers. Kept in one leaf module (no InfraWatch imports) so the
domain modules extracted from app.py can share them without importing app.

app.py re-imports every name, so `import app as alarm_app; alarm_app.DEFAULT_JOB_FILTER`
is unchanged.
"""
import logging
import os
import re

# Root application directory and runtime data directory.
# Keeping mutable state (SQLite, JSON caches, secrets) inside DATA_DIR ensures
# clean separation from Python source code.
ALARM_DIR = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.environ.get("INFRAWATCH_DATA_DIR") or os.path.join(ALARM_DIR, "data")
try:
    os.makedirs(DATA_DIR, exist_ok=True)
except Exception:
    pass

# Default Prometheus job filter for /instances, /api/availability, the poller
# and the aggregator. "all" (or "*") means "every job except prometheus".
DEFAULT_JOB_FILTER = os.environ.get("JOB_FILTER", "all")

# Synthetic alert names the built-in poller raises (mirrors what Alertmanager
# would send). TargetDown = critical/down; SlowResponse = warning/degraded.
ALERTNAME_TARGET_DOWN = "TargetDown"
ALERTNAME_SLOW_RESPONSE = "SlowResponse"

# Global default latency (ms) above which an up target is "slow"/degraded.
# Per-instance overrides live in SlowThresholdRepository. Used by BOTH the
# SlowResponse alert (poller) and the live grid's severity/summary (audit F4).
DEFAULT_SLOW_RESPONSE_THRESHOLD_MS = float(os.environ.get("SLOW_RESPONSE_THRESHOLD_MS", "500"))

# Matches prometheus/prometheus.yml `global.scrape_interval`. Used to turn a
# Prometheus `count_over_time(...)` sample count back into a monitored-duration
# estimate for weighted (fleet_aggregate) availability math. Override via
# SCRAPE_INTERVAL_SECONDS if prometheus.yml's scrape_interval is ever changed.
try:
    SCRAPE_INTERVAL_SECONDS = float(os.environ.get("SCRAPE_INTERVAL_SECONDS", "2.0"))
except (TypeError, ValueError):
    SCRAPE_INTERVAL_SECONDS = 2.0

# How stale the latest SQLite availability bucket may be, for a *live* window
# (no ?end=), before /api/availability's "is this range fully materialized?"
# check gives up on the fast path and falls back to a live Prometheus query.
# The background aggregator (AVAIL_AGGREGATE_INTERVAL_SECONDS) only refreshes
# the in-progress hour's bucket once every 60s, and that cycle itself takes
# real time (Prometheus queries, up to 15s timeout). The frontend polls this
# endpoint every 15s regardless of user action — with zero slack between the
# two 60s numbers, a live range would drift past a bare 60s tolerance partway
# through most aggregation cycles, flip-flopping between the SQLite-materialized
# path and the live-hybrid path (two different estimation methods) on its own,
# with the UI number visibly changing every ~15s with no user action. 2.5x
# mirrors the same slack multiplier already used for the aggregator's
# leader-election lease.
_AVAIL_FRESHNESS_TOLERANCE_SEC = 150.0  # 60.0 * 2.5

# Separately: how old the NEWEST matched bucket's `updated_at` may be before the
# SQLite fast path is abandoned for a live window. The freshness tolerance above
# is about the bucket's nominal time span (which always reads as current, since
# an in-progress hour is stored with a future hour-end); this one catches a
# silently dead aggregator — buckets whose span still looks current but that
# stopped being rewritten. ~5 aggregator cycles (AVAIL_AGGREGATE_INTERVAL_SECONDS
# = 60s); older => fall through to the live Prometheus hybrid path instead of
# serving an ever-staler archive as "COMPLETE".
_AVAIL_STALE_BUCKET_TOLERANCE_SEC = 300.0

# Availability Trend: minimum share of expected hosts (monitored, not fully in
# maintenance) that must have data in a slot before that slot gets a pooled
# availability_pct. Below it the point is returned with availability_pct=None
# ("partial data") — otherwise whichever small subset happened to report
# (e.g. 17 of 96 hosts) is drawn as if it were the whole fleet.
try:
    AVAIL_TREND_MIN_REPORTING_RATIO = min(1.0, max(0.0, float(os.environ.get("AVAIL_TREND_MIN_REPORTING_RATIO", "0.5"))))
except (TypeError, ValueError):
    AVAIL_TREND_MIN_REPORTING_RATIO = 0.5

# Official target whitelist: the ONLY instances allowed into availability data
# (bucket writes, SLA, Trend, Calendar), on every Prometheus server. File is
# one instance per line or comma-separated, '#' comments. Fails CLOSED: a
# missing, unreadable or empty file admits no target (loud ERROR), never all
# of them. Opt out explicitly with AVAIL_TARGET_WHITELIST_FILE=none.
_wl_file_env = os.environ.get("AVAIL_TARGET_WHITELIST_FILE", "").strip()
AVAIL_TARGET_WHITELIST_FILE = (
    _wl_file_env if _wl_file_env else os.path.join(DATA_DIR, "target_whitelist.txt")
)

# host / IPv4 / [IPv6] with optional :port, or an http(s) URL target.
_WHITELIST_ENTRY = re.compile(r"^(?:https?://)?(?:[A-Za-z0-9._-]+|\[[0-9A-Fa-f:.]+\])(?::\d{1,5})?(?:/[^\s,;]*)?$")


def load_target_whitelist(path=None):
    """frozenset of whitelisted instances (possibly empty = nothing counts),
    or None only when explicitly disabled."""
    log = logging.getLogger("infrawatch.availability")
    if path is not None:
        target_path = str(path).strip()
    else:
        env_val = os.environ.get("AVAIL_TARGET_WHITELIST_FILE")
        target_path = env_val.strip() if env_val is not None else AVAIL_TARGET_WHITELIST_FILE

    if not target_path:
        target_path = os.path.join(DATA_DIR, "target_whitelist.txt")

    if target_path.strip().lower() in ("none", "off", "disabled"):
        log.warning("target whitelist DISABLED by AVAIL_TARGET_WHITELIST_FILE=%s - every scraped target counts toward SLA", target_path)
        return None
    if not os.path.exists(target_path):
        example_path = target_path + ".example"
        if os.path.exists(example_path):
            try:
                import shutil
                shutil.copyfile(example_path, target_path)
                log.info("Initialized %s from %s", target_path, example_path)
            except Exception as e:
                log.warning("Could not copy %s to %s: %s", example_path, target_path, e)
    try:
        with open(target_path, encoding="utf-8") as fh:
            text = "\n".join(line.split("#", 1)[0] for line in fh)
    except OSError as e:
        log.error("target whitelist %s unreadable (%s) - failing CLOSED: no target counts toward availability", target_path, e)
        return frozenset()
    entries = [x.strip() for x in text.replace(",", "\n").splitlines() if x.strip()]
    bad = [x for x in entries if not _WHITELIST_ENTRY.match(x)]
    if bad:
        log.error("target whitelist %s: ignoring %d malformed entr%s: %s", target_path, len(bad), "y" if len(bad) == 1 else "ies", bad)
    good = frozenset(x for x in entries if _WHITELIST_ENTRY.match(x))
    if not good:
        log.error("target whitelist %s has no valid entries - failing CLOSED: no target counts toward availability", target_path)
    return good


# Whitelist filtering is DISABLED for stability (2026-09-24): it dropped
# rows at write time ("refusing to store N non-whitelisted") and hid history
# at read time. None = every scraped target is stored/read normally, the
# pre-whitelist behavior. Re-enable with load_target_whitelist() only after
# the availability data path is proven stable with it.
AVAIL_TARGET_WHITELIST = None
