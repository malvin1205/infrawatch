"""Self-check for reconstruct_time_series_intervals — the exact engine every
hourly availability bucket is built from.

Run: python -m alarm.core.availability.test_reconstruct

Guards the hour-boundary accounting the aggregator depends on: it tiles this
function across consecutive hours, so a sample landing exactly on a boundary
must be claimed by exactly one of them.
"""
from alarm.core.availability.fleet import reconstruct_time_series_intervals

HOUR = 3600.0
STEP = 15.0


def _series(start, end, down_from=None, down_to=None, step=STEP):
    """Grid of samples over [start, end), 0 inside [down_from, down_to)."""
    out, t = [], start
    while t < end:
        down = down_from is not None and down_from <= t < down_to
        out.append((t, 0 if down else 1))
        t += step
    return out


def _invariants(rec, window_sec):
    assert abs(rec["uptime_seconds"] + rec["downtime_seconds"] - rec["coverage_seconds"]) < 0.05
    assert rec["coverage_seconds"] <= window_sec + 0.05
    assert abs(rec["unknown_seconds"] - (window_sec - rec["coverage_seconds"])) < 0.05
    if rec["coverage_seconds"] == 0:
        assert rec["availability_pct"] is None
    else:
        assert 0.0 <= rec["availability_pct"] <= 100.0


def test_outage_starting_exactly_on_the_hour_belongs_to_one_hour():
    """The bug: with an inclusive window end, the 10:00:00 DOWN sample was in
    both hours — the 09:00 bucket recorded a falling edge (incident_count=1,
    downtime 0s, is_ongoing_outage=True) for an hour it was up throughout, and
    the 10:00 bucket counted the same outage again."""
    h9, h10 = 9 * HOUR, 10 * HOUR
    samples = _series(h9, h10 + HOUR, down_from=h10, down_to=h10 + 1800)

    prev = reconstruct_time_series_intervals(samples, h9, h10, expected_interval_sec=STEP)
    assert prev["incident_count"] == 0, "an hour that was up throughout has no incident"
    assert prev["downtime_seconds"] == 0.0
    assert prev["is_ongoing_outage"] is False
    assert prev["availability_pct"] == 100.0
    _invariants(prev, HOUR)

    cur = reconstruct_time_series_intervals(samples, h10, h10 + HOUR, expected_interval_sec=STEP)
    assert cur["incident_count"] == 1
    assert abs(cur["downtime_seconds"] - 1800.0) < STEP
    _invariants(cur, HOUR)


def test_outage_across_the_hour_boundary_is_open_at_both_seams():
    """A real cross-boundary outage still reports ongoing on each side, which
    is what lets the calendar re-merge the two hourly rows into one event."""
    h9, h10 = 9 * HOUR, 10 * HOUR
    samples = _series(h9, h10 + HOUR, down_from=h9 + 1800, down_to=h10 + 1800)

    prev = reconstruct_time_series_intervals(samples, h9, h10, expected_interval_sec=STEP)
    assert prev["is_ongoing_outage"] is True
    assert prev["incident_count"] == 1
    assert abs(prev["downtime_seconds"] - 1800.0) < STEP

    cur = reconstruct_time_series_intervals(samples, h10, h10 + HOUR, expected_interval_sec=STEP)
    assert cur["incident_count"] == 1, "the carried-in outage opens this hour"
    assert abs(cur["downtime_seconds"] - 1800.0) < STEP
    assert cur["is_ongoing_outage"] is False


def test_hours_tile_without_double_counting_downtime():
    """Summing consecutive hourly windows must reproduce the whole span."""
    h0 = 0.0
    samples = _series(h0, 4 * HOUR, down_from=1.5 * HOUR, down_to=2.5 * HOUR)
    total_down = total_cov = 0.0
    incidents = 0
    for h in range(4):
        rec = reconstruct_time_series_intervals(
            samples, h0 + h * HOUR, h0 + (h + 1) * HOUR, expected_interval_sec=STEP)
        total_down += rec["downtime_seconds"]
        total_cov += rec["coverage_seconds"]
        incidents += rec["incident_count"]
        _invariants(rec, HOUR)
    assert abs(total_down - HOUR) < STEP, total_down
    assert abs(total_cov - 4 * HOUR) < 2 * STEP
    # One drop, seen as "still down" by the hour it straddles: 2 raw counts
    # that the cross-bucket de-dup in merge_hybrid_target_availability folds
    # back to 1 via the ongoing_end/ongoing_start pair.
    assert incidents == 2


def test_no_samples_is_all_unknown():
    rec = reconstruct_time_series_intervals([], 0.0, HOUR)
    assert rec["availability_pct"] is None
    assert rec["unknown_seconds"] == HOUR
    assert rec["incident_count"] == 0


def test_gap_beyond_tolerance_becomes_unknown_not_downtime():
    """A scrape hole in an otherwise dense series is UNKNOWN, never uptime and
    never downtime — unmonitored time must stay out of the SLA denominator."""
    samples = _series(0.0, 600.0) + _series(3000.0, HOUR)
    rec = reconstruct_time_series_intervals(samples, 0.0, HOUR, expected_interval_sec=STEP)
    assert rec["downtime_seconds"] == 0.0
    assert 2000.0 < rec["unknown_seconds"] < 2500.0, rec["unknown_seconds"]
    assert rec["availability_pct"] == 100.0
    _invariants(rec, HOUR)


if __name__ == "__main__":
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            fn()
            print("ok ", name)
    print("all checks passed")


def test_unobserved_lead_in_is_not_outage_time():
    """A window whose first sample arrives long after window start (Prometheus
    had no data before it) must not book the empty lead-in as a multi-hour
    outage when that first sample is DOWN."""
    day = 24 * HOUR
    first = day - 600  # only the last 10 minutes were probed, all DOWN
    samples = _series(first, day, down_from=first, down_to=day)
    rec = reconstruct_time_series_intervals(samples, 0.0, day, expected_interval_sec=STEP)
    assert rec["incident_count"] == 1
    assert rec["max_outage_minutes"] is not None and rec["max_outage_minutes"] <= 11
    start, end = rec["outage_intervals_sec"][0]
    assert start >= first - STEP and end == day
    _invariants(rec, day)
