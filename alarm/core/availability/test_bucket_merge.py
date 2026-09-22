"""Self-check for merge_hybrid_target_availability's bucket accounting —
incident de-duplication across hourly rows and the maintenance carve-out.

Run: python -m alarm.core.availability.test_bucket_merge

Both are places where one outage is represented by several rows, so an
over-eager merge silently deletes a real, separate incident and an
under-eager one reports the same outage twice.
"""
import json

from alarm.core.availability.fleet import merge_hybrid_target_availability

HOUR = 3600.0
NO_PROM = {"first_ts": None, "last_ts": None, "count": None,
           "avail": None, "incidents": None, "duration": None}


def bucket(start, downtime=0.0, incidents=0, intervals=(),
           carried_in=False, still_down=False, coverage=HOUR):
    return {
        "instance": "h1", "job": "blackbox",
        "bucket_start": start, "bucket_end": start + HOUR,
        "uptime_seconds": coverage - downtime, "downtime_seconds": downtime,
        "unknown_seconds": HOUR - coverage, "coverage_seconds": coverage,
        "sample_count": 240, "availability_pct": None,
        "incident_count": incidents, "avg_latency_ms": 10.0,
        "updated_at": start + HOUR,
        "outage_json": json.dumps({
            "d": [e - s for s, e in intervals],
            "i": [[s, e] for s, e in intervals],
            "ongoing_start": carried_in, "ongoing_end": still_down,
        }),
    }


def _merge(buckets, req_start, req_end, windows=None):
    return merge_hybrid_target_availability(
        req_start=req_start, req_end=req_end, target_id="h1", target_name="h1",
        job="blackbox", sqlite_buckets=buckets, prom_metrics=NO_PROM,
        expected_interval_sec=15.0, maintenance_windows=windows,
    )


def test_one_outage_spanning_two_hours_counts_once():
    b = [
        bucket(0 * HOUR),
        bucket(1 * HOUR, downtime=1800.0, incidents=1,
               intervals=[(1.5 * HOUR, 2 * HOUR)], still_down=True),
        bucket(2 * HOUR, downtime=1800.0, incidents=1,
               intervals=[(2 * HOUR, 2.5 * HOUR)], carried_in=True),
        bucket(3 * HOUR),
    ]
    r = _merge(b, 0.0, 4 * HOUR)
    assert r["incidents"] == 1, r["incidents"]
    assert abs(r["downtime_seconds"] - HOUR) < 1.0


def test_a_later_separate_outage_is_not_cancelled_by_the_dedup():
    """The regression this file exists for: a zero-incident bucket sitting
    after a still-down hour must not consume another outage's incident."""
    b = [
        bucket(0 * HOUR),
        bucket(1 * HOUR, downtime=1800.0, incidents=1,
               intervals=[(1.5 * HOUR, 2 * HOUR)], still_down=True),
        bucket(2 * HOUR, downtime=1800.0, incidents=1,
               intervals=[(2 * HOUR, 2.5 * HOUR)], carried_in=True),
        # up for the whole hour, but flagged as opening still-down
        bucket(3 * HOUR, carried_in=True),
        # a genuinely separate outage, hours later
        bucket(5 * HOUR, downtime=300.0, incidents=1,
               intervals=[(5.1 * HOUR, 5.1 * HOUR + 300.0)]),
    ]
    r = _merge(b, 0.0, 6 * HOUR)
    assert r["incidents"] == 2, r["incidents"]


def test_continuous_outage_on_an_unaligned_live_window_counts_once():
    """A live window (now - 24h) is never hour-aligned: its first bucket is
    clipped and its last is the in-progress hour whose bucket_end is in the
    future. Both used to sit out the cross-bucket de-dup and each kept an
    un-deduplicated +1, so a host down for weeks read as 3 incidents.
    """
    b = [
        bucket(h * HOUR, downtime=HOUR, incidents=1,
               intervals=[(h * HOUR, (h + 1) * HOUR)],
               carried_in=True, still_down=True)
        for h in range(5)
    ]
    # Starts mid-bucket-0 and ends mid-bucket-4 (still in progress).
    r = _merge(b, 0.5 * HOUR, 4.5 * HOUR)
    assert r["incidents"] == 1, r["incidents"]


def test_two_separate_outages_in_one_hour_stay_two():
    b = [bucket(0 * HOUR, downtime=600.0, incidents=2,
                intervals=[(300.0, 600.0), (1200.0, 1500.0)])]
    r = _merge(b, 0.0, HOUR)
    assert r["incidents"] == 2


def test_maintenance_excuses_only_the_overlapping_outage():
    """A window over a HEALTHY hour excuses nothing; a window over the outage
    excuses exactly its overlap, never the whole hour's downtime."""
    b = [
        bucket(0 * HOUR, downtime=600.0, incidents=1, intervals=[(0.0, 600.0)]),
        bucket(1 * HOUR, downtime=600.0, incidents=1,
               intervals=[(1 * HOUR + 600.0, 1 * HOUR + 1200.0)]),
    ]
    # Window over the second hour's first 300s — before that outage started.
    r = _merge(b, 0.0, 2 * HOUR, windows=[(1 * HOUR, 1 * HOUR + 300.0)])
    assert r["downtime_seconds"] == 1200.0
    assert r["sla_downtime_seconds"] == 1200.0, "a window over healthy time excuses nothing"

    # Window over the second half of the second hour's outage.
    r = _merge(b, 0.0, 2 * HOUR,
               windows=[(1 * HOUR + 900.0, 1 * HOUR + 1800.0)])
    assert abs(r["sla_downtime_seconds"] - (1200.0 - 300.0)) < 1.0, r["sla_downtime_seconds"]


def test_invariants_hold_on_a_partial_window():
    b = [bucket(0 * HOUR, downtime=600.0, incidents=1, intervals=[(0.0, 600.0)])]
    r = _merge(b, 0.0, 0.5 * HOUR)
    assert r["observed_seconds"] <= 0.5 * HOUR + 0.05
    assert abs(r["uptime_seconds"] + r["downtime_seconds"] - r["observed_seconds"]) < 0.05
    assert abs(r["unknown_seconds"] - (0.5 * HOUR - r["observed_seconds"])) < 0.05


if __name__ == "__main__":
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            fn()
            print("ok ", name)
    print("all checks passed")
