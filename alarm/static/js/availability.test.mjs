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

// ── Curve Vertex Nodes (docs/concepts/availability-trend-option4-vertex-nodes.md) ──
// A tiny DOM that keeps children, handlers and attributes, enough to render
// the Trend and drive its node layer.
const fakeEl = (tag = 'div') => {
  const el = {
    tagName: tag.toUpperCase(), id: '', className: '', dataset: {}, style: {}, attrs: {}, children: [],
    _html: '', textContent: '', title: '', handlers: {}, parentNode: null,
    appendChild(c) { c.parentNode = el; el.children.push(c); return c; },
    remove() { if (el.parentNode) el.parentNode.children = el.parentNode.children.filter(x => x !== el); },
    addEventListener(t, fn) { (el.handlers[t] = el.handlers[t] || []).push(fn); },
    dispatch(t, e = {}) { const ev = { stopPropagation() { ev.stopped = true; }, preventDefault() {}, ...e }; (el.handlers[t] || []).forEach(fn => fn(ev)); return ev; },
    setAttribute(k, v) { el.attrs[k] = String(v); },
    getAttribute(k) { return el.attrs[k]; },
    querySelector: sel => el.find(sel)[0] || null,
    querySelectorAll: sel => el.find(sel),
    find(sel) {
      const out = [];
      const match = n => (sel.startsWith('#') ? n.id === sel.slice(1) : sel.startsWith('.') ? ` ${n.className} `.includes(` ${sel.slice(1)} `) : false);
      const walk = n => n.children.forEach(c => { if (match(c)) out.push(c); walk(c); });
      walk(el);
      return out;
    },
    closest: () => null,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 1000, height: 128 }),
  };
  Object.defineProperty(el, 'innerHTML', {
    get() { return el._html; },
    set(v) {
      el._html = v; el.children = [];
      for (const m of String(v).matchAll(/<(\w+) class="([^"]+)"/g)) { const c = fakeEl(m[1]); c.className = m[2]; el.appendChild(c); }
    },
  });
  el.classList = {
    add: c => { if (!el.classList.contains(c)) el.className = `${el.className} ${c}`.trim(); },
    remove: c => { el.className = el.className.split(/\s+/).filter(x => x && x !== c).join(' '); },
    toggle: (c, on) => (on ?? !el.classList.contains(c)) ? el.classList.add(c) : el.classList.remove(c),
    contains: c => el.className.split(/\s+/).includes(c),
  };
  return el;
};
const nodeDom = () => {
  const plot = fakeEl(); plot.id = 'avbTrendPlot';
  const note = fakeEl(); note.id = 'avbTrendTargetNote';
  const evd = fakeEl(); evd.id = 'avbTrendEventDetail';
  const byId = id => [plot, note, evd].find(e => e.id === id) || plot.find(`#${id}`)[0] || null;
  globalThis.document.getElementById = byId;
  globalThis.document.createElement = tag => fakeEl(tag);
  return { plot, note, evd };
};
const restoreDom = () => {
  globalThis.document.getElementById = id => els[id] || null;
  globalThis.document.createElement = () => mkEl();
};
const trendAround = (lo, hi, pct = 80) => {
  const t = [];
  for (let x = lo + H; x <= hi; x += H) t.push({ ts: x, availability_pct: pct });
  return t;
};
const renderNodes = (p, data) => {
  const dom = nodeDom();
  p._renderAvailabilityTrend(data);
  const layer = dom.plot.find('#avbTrendNodesLayer')[0];
  return { ...dom, layer, nodes: layer ? layer.children.filter(c => ` ${c.className} `.includes(' avb-node ')) : [] };
};

check('Vertex nodes: an event is an HTML node on the curve, not a full-height line', () => {
  const p = new P();
  const lo = DAY0, hi = DAY0 + 86400;
  const r = renderNodes(p, { trend: trendAround(lo, hi), trend_start_ts: lo, trend_end_ts: hi, trend_bucket_seconds: H,
    trend_incidents: [{ instance: 'db-prod-01', intervals: [{ start_ts: at(6), end_ts: at(8) }] }] });
  restoreDom();
  const svg = r.plot.find('#avbTrendSvgWrap')[0];
  assert.ok(!/drop-tick|recovery-tick|y1="0" y2="100"/.test(svg ? svg.innerHTML : ''), 'no barcode line left in the SVG');
  assert.equal(r.nodes.length, 2, 'one down node + one recovery node');
  const down = r.nodes.find(n => n.className.includes('is-drop'));
  const xp = ((at(6) - lo) / 86400) * 100;
  assert.ok(Math.abs(parseFloat(down.style.left) - xp) < 0.01, `left ${down.style.left} vs ${xp}`);
  const lineY = p._trendLineY(xp, p._trendHoverState);
  assert.ok(Math.abs(parseFloat(down.style.top) - lineY) < 0.01, `node sits on the curve: ${down.style.top} vs ${lineY}`);
});

