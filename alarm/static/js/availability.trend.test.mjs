/* Self-check for Availability Trend interaction + Calendar ranking fixes.
 * Run: node alarm/static/js/availability.trend.test.mjs
 *
 * Covers: click-vs-drag threshold (no pointer capture on a plain click),
 * state reset on an empty render, MTD recomputed on every poll (incl. month
 * rollover), worst-days tie-break. Minimal DOM stubs — no browser needed. */
import assert from 'node:assert/strict';
import { installAvailability, monotoneCurve } from './availability.js';

class P {}
installAvailability(P);
// Provided by the host class (app-shell/dashboard) in the real app.
P.prototype._esc = s => String(s).replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);
P.prototype._getHostRoleLabel ??= () => 'blackbox';
P.prototype._formatDowntimeDuration ??= s => `${Math.round(s)}s downtime`;

const mkEl = (extra = {}) => ({
  dataset: {}, style: {}, innerHTML: '',
  _cls: new Set(),
  classList: {
    add(c) { this._o._cls.add(c); }, remove(c) { this._o._cls.delete(c); },
    toggle(c, on) { on ? this._o._cls.add(c) : this._o._cls.delete(c); },
    contains(c) { return this._o._cls.has(c); },
  },
  appendChild() {}, remove() {}, addEventListener() {}, setAttribute() {},
  querySelector: () => null, querySelectorAll: () => [], closest: () => null,
  ...extra,
});
const withClassList = el => { el.classList._o = el; return el; };
let els = {};
globalThis.document = {
  getElementById: id => els[id] || null,
  createElement: () => withClassList(mkEl()),
  querySelector: () => null,
};

