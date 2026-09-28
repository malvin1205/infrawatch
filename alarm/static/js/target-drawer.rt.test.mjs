/* Self-check for the drawer's Response Time Trend.
 * Run: node alarm/static/js/target-drawer.rt.test.mjs
 *
 * Covers: the card's range never touches the dashboard period; MTD/custom
 * windows; the chart is plotted against the requested window with gaps and
 * failed-probe runs split out; whole-window stats come from the backend. */
import assert from 'node:assert/strict';
import { installTargetDrawer } from './target-drawer.js';
import { installAvailability } from './availability.js';

// Minimal DOM: elements by id, each with classList/style/innerHTML.
const mkEl = (extra = {}) => {
  const el = {
    dataset: {}, style: {}, innerHTML: '', textContent: '', _cls: new Set(),
    addEventListener() {}, querySelector: () => null, querySelectorAll: () => [],
    getBoundingClientRect: () => ({ left: 0, width: 600, right: 600, top: 0, height: 130 }),
    ...extra,
  };
  el.classList = {
    add: c => el._cls.add(c), remove: c => el._cls.delete(c),
    toggle: (c, on) => (on ? el._cls.add(c) : el._cls.delete(c)), contains: c => el._cls.has(c),
  };
  return el;
};
let els = {};
const btns = ['5m', '15m', '1h', '6h', '24h', '7d', '30d', 'mtd', 'custom'].map(r => { const b = mkEl(); b.dataset.range = r; return b; });
globalThis.document = {
  getElementById: id => els[id] || null,
  querySelectorAll: sel => (sel === '#spRangeGroup .sp-range-btn' ? btns : []),
  querySelector: () => null,
};

class P {}
installAvailability(P);
installTargetDrawer(P);
P.prototype._esc = s => String(s);

/* ── 1. Range buttons are card-local: the dashboard period is untouched. ── */
{
  const p = new P();
  p.periodMinutes = 1440; p.periodLabel = '24h'; p.periodEnd = null;
  const fetched = [];
  p._loadRtSparkline = inst => fetched.push([inst, p._rtWindow()]);
  p.selectedTarget = { instance: '1.0.0.1' };
  els = { drawerSparklineRange: mkEl() };

  assert.equal(p._rtWindow().label, '24h', 'follows the dashboard until a button is used');
  p._setRtRange('7d');
  assert.equal(p.periodMinutes, 1440);
  assert.equal(p.periodLabel, '24h', 'dashboard period must not change');
  assert.equal(fetched.at(-1)[1].minutes, 10080);
  assert.equal(els.drawerSparklineRange.textContent, '(7d)');
  assert.ok(btns.find(b => b.dataset.range === '7d').classList.contains('active'));

  p._setRtRange('30d');
  assert.equal(fetched.at(-1)[1].minutes, 43200);
  p._setRtRange('mtd');
  assert.equal(p._rtWindow().minutes, p._monthToDateMinutes(), 'MTD recomputed, not frozen');
  assert.equal(els.drawerSparklineRange.textContent, '(Month to date)');
  p._setRtRange('bogus');
  assert.equal(p._rtWindow().label, 'mtd', 'unknown range ignored');
}

/* ── 2. Custom range validation + apply. ── */
{
  const p = new P();
  p.periodMinutes = 1440; p.periodLabel = '24h';
  p.selectedTarget = { instance: 'h' };
  const loads = [];
  p._loadRtSparkline = () => loads.push(p._rtWindow());
  const from = mkEl(), to = mkEl(), err = mkEl(), box = mkEl();
  els = { spCustomFrom: from, spCustomTo: to, spCustomError: err, spCustomRange: box, drawerSparklineRange: mkEl() };
  from.value = '2026-09-24T15:00'; to.value = '2026-09-24T09:00';
  p._applyRtCustomRange();
  assert.ok(err.classList.contains !== undefined && !err.classList.contains('hidden') && /after/.test(err.textContent));
  assert.equal(loads.length, 0);
  from.value = '2026-09-24T09:00'; to.value = '2026-09-24T15:00';
  p._applyRtCustomRange();
  assert.equal(loads.length, 1);
  assert.equal(loads[0].label, 'custom');
  assert.equal(loads[0].minutes, 360);
  assert.equal(p.periodLabel, '24h');
}

/* ── 3. Rendering: window domain, gaps, failed runs, backend stats. ── */
{
  const p = new P();
  p.selectedTarget = { instance: 'h' };
  const wrap = mkEl();
  const now = mkEl(), avg = mkEl(), p95 = mkEl(), max = mkEl();
  const nowLabel = mkEl();
  now.previousElementSibling = nowLabel;
  els = { drawerSparkline: wrap, spStatNow: now, spStatAvg: avg, spStatP95: p95, spStatMax: max, drawerSparklineBadge: mkEl(), sparklineResetZoomBtn: mkEl() };

  const S = 1_790_000_000, step = 300;
  const pts = [];
  for (let t = S + 3600; t <= S + 7200; t += step) pts.push([t, 10 + (t % 7)]);        // run 1
  for (let t = S + 14400; t <= S + 18000; t += step) pts.push([t, 20]);                // run 2 after a 2h hole
  p._renderSparkline(pts, false, {
    start: S, end: S + 21600, step,
    stats: { avg: 12.3, p95: 19.9, max: 821.2 },
    failed: [[S + 9000, S + 12000, null, 10]],
  });

  const line = (wrap.innerHTML.match(/class="spark-line" d="([^"]+)"/) || [])[1];
  assert.equal((line.match(/M/g) || []).length, 2, 'line breaks at the 2h hole instead of bridging it');
  const firstX = parseFloat(line.slice(1));
  assert.ok(Math.abs(firstX - 100) < 1, `x domain is the window: first point at 1/6 of width, got ${firstX}`);
  assert.equal(avg.textContent, '12.3 ms', 'window stats from the backend');
  assert.equal(p95.textContent, '19.9 ms');
  assert.equal(max.textContent, '821.2 ms', 'MAX is the raw max, not the max of plotted averages');
  assert.match(wrap.innerHTML, /fill="rgba\(239,68,68,0\.16\)"/, 'failed-probe run shaded red');
  assert.match(wrap.innerHTML, /probe failed/);
  assert.match(wrap.innerHTML, /no data/);
  assert.equal(nowLabel.textContent, 'Last', 'a past window has a last value, not a current one');
  const ticks = [...wrap.innerHTML.matchAll(/<span style="position:absolute; right:0;[^>]*>([^<]+)</g)].map(m => parseFloat(m[1]));
  assert.ok(Math.max(...ticks) < 100, `y scale follows the plotted points, not the 821ms MAX (top tick ${Math.max(...ticks)})`);
}

console.log('drawer response time trend: ok');
