/* Self-check for the Availability Trend geometry and Downtime Calendar
 * (audit round 2). Run: node alarm/static/js/availability.test.mjs
 * Also run under another timezone: TZ=America/New_York node ...
 *
 * Replaces the old _calendarEventHours check (that helper no longer exists,
 * so the file crashed before running anything). Minimal DOM stubs — the
 * interactive behaviour is checked in a real browser separately. */
import assert from 'node:assert/strict';

const modPath = process.env.AVAIL_JS || './availability.js';
const { installAvailability } = await import(modPath);

class P {}
installAvailability(P);
P.prototype._esc = s => String(s).replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);
P.prototype._getHostRoleLabel ??= () => 'blackbox';
P.prototype._formatDowntimeDuration ??= s => `${Math.round(s)}s downtime`;

const H = 3600;
const WIB = 7 * H;
const DAY0 = Date.UTC(2026, 8, 14) / 1000 - WIB;           // 2026-09-14 00:00 WIB
const at = h => DAY0 + h * H;

const mkEl = (extra = {}) => {
  const el = {
    dataset: {}, style: {}, innerHTML: '', textContent: '', _cls: new Set(),
    appendChild() {}, remove() {}, addEventListener() {}, setAttribute() {},
    querySelector: () => null, querySelectorAll: () => [], closest: () => null,
    ...extra,
  };
  el.classList = {
    add: c => el._cls.add(c), remove: c => el._cls.delete(c),
    toggle: (c, on) => (on ? el._cls.add(c) : el._cls.delete(c)), contains: c => el._cls.has(c),
  };
  return el;
};
let els = {};
globalThis.document = {
  getElementById: id => els[id] || null,
  createElement: () => mkEl(),
  querySelector: () => null,
  querySelectorAll: () => [],
};
const failures = [];
const check = (name, fn) => {
  try { fn(); } catch (e) { failures.push(`${name}: ${e.message.split('\n')[0]}`); }
};

// Hourly points 01:00, 02:00, then nothing until 06:00; 08:00 is partial.
const pts = [
  { ts: at(1), availability_pct: 100 }, { ts: at(2), availability_pct: 90 },
  { ts: at(6), availability_pct: 42.5 },
];
const partial = [{ ts: at(8), availability_pct: null, hosts_reporting: 1, hosts_expected: 5 }];
const stFor = p => ({
  pts, partialPts: partial, bucketSec: H, windowSec: 12 * H, startTs: DAY0, endTs: at(12), sweep: null,
  partials: p._trendGeometry(pts, partial, DAY0, at(12), H).partials,
});

check('geometry: gaps exactly where no slot is, line never extended', () => {
  const p = new P();
  const g = p._trendGeometry(pts, partial, DAY0, at(12), H);
  assert.deepEqual(g.gaps, [[DAY0, at(0)], [at(2), at(5)], [at(6), at(7)], [at(8), at(12)]].filter(([a, b]) => b > a));
  assert.equal(g.segments.length, 2);
  assert.equal(g.segments[1][g.segments[1].length - 1].hi, at(6), 'last segment ends at its slot, not held to the edge (M2)');
});

check('M4: pin/click inside a gap reports no value', () => {
  const p = new P();
  const st = stFor(p);
  assert.equal(p._trendSlotAt(at(4), st), null);
  const tip = p._trendTipText(at(4), st, pts[2]);
  assert.ok(!/avg/.test(tip), `gap tooltip must not print a slot average: ${tip}`);
  assert.match(tip, /Telemetry Gap/);
  assert.equal(p._trendValueAt(at(4), st, pts[2]), null, 'no borrowed / default value in a gap');
  // The pin itself: no dot drawn inside the gap.
  const dot = mkEl(), tipEl = mkEl(), cross = mkEl();
  const pin = mkEl({ querySelector: sel => ({ '.avb-trend-dot': dot, '.avb-trend-tip': tipEl, '.avb-trend-cross': cross })[sel] });
  els = { avbTrendPin: pin };
  p._trendHoverState = { ...st, coords: [[0, 0]], segments: [], yMin: 0, yMax: 100, ySpan: 100 };
  p._highlightTrendAt(at(4), pts[2]);
  assert.equal(dot.style.display, 'none', 'pin dot hidden over a gap');
  assert.ok(!/avg/.test(tipEl.textContent));
  els = {};
});

