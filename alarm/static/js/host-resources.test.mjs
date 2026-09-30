/* Self-check for the drawer's "Host resources" section.
 * Run: node alarm/static/js/host-resources.test.mjs */
import assert from 'node:assert/strict';
import { renderHostResources, renderHostDetail, hrLevel, fmtAge, fmtUptime } from './ui/host-resources.js';

const NOW = 1_790_000_000;
const base = {
  ok: true, instance: '10.0.0.5', ip: '10.0.0.5', alias: false, source: 'http://prom:9090', prometheus_ok: true,
  port: { state: 'open', kind: 'node_exporter', checked_at: NOW - 120, number: 9100 },
};

// Threshold colours: >=80 orange, >=90 red.
assert.equal(hrLevel(79.9), 'is-ok');
assert.equal(hrLevel(80), 'is-warn');
assert.equal(hrLevel(90), 'is-crit');
assert.equal(hrLevel(undefined), '');
assert.equal(fmtAge(120), '2m');
assert.equal(fmtUptime(3 * 86400 + 5 * 3600), '3d 5h');

// Scraped host: mini bars with widths and levels, RAM in GB, fullest disk, facts.
{
  const html = renderHostResources({
    ...base, status: 'open_scraped',
    resources: { up: 1, exporter: '10.0.0.5:9100', cpu_pct: 12.3, mem_total_bytes: 8 * 2 ** 30, mem_used_bytes: 6.8 * 2 ** 30,
      mem_pct: 85, disk_pct: 93.5, disk_mount: '/var', load_per_core: 0.46, uptime_sec: 3 * 86400, age_sec: 5, stale: false },
  }, NOW);
  assert.match(html, /open · scraped · checked 2m ago/);
  assert.match(html, /<span class="hr-bar is-ok"><span class="hr-bar-fill" style="width:12.3%">/, 'CPU bar green');
  assert.match(html, /<span class="hr-bar is-warn"><span class="hr-bar-fill" style="width:85.0%">/, 'RAM bar orange');
  assert.match(html, /<span class="hr-bar is-crit"><span class="hr-bar-fill" style="width:93.5%">/, 'disk bar red');
  assert.match(html, /6\.8 \/ 8\.0 GB · 85\.0%/);
  assert.match(html, /\/var · 93\.5%/);
  assert.match(html, /Load\/core <b>0\.46<\/b> · Uptime <b>3d 0h<\/b> · Source <b>10\.0\.0\.5:9100<\/b>/);
  assert.match(html, /data-hr-recheck/, 'Recheck button');
  assert.match(html, /data-hr-more/, 'lazy partitions & network');
  assert.doesNotMatch(html, /hr-stale/);
}

// Stale: greyed, with the data's age.
{
  const html = renderHostResources({
    ...base, status: 'open_scraped',
    resources: { up: 1, exporter: '10.0.0.5:9100', cpu_pct: 95, age_sec: 600, stale: true },
  }, NOW);
  assert.match(html, /class="hr-grid hr-stale"/);
  assert.match(html, /Stale · data 10m old/);
}

// up == 0 without values: says so, draws no bars and no zeros.
{
  const html = renderHostResources({ ...base, status: 'open_scraped', resources: { up: 0, exporter: '10.0.0.5:9100', stale: true } }, NOW);
  assert.match(html, /exporter is down \(up = 0\)/);
  assert.doesNotMatch(html, /hr-bar|0\.0%/);
}

// No exporter data: port status only — no bars, no numbers.
for (const [status, text] of [
  ['open_not_scraped', 'open · not scraped'],
  ['closed', 'closed'],
  ['closed_scraped', 'not reachable from InfraWatch · scraped by Prometheus'],
  ['not_checked_down', 'not checked (host down)'],
  ['windows_exporter', 'windows_exporter'],
  ['no_ip', 'no IP for this card'],
]) {
  const html = renderHostResources({ ...base, status, port: status === 'not_checked_down' || status === 'no_ip' ? null : base.port }, NOW);
  assert.ok(html.includes(text), `${status}: ${html}`);
  if (status !== 'closed_scraped') assert.doesNotMatch(html, /hr-bar|%/, `${status} has no numbers`);
}

// Errors and escaping.
assert.match(renderHostResources({ ok: false, error: '<b>x</b>' }), /&lt;b&gt;x&lt;\/b&gt;/);

// Lazy detail: partitions (fullest first, coloured) and interfaces.
{
  const html = renderHostDetail({
    partitions: [{ mount: '/var', fstype: 'ext4', size_bytes: 50 * 2 ** 30, used_pct: 91.2 }],
    network: [{ device: 'eth0', rx_bps: 2_500_000, tx_bps: 800 }],
  });
  assert.match(html, /<td>\/var<\/td><td>ext4<\/td><td>50 GB<\/td><td class="is-crit">91\.2%<\/td>/);
  assert.match(html, /eth0<\/td><td>↓ 2\.5 Mb\/s<\/td><td>↑ 800 b\/s/);
  assert.match(renderHostDetail({ partitions: [], network: [] }), /No partitions reported/);
}

console.log('host resources renderer: ok');