check('Vertex nodes: a burst of changes is clustered by pixel distance and every change counted once', () => {
  const p = new P();
  const lo = DAY0, hi = DAY0 + 86400;
  const ev = Array.from({ length: 120 }, (_, i) => ({ instance: `h${i}`, intervals: [{ start_ts: lo + 600 + i * 300, end_ts: lo + 660 + i * 300 }] }));
  const r = renderNodes(p, { trend: trendAround(lo, hi), trend_start_ts: lo, trend_end_ts: hi, trend_bucket_seconds: H, trend_incidents: ev });
  restoreDom();
  const lefts = r.nodes.map(n => parseFloat(n.style.left)).sort((a, b) => a - b);
  for (let i = 1; i < lefts.length; i++) assert.ok((lefts[i] - lefts[i - 1]) * 10 >= 26, `nodes ${lefts[i - 1]}% and ${lefts[i]}% overlap on a 1000px plot (major halo is 24px)`);
  const counted = r.nodes.reduce((s, n) => s + Number(n.dataset.drops) + Number(n.dataset.recs), 0);
  assert.equal(counted, 240, '120 drops + 120 recoveries all represented');
});

check('Vertex nodes: hover card names hosts and duration; mixed cluster shows both kinds', () => {
  const p = new P();
  const lo = DAY0, hi = DAY0 + 86400;
  const r = renderNodes(p, { trend: trendAround(lo, hi), trend_start_ts: lo, trend_end_ts: hi, trend_bucket_seconds: H,
    trend_incidents: [
      { instance: 'db-prod-01', intervals: [{ start_ts: at(6), end_ts: at(8) }] },
      { instance: 'db-prod-<02>', intervals: [{ start_ts: at(6) + 30, end_ts: at(8) + 20 }] },
      { instance: 'web-1', intervals: [{ start_ts: at(2), end_ts: at(6) + 60 }] },
    ] });
  const node = r.nodes.find(n => Number(n.dataset.drops) === 2);
  assert.ok(node, 'two drops 30s apart are one node');
  node.dispatch('mouseenter');
  const card = r.plot.find('#avbTrendNodeCard')[0];
  restoreDom();
  assert.ok(card && !card.classList.contains('hidden'));
  const text = card.children.map(c => c.textContent).join(' | ');
  assert.match(text, /2 Hosts Down/);
  assert.match(text, /1 recovered/, `mixed cluster keeps the recovery: ${text}`);
  assert.match(text, /db-prod-01, db-prod-<02>/, 'names via textContent (escaped by the DOM)');
  assert.match(text, /\(2h\)/, 'longest outage of the cluster');
});

check('Vertex nodes: a busy 30d stays calm (<= ~20 nodes, at most one pulse)', () => {
  const p = new P();
  const lo = DAY0 - 29 * 86400, hi = DAY0 + 86400;
  // Chronic fleet: a change every 3h for 30 days, 12 hosts that never recover.
  const ev = Array.from({ length: 240 }, (_, i) => ({ instance: `f${i}`, intervals: [{ start_ts: lo + 1800 + i * 10800, end_ts: lo + 2400 + i * 10800 }] }))
    .concat(Array.from({ length: 12 }, (_, i) => ({ instance: `c${i}`, intervals: [{ start_ts: lo + 7200 + i * 2.3 * 86400, end_ts: hi, still_down: true }] })));
  const trend = [];
  for (let t = lo + 4 * H; t <= hi; t += 4 * H) trend.push({ ts: t, availability_pct: 75 });
  const r = renderNodes(p, { trend, trend_start_ts: lo, trend_end_ts: hi, trend_bucket_seconds: 4 * H, trend_incidents: ev });
  restoreDom();
  assert.ok(r.nodes.length <= 21, `${r.nodes.length} nodes on a 1000px plot`);
  const counted = r.nodes.reduce((a, n) => a + Number(n.dataset.drops) + Number(n.dataset.recs), 0);
  assert.equal(counted, 240 * 2 + 12, 'still every change represented');
  const live = r.nodes.filter(n => n.className.includes('is-live'));
  assert.equal(live.length, 1, `one pulse, not ${live.length}`);
  const lastLive = Math.max(...r.nodes.filter(n => Number(n.dataset.drops) > 0).map(n => Number(n.dataset.ts)).filter(ts => ts >= lo + 7200 + 11 * 2.3 * 86400 - 86400 * 2));
  assert.ok(Number(live[0].dataset.ts) >= lo + 7200 + 11 * 2.3 * 86400 - 86400 * 2, 'the pulse is the latest still-down drop');
});

