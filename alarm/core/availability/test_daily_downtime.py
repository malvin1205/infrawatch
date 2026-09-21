"""Self-check for the Downtime Calendar's daily rollup.

Run: python -m alarm.core.availability.test_daily_downtime

Guards: WIB (UTC+7) day bucketing (no off-by-one across midnight), the
exact-outage_json vs. scalar-fallback-bucket split (never a silently empty
events list when downtime_seconds says otherwise), and the per-day event cap.
"""
import math

from alarm.core.availability.helpers import _build_daily_downtime, _DAILY_MAX_EVENTS, WIB_OFFSET_SEC

HOUR = 3600.0
DAY = 86400.0
# 2024-03-10 00:00:00 WIB (= 2024-03-09 17:00:00 UTC) — an arbitrary fixed
# anchor, not "now", so the checks don't depend on which day it happens to be
# run. Rows built at hour_offset 0..23 from here span exactly one WIB day.
DAY0 = 1710028800.0 - WIB_OFFSET_SEC


def _row(instance, hour_offset, uptime=3600.0, downtime=0.0, outage_json=None, job="blackbox"):
    start = DAY0 + hour_offset * HOUR
    return {
        "instance": instance, "job": job,
        "bucket_start": start, "bucket_end": start + HOUR,
        "uptime_seconds": uptime, "downtime_seconds": downtime,
        "coverage_seconds": uptime + downtime,
        "outage_json": outage_json,
    }


def test_healthy_day_has_no_events():
    rows = [_row("h1", h) for h in range(24)]
    daily = _build_daily_downtime(rows, DAY0, DAY0 + DAY)
    assert len(daily) == 1
    d = daily[0]
    assert d["availability_pct"] == 100.0
    assert d["hosts_down"] == 0
    assert d["events"] == []


def test_exact_outage_interval_is_reported():
    outage_start = DAY0 + 2 * HOUR + 300
    outage = {"i": [[outage_start, outage_start + 120]]}
    rows = [_row("h1", 2, uptime=3480.0, downtime=120.0, outage_json=outage)]
    daily = _build_daily_downtime(rows, DAY0, DAY0 + DAY)
    assert len(daily) == 1
    ev = daily[0]["events"]
    assert len(ev) == 1
    assert ev[0]["instance"] == "h1"
    assert ev[0]["start_ts"] == int(outage_start)
    assert ev[0]["duration_sec"] == 120.0
    assert daily[0]["hosts_down"] == 1
    assert "events_unavailable" not in daily[0]


def test_scalar_fallback_bucket_never_reads_as_zero_downtime():
    # downtime_seconds > 0 but no outage_json — the aggregate_hourly_buckets
    # scalar-fallback path (no raw 0/1 samples that hour).
    rows = [_row("h1", 5, uptime=3000.0, downtime=600.0, outage_json=None)]
    daily = _build_daily_downtime(rows, DAY0, DAY0 + DAY)
    d = daily[0]
    assert d["hosts_down"] == 1, "downtime is known even without exact interval"
    assert d["events"] is None
    assert d["events_unavailable"] is True


def test_mixed_exact_and_fallback_is_marked_partial():
    outage = {"i": [[DAY0 + HOUR + 60, DAY0 + HOUR + 90]]}
    rows = [
        _row("h1", 1, uptime=3570.0, downtime=30.0, outage_json=outage),
        _row("h2", 3, uptime=3000.0, downtime=600.0, outage_json=None),
    ]
    daily = _build_daily_downtime(rows, DAY0, DAY0 + DAY)
    d = daily[0]
    assert d["hosts_down"] == 2
    assert d["events"] is not None and len(d["events"]) == 1
    assert d["events_unavailable"] == "partial"


def test_buckets_split_across_midnight_land_in_separate_days():
    rows = [_row("h1", 23), _row("h1", 24)]  # 23:00-24:00 and 00:00-01:00 next day
    daily = _build_daily_downtime(rows, DAY0, DAY0 + 2 * DAY)
    assert len(daily) == 2
    assert daily[0]["date"] != daily[1]["date"]


def test_events_capped_with_truncated_count():
    outage = {"i": [[DAY0 + 500, DAY0 + 560]]}
    n = _DAILY_MAX_EVENTS + 7
    rows = [_row(f"h{i}", 0, uptime=3540.0, downtime=60.0, outage_json=outage) for i in range(n)]
    daily = _build_daily_downtime(rows, DAY0, DAY0 + DAY)
    d = daily[0]
    assert len(d["events"]) == _DAILY_MAX_EVENTS
    assert d["truncated_count"] == n - _DAILY_MAX_EVENTS
    assert d["hosts_down"] == n


def test_empty_input():
    assert _build_daily_downtime([], DAY0, DAY0 + DAY) == []
    assert _build_daily_downtime(None, DAY0, DAY0 + DAY) == []


