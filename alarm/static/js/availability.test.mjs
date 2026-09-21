/* Self-check for the Downtime Calendar's hourly rail binning.
 * Run: node alarm/static/js/availability.test.mjs
 *
 * Only _calendarEventHours is covered — it is the one piece of arithmetic
 * here (exclusive end_ts vs. inclusive recovery hour, day-boundary clamping)
 * that a wrong sign silently mis-bins instead of crashing. */
import assert from 'node:assert/strict';
import { installAvailability } from './availability.js';

class P {}
installAvailability(P);
const p = new P();

const DAY = Date.parse('2026-09-14T00:00:00Z') / 1000;
const at = (h, m = 0) => DAY + h * 3600 + m * 60;

// 14:15 – 15:45: runs in hours 14 and 15, drops in 14, recovers in 15.
let r = p._calendarEventHours({ intervals: [{ start_ts: at(14, 15), end_ts: at(15, 45) }] }, DAY);
assert.deepEqual(r.hours, [14, 15]);
assert.deepEqual(r.drops, [14]);
assert.deepEqual(r.recoveries, [15]);

// end_ts exactly on the hour: hour 15 was NOT down, but the recovery was at 15:00.
r = p._calendarEventHours({ intervals: [{ start_ts: at(14), end_ts: at(15) }] }, DAY);
assert.deepEqual(r.hours, [14]);
assert.deepEqual(r.recoveries, [15]);

/* Full-day outage. Intervals are clipped to the UTC day, so a host that has
   been down for a week shows up every day as exactly 00:00:00–24:00:00. That
   is a host still down, not a host that dropped at midnight and recovered at
   midnight — counting it as either inflates the HUD every single day
   (192.168.9.101 did exactly this, for a week). */
r = p._calendarEventHours({ intervals: [{ start_ts: DAY, end_ts: DAY + 86400 }] }, DAY);
assert.equal(r.hours.length, 24);
assert.deepEqual(r.drops, []);
assert.deepEqual(r.recoveries, []);

// A drop at 00:00:30 is genuinely new — only the exact boundary is carry-in.
r = p._calendarEventHours({ intervals: [{ start_ts: DAY + 30, end_ts: at(1) }] }, DAY);
assert.deepEqual(r.drops, [0]);
assert.deepEqual(r.recoveries, [1]);

// Carried over from the previous day: clamped to hour 0, not counted as a new drop.
r = p._calendarEventHours({ intervals: [{ start_ts: DAY - 7200, end_ts: at(2) }] }, DAY);
assert.deepEqual(r.hours, [0, 1]);
assert.deepEqual(r.drops, []);
assert.deepEqual(r.recoveries, [2]);

// Flapping: two separate incidents in the same day, deduped hours.
r = p._calendarEventHours({
  intervals: [{ start_ts: at(3), end_ts: at(4) }, { start_ts: at(3, 30), end_ts: at(9) }],
}, DAY);
assert.deepEqual(r.hours, [3, 4, 5, 6, 7, 8]);
assert.deepEqual(r.drops, [3]);
assert.deepEqual(r.recoveries, [4, 9]);

// Scalar fallback (no intervals array) and the no-timing case.
r = p._calendarEventHours({ start_ts: at(6), end_ts: at(7, 30) }, DAY);
assert.deepEqual(r.hours, [6, 7]);
assert.deepEqual(p._calendarEventHours({}, DAY).hours, []);

/* ── Window edges. Intervals are clipped to the queried window too, so on the
   newest day an outage that is still open just stops at the window end. That
   is the data running out, not a recovery. */
const WIN_START = at(4, 33), WIN_END = at(4, 33) + 86400;

// Still down when the data ends (window end lands on the NEXT day, so use it).
r = p._calendarEventHours(
  { intervals: [{ start_ts: DAY + 86400, end_ts: WIN_END }] }, DAY + 86400, WIN_START, WIN_END);
assert.deepEqual(r.recoveries, [], 'window end is not a recovery');
assert.deepEqual(r.drops, [], 'day start is not a drop');

// Already down when the window opened: no drop at the window edge either.
r = p._calendarEventHours(
  { intervals: [{ start_ts: WIN_START, end_ts: at(6) }] }, DAY, WIN_START, WIN_END);
assert.deepEqual(r.drops, [], 'window start is not a drop');
assert.deepEqual(r.recoveries, [6]);

// A real recovery before the window end still counts.
r = p._calendarEventHours(
  { intervals: [{ start_ts: at(2) + 86400, end_ts: at(3) + 86400 }] }, DAY + 86400, WIN_START, WIN_END);
assert.deepEqual(r.drops, [2]);
assert.deepEqual(r.recoveries, [3]);

/* ── carried_in / still_down win over any timestamp guess. The real case the
   timestamps could not catch: the newest day's last bucket ends at the last
   scrape (seconds before the window end), so "still down" looked exactly
   like "recovered". */
r = p._calendarEventHours(
  { intervals: [{ start_ts: DAY, end_ts: WIN_END - 29, carried_in: true, still_down: true }] },
  DAY, WIN_START, WIN_END);
assert.deepEqual(r.drops, [], 'carried_in host did not drop');
assert.deepEqual(r.recoveries, [], 'still_down host did not recover');

// Flags also override in the other direction: a genuine drop at 00:00:00 and a
// genuine recovery at the last scrape are both real when the flags say so.
r = p._calendarEventHours(
  { intervals: [{ start_ts: DAY, end_ts: at(5), carried_in: false, still_down: false }] },
  DAY, WIN_START, WIN_END);
assert.deepEqual(r.drops, [0]);
assert.deepEqual(r.recoveries, [5]);

/* ── Range coverage: a 24h range straddles two calendar days, so each day is
   only partly queried. Hours outside the window must come back false or the
   rail draws "nothing was down" over time nobody asked about. */
// Window 2026-09-14T04:33Z → 2026-09-15T04:33Z (what range=24h actually sends).
p.availabilityBreakdown = { trend_start_ts: at(4, 33), trend_end_ts: at(4, 33) + 86400 };

let cov = p._calendarRangeHours(DAY); // the older day: 04:33 onward is covered
assert.equal(cov.length, 24);
assert.deepEqual(cov.slice(0, 5), [false, false, false, false, true]); // hour 4 overlaps
assert.equal(cov.filter(Boolean).length, 20);

cov = p._calendarRangeHours(DAY + 86400); // the newer day: up to 04:33
assert.deepEqual(cov.slice(0, 6), [true, true, true, true, true, false]);
assert.equal(cov.filter(Boolean).length, 5);

// No window on the payload: assume the whole day rather than hiding the rail.
p.availabilityBreakdown = {};
assert.equal(p._calendarRangeHours(DAY).filter(Boolean).length, 24);

console.log('availability calendar hour binning + range coverage: ok');