check('Modal range dropdown follows a range picked from the dashboard chips', () => {
  const p = new P();
  const label = mkEl({ textContent: 'Last 24 Hours' });
  const sel = { options: [{ value: '1440', textContent: 'Last 24 Hours' }, { value: 'mtd', textContent: 'Month to date' }], selectedIndex: 0,
    parentElement: { querySelector: q => (q === '.job-dd-label' ? label : null) } };
  Object.defineProperty(sel, 'value', {
    get() { return this.options[this.selectedIndex].value; },
    set(v) { const i = this.options.findIndex(o => o.value === v); if (i >= 0) this.selectedIndex = i; },
  });
  els = { modalRangeSelect: sel };
  p.periodLabel = 'mtd';
  p.periodMinutes = 40000;
  p._syncModalRangeSelect();
  els = {};
  assert.equal(sel.value, 'mtd');
  assert.equal(label.textContent, 'Month to date');
});

check('Vertex nodes: the detail a node opens lists exactly the hosts of that node', () => {
  const p = new P();
  const lo = DAY0, hi = DAY0 + 86400;
  // One node on a 1000px plot (26px = 37 min at 24h): changes spread over 20 min.
  const ev = [
    { instance: 'h-early', intervals: [{ start_ts: at(12), end_ts: at(12) + 120 }] },
    { instance: 'h-mid', intervals: [{ start_ts: at(12) + 600, end_ts: at(12) + 700 }] },
    { instance: 'h-late', intervals: [{ start_ts: at(12) + 1200, end_ts: at(12) + 1260 }] },
  ];
  const r = renderNodes(p, { trend: trendAround(lo, hi), trend_start_ts: lo, trend_end_ts: hi, trend_bucket_seconds: H, trend_incidents: ev });
  assert.equal(r.nodes.length, 1, 'one node for the 21-minute burst');
  r.nodes[0].dispatch('click');
  const html = r.evd.innerHTML;
  const listed = [...html.matchAll(/class="avb-evd-host" title="([^"]+)"/g)].map(m => m[1]);
  assert.deepEqual([...new Set(listed)].sort(), ['h-early', 'h-late', 'h-mid'], `detail lists every host of the node: ${listed}`);
  assert.match(html, /12:00 – 12:21 WIB/, 'header names the node time range');
  // A poll re-render re-pins the same node range, not just its first second.
  p._renderAvailabilityTrend(p._lastAvailabilityData);
  const again = [...r.evd.innerHTML.matchAll(/class="avb-evd-host" title="([^"]+)"/g)].map(m => m[1]);
  restoreDom();
  assert.deepEqual([...new Set(again)].sort(), ['h-early', 'h-late', 'h-mid']);
});

check('Vertex nodes: the card counts distinct hosts, not changes (a flapping host is one host)', () => {
  const p = new P();
  const t = p._trendNodeText(
    [{ host: 'a', name: 'a', interval: { s: 0, e: 60, isRecovery: true } },
     { host: 'a', name: 'a', interval: { s: 90, e: 150, isRecovery: true } },
     { host: 'b', name: 'b', interval: { s: 10, e: 70, isRecovery: true } }],
    []);
  assert.equal(t.title, '● 2 Hosts Down');
  assert.match(t.extra, /3 drops/, `flaps are still visible: ${t.extra}`);
});

check('Vertex nodes: an event inside a telemetry gap is not drawn as a value', () => {
  const p = new P();
  const lo = DAY0, hi = DAY0 + 86400;
  const trend = trendAround(lo, hi).filter(q => q.ts < at(8) || q.ts > at(14));  // gap 08:00-14:00
  const r = renderNodes(p, { trend, trend_start_ts: lo, trend_end_ts: hi, trend_bucket_seconds: H,
    trend_incidents: [{ instance: 'h', intervals: [{ start_ts: at(10), end_ts: at(10) + 600 }] }] });
  restoreDom();
  assert.ok(r.nodes.length >= 1);
  for (const n of r.nodes) {
    assert.ok(n.className.includes('is-offcurve'), 'marked off-curve');
    assert.ok(parseFloat(n.style.top) <= 6, `pinned to the top rail, not a fake y (${n.style.top})`);
  }
});