def test_multihour_contiguous_downtime_is_merged_into_single_event():
    # An outage spanning across 3 consecutive hours for the same host
    # must produce exactly 1 event with merged start and end timestamps.
    h1_hr1 = {"i": [[DAY0 + 1 * HOUR + 60, DAY0 + 2 * HOUR]]}
    h1_hr2 = {"i": [[DAY0 + 2 * HOUR, DAY0 + 3 * HOUR]]}
    h1_hr3 = {"i": [[DAY0 + 3 * HOUR, DAY0 + 3 * HOUR + 1800]]}
    rows = [
        _row("h1", 1, uptime=60.0, downtime=3540.0, outage_json=h1_hr1),
        _row("h1", 2, uptime=0.0, downtime=3600.0, outage_json=h1_hr2),
        _row("h1", 3, uptime=1800.0, downtime=1800.0, outage_json=h1_hr3),
    ]
    daily = _build_daily_downtime(rows, DAY0, DAY0 + DAY)
    assert len(daily) == 1
    events = daily[0]["events"]
    assert len(events) == 1, "Must merge rows for the same host into 1 event"
    ev = events[0]
    assert ev["instance"] == "h1"
    assert ev["start_ts"] == int(DAY0 + 1 * HOUR + 60)
    assert ev["end_ts"] == int(DAY0 + 3 * HOUR + 1800)
    assert ev["duration_sec"] == 3540.0 + 3600.0 + 1800.0
    assert ev["incident_count"] == 1
    assert len(ev["intervals"]) == 1


def test_one_probe_recovery_stays_a_separate_incident():
    """A host back up for a single 60s probe, then down again, is two incidents.

    The merge used to allow a 60s gap, which on a 60s-scrape job reported this
    as one continuous outage spanning a minute the host was demonstrably up.
    """
    oj = {"i": [
        [DAY0 + 9 * HOUR + 1560, DAY0 + 9 * HOUR + 1740],   # 09:26 – 09:29
        [DAY0 + 9 * HOUR + 1800, DAY0 + 9 * HOUR + 1860],   # 09:30 – 09:31 (60s gap)
    ]}
    rows = [_row("h1", 9, uptime=3360.0, downtime=240.0, outage_json=oj)]
    ev = _build_daily_downtime(rows, DAY0, DAY0 + DAY)[0]["events"][0]
    assert ev["incident_count"] == 2, "a 60s recovery must not be merged away"
    assert len(ev["intervals"]) == 2
    assert ev["duration_sec"] == 240.0


def test_outage_split_across_the_hour_boundary_still_merges():
    """The case the merge exists for: ends that touch exactly."""
    rows = [
        _row("h1", 9, uptime=3540.0, downtime=60.0,
             outage_json={"i": [[DAY0 + 10 * HOUR - 60, DAY0 + 10 * HOUR]]}),
        _row("h1", 10, uptime=3540.0, downtime=60.0,
             outage_json={"i": [[DAY0 + 10 * HOUR, DAY0 + 10 * HOUR + 60]]}),
    ]
    ev = _build_daily_downtime(rows, DAY0, DAY0 + DAY)[0]["events"][0]
    assert ev["incident_count"] == 1
    assert len(ev["intervals"]) == 1
    assert ev["intervals"][0]["start_ts"] == int(DAY0 + 10 * HOUR - 60)
    assert ev["intervals"][0]["end_ts"] == int(DAY0 + 10 * HOUR + 60)


def test_ongoing_flags_survive_onto_the_merged_interval():
    """carried_in / still_down are what tell a consumer an interval edge is not
    a state change. A host down all day is neither a drop nor a recovery."""
    rows = [
        _row("h1", h, uptime=0.0, downtime=3600.0, outage_json={
            "i": [[DAY0 + h * HOUR, DAY0 + (h + 1) * HOUR]],
            "ongoing_start": h > 0, "ongoing_end": True,
        })
        for h in range(24)
    ]
    ev = _build_daily_downtime(rows, DAY0, DAY0 + DAY)[0]["events"][0]
    assert ev["incident_count"] == 1
    iv = ev["intervals"][0]
    # hour 0 opened already down only if the previous day was down; here the
    # first bucket says otherwise, so this is a real drop at 00:00.
    assert iv["carried_in"] is False
    assert iv["still_down"] is True, "last bucket was still down at its end"


def test_closed_outage_is_not_marked_still_down():
    rows = [_row("h1", 5, uptime=3000.0, downtime=600.0, outage_json={
        "i": [[DAY0 + 5 * HOUR, DAY0 + 5 * HOUR + 600]],
        "ongoing_start": False, "ongoing_end": False,
    })]
    iv = _build_daily_downtime(rows, DAY0, DAY0 + DAY)[0]["events"][0]["intervals"][0]
    assert iv["carried_in"] is False and iv["still_down"] is False


def demo():
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            fn()
            print(f"ok  {name}")
    print("all checks passed")


if __name__ == "__main__":
    demo()