check('L2: trailing band and hover agree', () => {
  const p = new P();
  const st = stFor(p);
  assert.equal(p._trendHoverInfo(at(9.2), st).kind, 'gap', '1.2h into the trailing band is a gap, not the last value');
});

check('S6: the first slot is a value over its whole width', () => {
  const p = new P();
  const st = stFor(p);
  assert.equal(p._trendHoverInfo(at(0) + 300, st).kind, 'value', 'first 20% of the first slot is drawn, so it is a value');
});

check('partial slot hovers as partial, never as a value', () => {
  const p = new P();
  const st = stFor(p);
  const info = p._trendHoverInfo(at(7.5), st);
  assert.equal(info.kind, 'partial');
  assert.match(p._trendTipText(at(7.5), st), /Partial Telemetry: 1\/5/);
});

check('in-progress point: slot is (aligned start, ts], not (ts - bucket, ts]', () => {
  const p = new P();
  assert.equal(p._trendSlotStart(at(10.5), H), at(10));
  assert.equal(p._trendSlotStart(at(10), H), at(9));
  assert.equal(p._trendSlotStart(at(8), 4 * H), at(4), 'multi-hour slots align to WIB midnight');
});

check('M5: today on a live range follows the live edge', () => {
  const p = new P();
  p.periodEnd = null;
  p.availabilityBreakdown = { trend_start_ts: at(-23), trend_end_ts: at(14) };
  assert.deepEqual(p._calendarDayWindow(DAY0), { lo: DAY0, hi: null });
  p.periodEnd = at(14);
  assert.deepEqual(p._calendarDayWindow(DAY0), { lo: DAY0, hi: at(14) }, 'a fixed custom range stays fixed');
  p.periodEnd = null;
  p.availabilityBreakdown = { trend_start_ts: at(-23), trend_end_ts: at(30) };
  assert.deepEqual(p._calendarDayWindow(DAY0), { lo: DAY0, hi: at(24) }, 'a finished day is a fixed window');
});

check('M6: custom range is WIB regardless of the browser timezone', () => {
  const p = new P();
  const d = p._parseWibLocal('2026-09-01T00:00');
  assert.equal(d.getTime(), Date.UTC(2026, 8, 1) - WIB * 1000);
  assert.equal(p._toDatetimeLocalValue(d), '2026-09-01T00:00');
  assert.ok(isNaN(p._parseWibLocal('garbage').getTime()));
});

check('L3: rendering before the first report does not throw', () => {
  const p = new P();
  p.availabilityBreakdown = undefined;
  p.periodMinutes = 1440;
  p._availLoading = true;
  p._updateAvailLoadingUI = () => {};
  const list = mkEl();
  els = { availModalSubtitle: mkEl(), hostsRequiringAttentionList: list };
  p._renderAvailabilityBreakdown('sortMenu:click');
  assert.match(list.innerHTML, /Loading host availability/);
  els = {};
});

check('S7: MTD cache key is stable while the month grows', () => {
  const p = new P();
  p.periodLabel = 'mtd';
  p.periodEnd = null;
  assert.equal(p._getAvailCacheKey(40000, 'all', null), p._getAvailCacheKey(40001, 'all', null));
  p.periodMinutes = 40010;
  assert.equal(p._dataMatchesSelection({ period_minutes: 40001, job: 'all' }), true);
  assert.equal(p._dataMatchesSelection({ period_minutes: 1440, job: 'all' }), false);
});

check('S8: a zoom detail older than 5 minutes is refetched', () => {
  const p = new P();
  const now = 1_000_000_000;
  const d = { scope: 's', lo: 10, hi: 20, at: now - 60_000 };
  assert.equal(p._trendDetailFresh(d, 's', 10, 20, now), true);
  assert.equal(p._trendDetailFresh({ ...d, at: now - 301_000 }, 's', 10, 20, now), false);
});