check('Vertex nodes: legend lists only the kinds drawn; empty chart clears stale nodes', () => {
  const p = new P();
  const lo = DAY0, hi = DAY0 + 86400;
  const r = renderNodes(p, { trend: trendAround(lo, hi), trend_start_ts: lo, trend_end_ts: hi, trend_bucket_seconds: H,
    trend_incidents: [{ instance: 'h', intervals: [{ start_ts: at(20), end_ts: hi, still_down: true }] }] });
  assert.match(r.note.innerHTML, /Node Down/);
  assert.ok(!/Node Recovery/.test(r.note.innerHTML), `no recovery drawn: ${r.note.innerHTML}`);
  p._renderAvailabilityTrend({ trend: [], trend_start_ts: lo, trend_end_ts: hi });
  const layer = r.plot.find('#avbTrendNodesLayer')[0];
  restoreDom();
  assert.ok(!layer || layer.children.filter(c => c.className.includes('avb-node')).length === 0, 'stale nodes removed');
});

check('Vertex nodes: pulse only for real incidents, never on recoveries', () => {
  const p = new P();
  const lo = DAY0, hi = DAY0 + 86400;
  const ev = [0, 1].map(i => ({ instance: `a${i}`, intervals: [{ start_ts: at(4) + i, end_ts: at(9) + i }] }))
    .concat([0, 1, 2].map(i => ({ instance: `b${i}`, intervals: [{ start_ts: at(15) + i, end_ts: at(22) + i }] })));
  const r = renderNodes(p, { trend: trendAround(lo, hi), trend_start_ts: lo, trend_end_ts: hi, trend_bucket_seconds: H, trend_incidents: ev });
  restoreDom();
  const majors = r.nodes.filter(n => n.className.includes('is-major'));
  assert.equal(majors.length, 1, 'only the 3-host drop is major');
  assert.ok(majors[0].className.includes('is-drop'));
  assert.equal(r.nodes.filter(n => n.className.includes('is-live')).length, 0, 'nothing pulses when every outage has recovered');
  // Only a drop whose hosts are STILL down pulses (a live incident), however many hosts.
  const p2 = new P();
  const live = renderNodes(p2, { trend: trendAround(lo, hi), trend_start_ts: lo, trend_end_ts: hi, trend_bucket_seconds: H,
    trend_incidents: ev.concat([{ instance: 'c0', intervals: [{ start_ts: at(20), end_ts: hi, still_down: true }] }]) });
  restoreDom();
  const pulsing = live.nodes.filter(n => n.className.includes('is-live'));
  assert.equal(pulsing.length, 1, 'the ongoing outage pulses');
  assert.ok(Math.abs(Number(pulsing[0].dataset.ts) - at(20)) < 1);
});

check('Vertex nodes: click/Enter pin the event; pressing a node never starts a drag-zoom', () => {
  const p = new P();
  const lo = DAY0, hi = DAY0 + 86400;
  const r = renderNodes(p, { trend: trendAround(lo, hi), trend_start_ts: lo, trend_end_ts: hi, trend_bucket_seconds: H,
    trend_incidents: [{ instance: 'h', intervals: [{ start_ts: at(6), end_ts: at(7) }] }] });
  const node = r.nodes[0];
  assert.equal(node.getAttribute('tabindex'), '0');
  assert.equal(node.getAttribute('role'), 'button');
  const down = node.dispatch('pointerdown', { button: 0 });
  assert.ok(down.stopped, 'pointerdown stays on the node');
  node.dispatch('click');
  assert.ok(!r.evd.classList.contains('hidden') && r.evd.innerHTML.length > 0, 'detail panel opened');
  assert.equal(p._trendPinTs, at(6));
  p._clearTrendHighlight();
  node.dispatch('keydown', { key: 'Enter' });
  restoreDom();
  assert.equal(p._trendPinTs, at(6), 'Enter opens it too');
});

if (failures.length) {
  console.error(`availability.test.mjs: ${failures.length} failing\n  - ${failures.join('\n  - ')}`);
  process.exit(1);
}
console.log('availability geometry + calendar: ok');
