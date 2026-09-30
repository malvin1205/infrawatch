/* Self-check for Alert Log / Incident History helpers.
 * Run: node alarm/static/js/alert-log.test.mjs */
import assert from 'node:assert/strict';

globalThis.window = globalThis.window || { addEventListener() {} };
globalThis.document = globalThis.document || {
  getElementById: () => null, querySelectorAll: () => [], querySelector: () => null, addEventListener() {},
};
globalThis.localStorage = globalThis.localStorage || { getItem: () => null, setItem() {}, removeItem() {} };

const { formatWib, isoWib, wibInputToEpoch, epochToWibInput } = await import('./ui/format.js');
const { LogsPage } = await import('./logs.js');
const { csvCell, overlapsRange, reportHtml } = await import('./history.js');

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

// Custom range inputs are WIB wall clock, whatever the browser's zone.
assert.equal(wibInputToEpoch('2026-09-30T21:59'), Date.UTC(2026, 8, 30, 14, 59) / 1000);
assert.equal(epochToWibInput(wibInputToEpoch('2026-09-01T00:00')), '2026-09-01T00:00');
assert.equal(wibInputToEpoch(''), null);

// Range = activity overlap: ongoing-from-before counts, ended-before / began-after don't.
const [F, TO, NOW] = [1000, 2000, 5000];
assert.ok(overlapsRange({ status: 'firing', first_seen: 10, time: 10 }, F, TO, NOW), 'still open from before');
assert.ok(overlapsRange({ status: 'resolved', first_seen: 500, resolved_time: 1500 }, F, TO, NOW), 'resolved inside');
assert.ok(!overlapsRange({ status: 'resolved', first_seen: 500, resolved_time: 900 }, F, TO, NOW), 'ended before');
assert.ok(!overlapsRange({ status: 'firing', first_seen: 2500, time: 2500 }, F, TO, NOW), 'began after custom end');

// Report escapes host text and handles an empty result.
const base = { title: 'T', range: 'R', generated: 'G', filters: '', summary: [['Total incidents', 0]] };
const html = reportHtml({ ...base, rows: [{ start: 's', end: 'e', duration: 'd', host: '<b>x</b>', type: 't', status: 'Resolved' }] });
assert.ok(html.includes('&lt;b&gt;x&lt;/b&gt;') && !html.includes('<b>x</b>'));
assert.ok(reportHtml({ ...base, rows: [] }).includes('No incidents in the selected range.'));

console.log('alert log helpers: ok');