check('H4: a mostly-unobserved day is hatched and labelled, not a clean green cell', () => {
  const p = new P();
  const grid = mkEl();
  els = { avbCalendarGrid: grid };
  p._renderDowntimeCalendar({
    trend_start_ts: DAY0, trend_end_ts: DAY0 + 86400,
    daily: [{ date: '2026-09-14', availability_pct: 100, hosts_down: 0, events: [], coverage_pct: 8.33, limited_data: true }],
  });
  assert.match(grid.innerHTML, /is-limited/);
  assert.match(grid.innerHTML, /8% observed/);
  assert.match(grid.innerHTML, /~100\.0%/);
  els = {};
});

check('caption counts the days in the range, not the days with data', () => {
  const p = new P();
  const cap = mkEl();
  els = { avbCalendarGrid: mkEl(), avbCalendarCaption: cap };
  p._renderDowntimeCalendar({
    trend_start_ts: DAY0 + 9 * H, trend_end_ts: DAY0 + 33 * H,
    daily: [{ date: '2026-09-15', availability_pct: 100, hosts_down: 0, events: [] }],
  });
  assert.match(cap.textContent, /^Showing 2 days/);
  els = {};
});

check('fleet sweep: a host down all day is not a drop + recovery at midnight', () => {
  const p = new P();
  const sweep = p._buildFleetSweep([
    { instance: 'h', intervals: [{ start_ts: DAY0 - 86400, end_ts: DAY0, carried_in: true, still_down: true }] },
    { instance: 'h', intervals: [{ start_ts: DAY0, end_ts: DAY0 + 86400, carried_in: true, still_down: true }] },
  ], DAY0 - 86400, DAY0 + 86400);
  assert.equal(sweep.intervals.length, 1, 'the day seam is merged');
  assert.equal(sweep.changes.length, 0, 'no fake drop/recovery at 00:00');
  assert.equal(sweep.downAt(DAY0), 1);
});

check('N3: an empty chart clears the previous legend', () => {
  const p = new P();
  const note = mkEl({ innerHTML: 'SLA target 99.9% no telemetry' });
  const plot = mkEl({ querySelector: sel => (sel === '.avb-trend-empty' ? mkEl() : null) });
  els = { avbTrendPlot: plot, avbTrendTargetNote: note };
  p._renderAvailabilityTrend({ trend: [], trend_start_ts: DAY0, trend_end_ts: DAY0 + 86400 });
  assert.equal(note.innerHTML, '');
  els = {};
});

check('N4: Today is offered only when today is inside the loaded range', () => {
  const p = new P();
  const today = mkEl();
  const plot = mkEl({ querySelector: () => mkEl() });
  els = { avbTrendPlot: plot, avbTrendTodayBtn: today };
  today.dataset.wired = '1';
  p._renderAvailabilityTrend({ trend: [{ ts: at(2), availability_pct: 100 }], trend_start_ts: DAY0, trend_end_ts: at(12) });
  assert.ok(today.classList.contains('hidden'), 'a past custom range has no "today"');
  const now = Date.now() / 1000;
  p._renderAvailabilityTrend({ trend: [{ ts: Math.floor(now / 3600) * 3600, availability_pct: 100 }], trend_start_ts: now - 86400, trend_end_ts: now });
  assert.ok(!today.classList.contains('hidden'), 'a live range offers Today');
  els = {};
});

check('N2: the modal dropdown names a custom range', () => {
  const p = new P();
  const sel = { value: '1440', options: [{ value: '1440', textContent: 'Last 24 Hours' }, { value: 'custom', textContent: 'Custom range' }], selectedIndex: 0, parentElement: null };
  Object.defineProperty(sel, 'value', {
    get() { return this.options[this.selectedIndex].value; },
    set(v) { const i = this.options.findIndex(o => o.value === v); if (i >= 0) this.selectedIndex = i; },
  });
  els = { modalRangeSelect: sel };
  globalThis.window = { trapModalFocus: () => () => {} };
  document.body = mkEl();
  p.availabilityBreakdownModal = mkEl();
  p._availCache = new Map();
  p.periodLabel = 'custom';
  p.periodMinutes = 30 * 1440;
  p.periodEnd = at(0);
  p.loadAvailability = () => {};
  p._openAvailabilityBreakdown();
  assert.equal(sel.value, 'custom');
  els = {};
});

if (failures.length) {
  console.error(`availability.test.mjs: ${failures.length} failing\n  - ${failures.join('\n  - ')}`);
  process.exit(1);
}
console.log('availability geometry + calendar: ok');