/* ── 1. A 5px wobble is a click; only a real drag zooms and captures. ── */
function fakePlot() {
  const handlers = {};
  const plot = withClassList(mkEl({
    addEventListener: (t, fn) => { handlers[t] = fn; },
    getBoundingClientRect: () => ({ left: 0, width: 800 }),
    setPointerCapture() { plot.captured = true; },
  }));
  plot.captured = false;
  plot.fire = (t, e) => handlers[t]({ button: 0, pointerId: 1, ...e });
  return plot;
}
{
  const p = new P();
  const plot = fakePlot();
  const calls = [];
  p._attachZoomDrag(plot, { lo: 0, hi: 86400 }, (lo, hi) => calls.push(['zoom', lo, hi]), ts => calls.push(['click', ts]));

  plot.fire('pointerdown', { clientX: 100 });
  plot.fire('pointermove', { clientX: 105 });
  plot.fire('pointerup', { clientX: 105 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'click', '5px jitter must be a click, not a zoom');
  assert.equal(plot.captured, false, 'a click must never take pointer capture (it hides the hover tooltip)');

  calls.length = 0;
  plot.fire('pointerdown', { clientX: 100 });
  plot.fire('pointermove', { clientX: 140 });
  plot.fire('pointerup', { clientX: 140 });
  assert.equal(calls[0][0], 'zoom', 'a 40px drag zooms');
  assert.equal(plot.captured, true, 'capture only once it is a real drag');
}

/* ── 2. Empty render resets hover/click state and hides the detail panel. ── */
{
  const p = new P();
  const empty = withClassList(mkEl());
  const plot = withClassList(mkEl({ querySelector: sel => (sel === '.avb-trend-empty' ? empty : null) }));
  const evd = withClassList(mkEl({ innerHTML: 'stale detail' }));
  const pin = withClassList(mkEl());
  els = { avbTrendPlot: plot, avbTrendEventDetail: evd, avbTrendPin: pin };
  p._trendHoverState = { pts: [{ ts: 1, availability_pct: 99 }], coords: [[0, 0]] };
  plot.__avbOnClick = () => { throw new Error('stale click handler'); };

  p._renderAvailabilityTrend({ trend: [], trend_start_ts: 1000, trend_end_ts: 1000 + 86400 });
  assert.equal(p._trendHoverState, null);
  assert.equal(plot.__avbOnClick, null);
  assert.ok(evd.classList.contains('hidden'));
  assert.equal(evd.innerHTML, '');
  els = {};
}

/* ── 3. MTD is recomputed on every load, and snaps to the new month. ── */
{
  const realNow = Date.now;
  const WIB = 7 * 3600 * 1000;
  const p = new P();
  p.isRealtime = false;
  p.periodLabel = 'mtd';
  p.periodEnd = null;
  const STOP = new Error('stop after minutes are computed');
  p._getAvailCacheKey = () => { throw STOP; };
  const poll = async () => { await assert.rejects(p.loadAvailability(false), e => e === STOP); };

  // 2026-09-30 23:50 WIB, selection made then.
  Date.now = () => Date.UTC(2026, 8, 30, 23, 50) - WIB;
  p.periodMinutes = p._monthToDateMinutes();
  const sept = p.periodMinutes;
  assert.equal(sept, (29 * 24 + 23) * 60 + 50);

  // Next poll, 5 minutes later: grows with the month instead of sliding.
  Date.now = () => Date.UTC(2026, 8, 30, 23, 55) - WIB;
  await poll();
  assert.equal(p.periodMinutes, sept + 5, 'MTD recomputed on poll');

  // Rollover: 2026-10-01 00:10 WIB → the window is the new month only.
  Date.now = () => Date.UTC(2026, 9, 1, 0, 10) - WIB;
  await poll();
  assert.equal(p.periodMinutes, 10, 'after rollover MTD starts at 00:00 WIB on the 1st');

  // A custom/fixed range is left alone.
  p.periodLabel = '7d'; p.periodMinutes = 10080;
  await poll();
  assert.equal(p.periodMinutes, 10080);
  Date.now = realNow;
}

/* ── 4. Worst days: ties broken by hosts_down, then downtime. ── */
{
  const p = new P();
  const daily = [
    { date: '2026-09-01', availability_pct: 99.5, hosts_down: 1, events: [{ duration_sec: 600 }] },
    { date: '2026-09-02', availability_pct: 99.5, hosts_down: 3, events: [{ duration_sec: 60 }] },
    { date: '2026-09-03', availability_pct: 99.5, hosts_down: 1, events: [{ duration_sec: 900 }] },
    { date: '2026-09-04', availability_pct: 98.0, hosts_down: 1, events: [] },
    { date: '2026-09-05', availability_pct: null, hosts_down: 9, events: null },
    { date: '2026-09-06', availability_pct: 100.0, hosts_down: 0, events: [] },
  ];
  assert.deepEqual([...p._calendarWorstDates(daily, 3)], ['2026-09-04', '2026-09-02', '2026-09-03']);
}

/* ── 5. Retention floor distinguishes "never" from "pending". ── */
{
  const p = new P();
  p._lastAvailabilityData = { history_floor_ts: 1000 };
  assert.equal(p._isBeyondRetention(999), true);
  assert.equal(p._isBeyondRetention(1000), false);
  p._lastAvailabilityData = {};
  assert.equal(p._isBeyondRetention(1), false, 'unknown floor never claims beyond-retention');
}

/* ── 6. Click detail = the clicked moment only, not the whole trend slot. ──
   The live bug: a 4h slot held 165 changes; one click listed all of them
   under the slot-END time with a "RECOVERED" header during an outage. */
{
  const p = new P();
  const T = 1_790_000_000;             // the clicked moment
  const events = [];
  // 150 short blips spread across the surrounding 4h slot, far from T.
  for (let i = 0; i < 150; i++) {
    const s = T - 3.5 * 3600 + i * 60;
    if (Math.abs(s - T) < 1800) continue;
    events.push({ instance: `blip-${i}`, intervals: [{ start_ts: s, end_ts: s + 20 }] });
  }
  // 11 hosts down across T (long outage), one of which recovers 30s after T.
  for (let i = 0; i < 11; i++) {
    events.push({ instance: `down-${i}`, intervals: [{ start_ts: T - 7200, end_ts: i === 0 ? T + 30 : T + 7200 }] });
  }
  const sweep = p._buildFleetSweep(events, T - 86400, T + 86400);
  p._trendHoverState = { pts: [{ ts: T + 3600, availability_pct: 46 }], bucketSec: 4 * 3600 };
  p._lastAvailabilityData = { daily: [] };
  const html = p._pinHtml = p._eventDetailHtml(T, sweep, 29.5 * 3600);

  assert.ok(!/blip-/.test(html), 'changes elsewhere in the slot must not be listed');
  assert.match(html, /11 down/, 'header shows the fleet state at the clicked moment');
  assert.ok(!/avb-evd-state is-up/.test(html), 'no RECOVERED/UP header during an 11-host outage');
  assert.match(html, /Selected: down-0 recovered/, 'closest change is the selected event');
  assert.match(html, /\+6 more at this moment/, '11 rows -> 5 shown, 6 collapsed');
  assert.match(html, new RegExp(p._trendTsLabel(T, 29.5 * 3600)), 'header time is the clicked time, not the slot end');

  // A quiet moment inside a plotted slot says UP; outside any slot, NO DATA.
  p._trendHoverState.pts = [{ ts: T + 3600, availability_pct: 100 }];
  const none = p._buildFleetSweep([], T - 86400, T + 86400);
  assert.match(p._eventDetailHtml(T + 1800, none, 29.5 * 3600), /All monitored hosts up/);
  assert.match(p._eventDetailHtml(T + 3 * 3600, none, 29.5 * 3600), /NO DATA/, 'gap is not reported as UP');
}


/* ── 7. UX audit fixes: dates across midnight, step line, slot tooltip,
   legend, clustered ticks. Renders a 29.5h zoom (06:08 → 11:38 next day). */
{
  const p = new P();
  const DAY0 = Date.UTC(2026, 8, 27) / 1000 - 7 * 3600;       // Sep 27 00:00 WIB
  const lo = DAY0 + 6 * 3600 + 8 * 60, hi = lo + 29.5 * 3600;
  const bucket = 4 * 3600;
  const trend = [];
  for (let t = DAY0 - 4 * bucket; t <= hi + bucket; t += bucket) trend.push({ ts: t, availability_pct: 90, hosts_reporting: 5, hosts_expected: 5 });
  const events = [];
  for (let i = 0; i < 120; i++) events.push({ instance: `h${i}`, intervals: [{ start_ts: lo + i * 600, end_ts: lo + i * 600 + 60 }] });
  const sub = withClassList(mkEl());
  const spans = Array.from({ length: 5 }, () => withClassList(mkEl()));
  const section = mkEl({ querySelector: sel => (sel === '.modal-title-sub' ? sub : null), querySelectorAll: sel => (sel === '.avb-trend-xaxis span' ? spans : []) });
  const empty = withClassList(mkEl());
  const plot = withClassList(mkEl({ closest: () => section, querySelector: sel => (sel === '.avb-trend-empty' ? empty : null) }));
  const note = withClassList(mkEl());
  let wrap = null;
  globalThis.document.createElement = () => { const e = withClassList(mkEl()); wrap = wrap || e; return e; };
  els = { avbTrendPlot: plot, avbTrendTargetNote: note };
  p._trendZoom = { lo, hi };
  p._renderAvailabilityTrend({
    trend, trend_start_ts: DAY0 - 30 * 86400, trend_end_ts: DAY0 + 3 * 86400,
    trend_bucket_seconds: bucket, trend_incidents: events, sla: { target_pct: 99.9 },
  });

  assert.equal(p._trendSpansDays, true);
  // (single-day zoom caption is checked below, after this render)
  assert.match(sub.textContent, /Sept? 27, 06:08 WIB – Sept? 28, 11:38 WIB/, 'zoom caption carries dates');
  assert.match(spans[0].textContent, /^Sept? 27 06:08$/);
  assert.ok(spans.some(sp => /^Sept? 28 /.test(sp.textContent)), 'the first tick on the new day is dated');
  assert.ok(spans.filter(sp => /^Sep/.test(sp.textContent)).length === 2, 'only day-change ticks are dated');

  const line = (wrap.innerHTML.match(/class="avb-trend-line" d="([^"]+)"/) || [])[1] || '';
  assert.ok(line && /C/.test(line) && !/[HV]/.test(line), `trend drawn as a smooth curve, not steps: ${line.slice(0, 60)}`);

  const drops = (wrap.innerHTML.match(/avb-trend-drop-tick/g) || []).length;
  assert.ok(drops > 0 && drops <= 80, `120 drops are clustered, not hidden (got ${drops})`);

  assert.match(note.innerHTML, /avb-lg-sw is-target/);
  p._trendZoom = { lo: DAY0, hi: DAY0 + 86400 };
  p._renderAvailabilityTrend(p._lastAvailabilityData);
  assert.match(sub.textContent, /zoomed to \w+, Sept? 27, 00:00 WIB – 24:00 WIB/, 'single-day zoom names the day');
  p._trendZoom = { lo, hi };
  p._renderAvailabilityTrend(p._lastAvailabilityData);
  assert.match(note.innerHTML, /host went down/);

  // Tooltip: slot average, no invented interpolated value, time said once.
  const st = p._trendHoverState;
  const inSlot = trend.find(q => q.ts > lo + bucket && q.ts < hi);
  const tip = p._trendTipText(inSlot.ts - 3600, st, inSlot);
  assert.match(tip, /slot \d\d:\d\d–\d\d:\d\d avg 90\.00%/);
  assert.equal(p._trendValueAt(inSlot.ts - 3600, st, null), 90);
  const t0 = events[5].intervals[0].start_ts;
  const why = p._trendWhyText(t0, st, inSlot);
  assert.ok(!why.includes(p._calendarFormatTime(t0)), `cursor time not repeated: "${why}"`);
  els = {};
}

/* ── 8. Calendar: floored %, day duration, day host panel. ── */
{
  const p = new P();
  const grid = withClassList(mkEl());
  const dayEl = withClassList(mkEl());
  els = { avbCalendarGrid: grid, avbCalendarDayDetail: dayEl };
  const ev = n => Array.from({ length: n }, (_, i) => ({
    instance: `10.0.0.${i}`, name: `10.0.0.${i}`, duration_sec: 3600 * (n - i), incident_count: 1,
    start_ts: 1_790_000_000, end_ts: 1_790_000_000 + 60,
  }));
  const daily = [
    { date: '2026-09-27', availability_pct: 99.89, hosts_down: 7, events: ev(7) },
    { date: '2026-09-28', availability_pct: 100, hosts_down: 0, events: [] },
  ];
  p._calendarOpenDate = '2026-09-27';
  p._lastAvailabilityData = {};
  p._renderDowntimeCalendar({ daily, trend_start_ts: Date.UTC(2026, 8, 27) / 1000 - 7 * 3600, trend_end_ts: Date.UTC(2026, 8, 29) / 1000 - 7 * 3600 });
  assert.match(grid.innerHTML, /99\.8%/, '99.89% is floored to 99.8%, never shown as 99.9% on a breach color');
  assert.ok(!/99\.9%/.test(grid.innerHTML));
  assert.match(grid.innerHTML, /avb-calendar-dur">1d 4h</, 'Σ host downtime (28h) shown in the cell');
  assert.ok(!dayEl.classList.contains('hidden'), 'selected day opens its host panel');
  const visible = dayEl.innerHTML.split('<details')[0];
  assert.equal((visible.match(/class="avb-cal-host"/g) || []).length, 5, '5 rows shown, rest collapsed');
  assert.match(dayEl.innerHTML, /\+2 more hosts/);
  assert.match(dayEl.innerHTML, /data-instance="10\.0\.0\.0"/, 'longest outage first');

  const old = p._calendarDayDetailHtml({ date: '2026-08-01', availability_pct: 99, hosts_down: 3, events: null, events_unavailable: true });
  p._lastAvailabilityData = { history_floor_ts: Date.UTC(2026, 8, 1) / 1000 };
  assert.match(p._calendarDayDetailHtml({ date: '2026-08-01', availability_pct: 99, hosts_down: 3, events: null, events_unavailable: true }), /older than Prometheus retention/);
  assert.match(old, /backfill pending/);
  els = {};
}


/* ── 10. Zoom fetches the window's own finer trend and draws it. ── */
{
  const p = new P();
  const DAY0 = Date.UTC(2026, 8, 24) / 1000 - 7 * 3600;
  const coarse = [];
  for (let t = DAY0 - 20 * 86400; t <= DAY0 + 3 * 86400; t += 4 * 3600) coarse.push({ ts: t, availability_pct: 80 });
  const fine = [];
  for (let t = DAY0 + 600; t <= DAY0 + 86400; t += 600) fine.push({ ts: t, availability_pct: t % 1200 ? 40 : 90 });
  const urls = [];
  globalThis.fetch = async url => { urls.push(url); return { ok: true, status: 200, json: async () => ({ trend: fine, trend_bucket_seconds: 600 }) }; };
  const sub = withClassList(mkEl());
  const section = mkEl({ querySelector: sel => (sel === '.modal-title-sub' ? sub : null) });
  const plot = withClassList(mkEl({ closest: () => section, querySelector: () => withClassList(mkEl()) }));
  const wraps = [];
  globalThis.document.createElement = () => { const e = withClassList(mkEl()); wraps.push(e); return e; };
  els = { avbTrendPlot: plot };
  const data = { trend: coarse, trend_bucket_seconds: 4 * 3600, trend_start_ts: DAY0 - 20 * 86400, trend_end_ts: DAY0 + 3 * 86400, scope: { source: 'http://prom' } };
  p._trendZoom = { lo: DAY0, hi: DAY0 + 86400 };
  p._renderAvailabilityTrend(data);
  assert.equal(urls.length, 1);
  assert.ok(urls[0].includes(`/api/availability/trend?start=${DAY0}&end=${DAY0 + 86400}`), urls[0]);
  assert.match(sub.textContent, /loading detail/);
  await new Promise(r => setTimeout(r, 0));
  await new Promise(r => setTimeout(r, 0));
  const lastWrap = wraps.filter(w => w.innerHTML.includes('avb-trend-line')).pop();
  const line = (lastWrap.innerHTML.match(/class="avb-trend-line" d="([^"]+)"/) || [])[1] || '';
  assert.ok((line.match(/C/g) || []).length > 100, 'zoomed day drawn from 10-min slots, not six 4h blocks');
  assert.equal(p._trendHoverState.bucketSec, 600);
  assert.ok(!/loading detail/.test(sub.textContent));

  // Polls re-render with the same zoom: no refetch, no flicker to coarse.
  p._renderAvailabilityTrend(data);
  assert.equal(urls.length, 1);
  assert.equal(p._trendHoverState.bucketSec, 600);
  // Unzoomed: the report's own series again, nothing fetched.
  p._trendZoom = { lo: null, hi: null };
  p._renderAvailabilityTrend(data);
  assert.equal(p._trendHoverState.bucketSec, 4 * 3600);
  assert.equal(urls.length, 1);
  els = {};
}


/* ── 11. Live-audit regressions. ── */
{
  const p = new P();
  // Click panel: newest drop first, chronic (carried-in) hosts last.
  const T = 1_790_000_000;
  const sweep = p._buildFleetSweep([
    { instance: 'chronic', intervals: [{ start_ts: T - 86400, end_ts: T + 3600, carried_in: true }] },
    { instance: 'old-drop', intervals: [{ start_ts: T - 3000, end_ts: T + 3600 }] },
    { instance: 'new-drop', intervals: [{ start_ts: T - 1200, end_ts: T + 3600 }] },
  ], T - 3600, T + 7200);
  p._trendHoverState = { pts: [{ ts: T + 600, availability_pct: 0 }], bucketSec: 600 };
  p._lastAvailabilityData = { daily: [] };
  const html = p._eventDetailHtml(T, sweep, 7200);
  const order = ['new-drop', 'old-drop', 'chronic'].map(h => html.indexOf(`>${h}<`));
  assert.ok(order[0] < order[1] && order[1] < order[2], `row order ${order}`);

  // Day panel lists real intervals, not first-start..last-end.
  const D0 = p._wibDayStartTs('2026-09-24');
  const day = p._calendarDayDetailHtml({ date: '2026-09-24', availability_pct: 47, hosts_down: 1, events: [{
    instance: 'h', name: 'h', duration_sec: 13 * 3600, incident_count: 3,
    start_ts: D0, end_ts: D0 + 86400,
    intervals: [
      { start_ts: D0, end_ts: D0 + 7200, carried_in: true, still_down: true },
      { start_ts: D0 + 35400, end_ts: D0 + 64800, carried_in: true, still_down: true },  // legacy flags mid-day
      { start_ts: D0 + 74040, end_ts: D0 + 86400, still_down: true },
    ],
  }] });
  assert.match(day, /…00:00–02:00…, 09:50–18:00…, 20:34–24:00… WIB/);

  // Reset zoom / Today keep the Calendar selection in sync.
  let rendered = 0;
  p._renderDowntimeCalendar = () => { rendered++; };
  p._calendarOpenDate = '2026-09-10';
  p._setCalendarSelection(null);
  assert.equal(p._calendarOpenDate, null);
  assert.equal(rendered, 1);
  p._setCalendarSelection(null);
  assert.equal(rendered, 1, 'no re-render when nothing changed');
}

/* ── 12. Zoom into a past gap says so, not "populates once …". ── */
{
  const p = new P();
  const pEl = mkEl({ textContent: 'No trend series for this range yet.' });
  const sEl = mkEl({ textContent: 'The line chart populates once Prometheus has telemetry across the selected range.' });
  const empty = withClassList(mkEl({ querySelector: sel => (sel === 'p' ? pEl : sel === 'span' ? sEl : null) }));
  const plot = withClassList(mkEl({ querySelector: sel => (sel === '.avb-trend-empty' ? empty : null) }));
  els = { avbTrendPlot: plot };
  const D = Date.UTC(2026, 8, 17) / 1000;
  p._trendZoom = { lo: D, hi: D + 2 * 86400 };
  p._renderAvailabilityTrend({ trend: [], trend_start_ts: D - 10 * 86400, trend_end_ts: D + 10 * 86400, trend_bucket_seconds: 14400 });
  assert.equal(pEl.textContent, 'No telemetry in this window.');
  assert.match(sEl.textContent, /Prometheus has no samples for .* Reset zoom/);
  els = {};
}


/* ── 13. Smooth line: monotone cubic through slot midpoints. ── */
{
  const pts = [[0, 10], [10, 10], [20, 80], [30, 20], [40, 20]];
  const c = monotoneCurve(pts);
  assert.equal((c.d.match(/C/g) || []).length, 4);
  for (const [x, y] of pts) assert.ok(Math.abs(c.at(x) - y) < 1e-9, 'passes through every point');
  for (let i = 0; i < pts.length - 1; i++) {
    const lo = Math.min(pts[i][1], pts[i + 1][1]), hi = Math.max(pts[i][1], pts[i + 1][1]);
    for (let k = 1; k < 20; k++) {
      const y = c.at(pts[i][0] + (pts[i + 1][0] - pts[i][0]) * k / 20);
      assert.ok(y >= lo - 1e-9 && y <= hi + 1e-9, `no overshoot between points ${i},${i + 1}: ${y}`);
    }
  }
  assert.equal(c.at(5), 10, 'flat stretch stays flat (no wobble)');
  assert.equal(monotoneCurve([[3, 7]]).d, '');
}


/* ── 14. Detail endpoint missing (old server): no stuck "loading", no retry storm. ── */
{
  const p = new P();
  const urls = [];
  globalThis.fetch = async url => { urls.push(url); return { ok: false, status: 404, json: async () => ({}) }; };
  const sub = withClassList(mkEl());
  const section = mkEl({ querySelector: sel => (sel === '.modal-title-sub' ? sub : null) });
  const plot = withClassList(mkEl({ closest: () => section, querySelector: () => withClassList(mkEl()) }));
  els = { avbTrendPlot: plot };
  const D = Date.UTC(2026, 8, 24) / 1000 - 7 * 3600;
  const trend = []; for (let t = D - 5 * 86400; t <= D + 2 * 86400; t += 14400) trend.push({ ts: t, availability_pct: 80 });
  const data = { trend, trend_bucket_seconds: 14400, trend_start_ts: D - 5 * 86400, trend_end_ts: D + 2 * 86400, scope: { source: 'x' } };
  p._trendZoom = { lo: D, hi: D + 86400 };
  p._renderAvailabilityTrend(data);
  await new Promise(r => setTimeout(r, 0)); await new Promise(r => setTimeout(r, 0));
  assert.ok(!/loading detail/.test(sub.textContent), `caption: ${sub.textContent}`);
  p._renderAvailabilityTrend(data); p._renderAvailabilityTrend(data);
  assert.equal(urls.length, 1, 'no refetch on every poll after a failure');
  els = {};
}

/* ── 9. Compact durations never print a 60 in a unit. ── */
{
  const p = new P();
  assert.equal(p._compactDur(14 * 3600 + 59 * 60 + 50), '15h');
  assert.equal(p._compactDur(3 * 3600 + 5 * 60), '3h 5m');
  assert.equal(p._compactDur(2 * 86400 + 23 * 3600 + 50 * 60), '3d');
  assert.equal(p._compactDur(59.6 * 60), '1h');
}

console.log('availability trend interaction + calendar ranking: ok');
