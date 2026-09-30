/* Self-check for Alert Log / Incident History helpers.
 * Run: node alarm/static/js/alert-log.test.mjs */
import assert from 'node:assert/strict';

globalThis.window = globalThis.window || { addEventListener() {} };
globalThis.document = globalThis.document || {
  getElementById: () => null, querySelectorAll: () => [], querySelector: () => null, addEventListener() {},
};
globalThis.localStorage = globalThis.localStorage || { getItem: () => null, setItem() {}, removeItem() {} };

const { formatWib, isoWib } = await import('./ui/format.js');
const { LogsPage } = await import('./logs.js');
const { csvCell } = await import('./history.js');

const T = Date.UTC(2026, 8, 30, 14, 59, 55) / 1000;  // 21:59:55 WIB, 30 Sep 2026
assert.equal(formatWib(T, { seconds: true, now: T * 1000 }), '21:59:55 · 30/09');
assert.equal(formatWib(T, { now: Date.UTC(2027, 0, 5) }), '21:59 · 30/09/2026', 'year shown when not this year');
assert.equal(formatWib(0), '—');
assert.equal(isoWib(T), '2026-09-30 21:59:55 WIB');

// Newest first. api: fired then recovered (old firing is NOT "now"); web: still firing.
const rows = [
  { event: 'resolved', key: 'TargetDown|api', time: 5 },
  { event: 'firing', key: 'SlowResponse|web', time: 4 },
  { event: 'firing', key: 'TargetDown|api', time: 3 },
  { event: 'resolved', key: 'TargetDown|api', time: 2 },
  { event: 'firing', key: 'TargetDown|api', time: 1 },
];
const open = LogsPage.openFiringRows(rows);
assert.deepEqual([...open].map(r => r.key), ['SlowResponse|web']);
assert.equal(LogsPage.flapCounts(rows).get('TargetDown|api'), 2);

assert.equal(csvCell('=HYPERLINK("x")'), `"'=HYPERLINK(""x"")"`);
assert.equal(csvCell('-1+2'), `"'-1+2"`);
assert.equal(csvCell('192.168.9.1'), '"192.168.9.1"');
assert.equal(csvCell(null), '""');

console.log('alert log helpers: ok');
