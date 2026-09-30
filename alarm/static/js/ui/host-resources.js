/* "Host resources" section of the target drawer: pure renderers for the
 * /api/host-resources payload (see core/monitoring/host_resources.py). No DOM
 * access here, so the node self-check can run them directly. */
import { escapeHtml } from './format.js';

const STATUS = {
  open_scraped: ['is-ok', 'open · scraped'],
  open_not_scraped: ['is-muted', 'open · not scraped — exporter available, Prometheus doesn’t scrape it'],
  closed_scraped: ['is-muted', 'not reachable from InfraWatch · scraped by Prometheus (firewall between them?)'],
  closed: ['is-muted', 'closed'],
  open_other: ['is-muted', 'open, but not a node exporter'],
  windows_exporter: ['is-muted', 'windows_exporter — node metrics don’t apply'],
  not_checked_down: ['is-muted', 'not checked (host down)'],
  not_checked: ['is-muted', 'not checked'],
  no_ip: ['is-muted', 'no IP for this card — map it in data/host_aliases.txt'],
};

// ≥90% red, ≥80% orange.
export function hrLevel(pct) {
  if (typeof pct !== 'number') return '';
  return pct >= 90 ? 'is-crit' : pct >= 80 ? 'is-warn' : 'is-ok';
}

export function fmtAge(sec) {
  if (!(sec >= 0)) return '';
  if (sec < 90) return `${Math.round(sec)}s`;
  if (sec < 5400) return `${Math.round(sec / 60)}m`;
  if (sec < 172800) return `${Math.round(sec / 3600)}h`;
  return `${Math.round(sec / 86400)}d`;
}

export function fmtUptime(sec) {
  if (!(sec >= 0)) return '—';
  const d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60);
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`;
}

const gb = b => (b / 1073741824).toFixed(b >= 10737418240 ? 0 : 1);

function fmtBps(bps) {
  if (!(bps >= 0)) return '—';
  if (bps >= 1e9) return `${(bps / 1e9).toFixed(1)} Gb/s`;
  if (bps >= 1e6) return `${(bps / 1e6).toFixed(1)} Mb/s`;
  if (bps >= 1e3) return `${(bps / 1e3).toFixed(0)} kb/s`;
  return `${bps} b/s`;
}

function bar(label, pct, text) {
  const w = Math.max(0, Math.min(100, pct));
  return `<div class="hr-row"><span class="hr-label">${label}</span>` +
    `<span class="hr-bar ${hrLevel(pct)}"><span class="hr-bar-fill" style="width:${w.toFixed(1)}%"></span></span>` +
    `<span class="hr-val ${hrLevel(pct)}">${text}</span></div>`;
}

export function renderHostResources(data, nowSec = Date.now() / 1000) {
  if (!data || data.ok === false) {
    return `<p class="hr-note">${escapeHtml((data && data.error) || 'Host resources unavailable.')}</p>`;
  }
  const port = data.port;
  const [cls, text] = STATUS[data.status] || ['is-muted', escapeHtml(data.status || '—')];
  const checked = port && port.checked_at ? ` · checked ${fmtAge(nowSec - port.checked_at)} ago` : '';
  const alias = data.alias ? ` <span class="hr-note">(via alias → ${escapeHtml(data.ip)})</span>` : '';
  let html = `<div class="hr-status"><span class="hr-dot ${cls}"></span>` +
    `<span>Port ${port ? port.number : 9100}: ${text}${checked}</span>${alias}` +
    `<button type="button" class="btn btn-sm btn-link hr-recheck" data-hr-recheck>Recheck</button></div>`;
  if (data.prometheus_ok === false) html += '<p class="hr-note">Prometheus could not be read — numbers unavailable.</p>';
  const r = data.resources;
  if (!r) return html;
  const numbers = ['cpu_pct', 'mem_pct', 'disk_pct', 'load_per_core', 'uptime_sec'].some(k => typeof r[k] === 'number');
  if (!numbers) {
    return html + `<p class="hr-note">Scraped by Prometheus${r.up === 0 ? ', but the exporter is down (up = 0)' : ''} — no current values.</p>`;
  }
  const stale = r.stale ? ` hr-stale` : '';
  html += `<div class="hr-grid${stale}">`;
  if (r.stale) {
    html += `<p class="hr-note">Stale${r.up === 0 ? ' — exporter down (up = 0)' : ''}${typeof r.age_sec === 'number' ? ` · data ${fmtAge(r.age_sec)} old` : ''}</p>`;
  }
  if (typeof r.cpu_pct === 'number') html += bar('CPU', r.cpu_pct, `${r.cpu_pct.toFixed(1)}%`);
  if (typeof r.mem_pct === 'number') {
    html += bar('RAM', r.mem_pct, `${gb(r.mem_used_bytes)} / ${gb(r.mem_total_bytes)} GB · ${r.mem_pct.toFixed(1)}%`);
  }
  if (typeof r.disk_pct === 'number') {
    html += bar('Disk', r.disk_pct, `${escapeHtml(r.disk_mount || '?')} · ${r.disk_pct.toFixed(1)}%`);
  }
  const facts = [];
  if (typeof r.load_per_core === 'number') facts.push(`Load/core <b>${r.load_per_core.toFixed(2)}</b>`);
  if (typeof r.uptime_sec === 'number') facts.push(`Uptime <b>${fmtUptime(r.uptime_sec)}</b>`);
  if (r.exporter) facts.push(`Source <b>${escapeHtml(r.exporter)}</b>`);
  html += `<div class="hr-facts">${facts.join(' · ')}</div></div>`;
  html += '<details class="hr-more" data-hr-more><summary>Partitions & network</summary><div class="hr-more-body">Loading…</div></details>';
  return html;
}

export function renderHostDetail(detail) {
  if (!detail) return '<p class="hr-note">No detail available.</p>';
  const parts = (detail.partitions || []).map(p =>
    `<tr><td>${escapeHtml(p.mount)}</td><td>${escapeHtml(p.fstype || '')}</td>` +
    `<td>${gb(p.size_bytes)} GB</td><td class="${hrLevel(p.used_pct)}">${p.used_pct.toFixed(1)}%</td></tr>`).join('');
  const nets = (detail.network || []).map(n =>
    `<tr><td>${escapeHtml(n.device)}</td><td>↓ ${fmtBps(n.rx_bps)}</td><td>↑ ${fmtBps(n.tx_bps)}</td></tr>`).join('');
  return (parts ? `<table class="hr-table"><thead><tr><th>Mount</th><th>FS</th><th>Size</th><th>Used</th></tr></thead><tbody>${parts}</tbody></table>` : '<p class="hr-note">No partitions reported.</p>') +
    (nets ? `<table class="hr-table"><thead><tr><th>Interface</th><th>In</th><th>Out</th></tr></thead><tbody>${nets}</tbody></table>` : '<p class="hr-note">No network interfaces reported.</p>');
}
