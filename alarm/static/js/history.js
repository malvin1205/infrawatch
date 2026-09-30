/* History page — incident timeline + per-incident detail. */
import { epochToWibInput, escapeHtml, formatDuration, formatWib, isoWib, wibInputToEpoch } from './ui/format.js';
import { apiFetch } from './net.js';
import { isAdminLike } from './auth.js';
import { LogsPage } from './logs.js';
import { addJobs, bindJobSelect, currentJob } from './ui/job-filter.js';

// Fixed UTC+7 offset for Asia/Jakarta (WIB) — 25200 seconds.
export const WIB_OFFSET_SEC = 25200;

// Filters survive a reload (they reset to defaults every time).
const PREFS = 'historyPrefs';
function loadPrefs() {
  try { return JSON.parse(localStorage.getItem(PREFS) || '{}') || {}; } catch (_) { return {}; }
}
function savePrefs(p) {
  try { localStorage.setItem(PREFS, JSON.stringify(p)); } catch (_) { /* private mode */ }
}

// A CSV cell a spreadsheet would run as a formula (=, +, -, @, tab, CR)
// gets a leading apostrophe; then it is quoted as usual.
export function csvCell(v) {
  let t = String(v ?? '');
  if (/^[=+\-@\t\r]/.test(t)) t = `'${t}`;
  return `"${t.replace(/"/g, '""')}"`;
}

export const RANGE_LABELS = {
  '24h': 'Last 24 hours', '7d': 'Last 7 days', '30d': 'Last 30 days', mtd: 'Month to date', custom: 'Custom range',
};

export function isOngoing(inc) {
  return (inc.status || 'firing').toLowerCase() !== 'resolved';
}

// Did this incident's activity [first seen, resolved-or-now] touch [from, to]?
// An outage that started before the window and is still open (or resolved
// inside it) belongs to the window; one that ended before it, or began after
// it, does not.
export function overlapsRange(inc, from, to, now) {
  const start = inc.first_seen || inc.time || 0;
  const end = isOngoing(inc) ? now : (inc.resolved_time || inc.time || 0);
  return end >= from && start <= to;
}

// Printable Incident History Report. Every value arrives pre-formatted as
// text and is escaped here; the page prints what the table lists, nothing more.
export function reportHtml({ title, range, generated, filters, summary, rows }) {
  const e = escapeHtml;
  const table = rows.length ? `
<table class="inc">
  <colgroup><col style="width:15%"><col style="width:15%"><col style="width:13%"><col style="width:29%"><col style="width:17%"><col style="width:11%"></colgroup>
  <thead><tr><th>Start Time</th><th>End Time</th><th>Duration</th><th>Host / Target</th><th>Type</th><th>Status</th></tr></thead>
  <tbody>${rows.map(r => `
    <tr>
      <td>${e(r.start)}</td>
      <td>${e(r.end)}</td>
      <td>${e(r.duration)}${r.durationNote ? `<div class="sub">${e(r.durationNote)}</div>` : ''}</td>
      <td>${e(r.host)}${r.job ? `<div class="sub">${e(r.job)}</div>` : ''}</td>
      <td>${e(r.type)}${r.severity ? `<div class="sub">${e(r.severity)}</div>` : ''}</td>
      <td class="${r.ongoing ? 'ongoing' : ''}">${e(r.status)}</td>
    </tr>`).join('')}
  </tbody>
</table>` : `<p class="empty">No incidents ${filters ? 'match the selected range and filters' : 'in the selected range'}.</p>`;

  return `<!doctype html>
<html><head><meta charset="utf-8"><title>${e(title)}</title>
<style>
  @page { size: A4; margin: 14mm 12mm; }
  * { box-sizing: border-box; }
  body { margin: 0; color: #111; font: 9.5pt/1.4 system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif; }
  h1 { font-size: 16pt; margin: 0 0 8px; }
  .meta { display: grid; grid-template-columns: max-content 1fr; gap: 2px 12px; margin: 0 0 14px; }
  .meta dt { color: #555; }
  .meta dd { margin: 0; overflow-wrap: anywhere; }
  .summary { width: 100%; border-collapse: collapse; margin: 0 0 16px; table-layout: fixed; border: 1px solid #ccc; }
  .summary th { text-align: left; font-weight: 500; color: #555; font-size: 8.5pt; padding: 6px 8px 0; }
  .summary td { font-size: 13pt; font-weight: 700; padding: 0 8px 6px; }
  .inc { width: 100%; border-collapse: collapse; table-layout: fixed; }
  .inc th, .inc td { text-align: left; vertical-align: top; padding: 5px 6px; border-bottom: 1px solid #ddd; overflow-wrap: anywhere; }
  .inc th { font-size: 8pt; text-transform: uppercase; letter-spacing: .03em; color: #444; border-bottom: 1.5px solid #333; }
  .inc tr { break-inside: avoid; }
  .sub { color: #666; font-size: 8pt; }
  .ongoing { color: #b91c1c; font-weight: 600; }
  .empty { padding: 24px 0; color: #555; text-align: center; border: 1px dashed #ccc; }
</style></head>
<body>
  <h1>Incident History Report</h1>
  <dl class="meta">
    <dt>Range</dt><dd>${e(range)}</dd>
    <dt>Generated</dt><dd>${e(generated)}</dd>
    ${filters ? `<dt>Filters</dt><dd>${e(filters)}</dd>` : ''}
    <dt>Timezone</dt><dd>All times WIB (UTC+7)</dd>
  </dl>
  <table class="summary">
    <tr>${summary.map(([k]) => `<th>${e(k)}</th>`).join('')}</tr>
    <tr>${summary.map(([, v]) => `<td>${e(v)}</td>`).join('')}</tr>
  </table>
  ${table}
</body></html>`;
}

// Browser print dialog -> "Save as PDF". No PDF library: the browser's own
// layout already wraps long text and repeats the table header on every page.
function printHtml(html, title) {
  const frame = document.createElement('iframe');
  frame.setAttribute('aria-hidden', 'true');
  frame.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;';
  document.body.appendChild(frame);
  const w = frame.contentWindow;
  w.document.open();
  w.document.write(html);
  w.document.close();
  // Some browsers name the saved PDF after the top page, not the frame.
  const prevTitle = document.title;
  document.title = title;
  w.addEventListener('afterprint', () => { document.title = prevTitle; frame.remove(); }, { once: true });
  w.focus();
  w.print();
}

export class HistoryPage {
  constructor(monitor) {
    this.monitor = monitor;
    this.data = [];
    const prefs = loadPrefs();
    this.severityFilter = prefs.severity || 'all';
    this.statusFilter = prefs.status || 'all';
    this.jobFilter = currentJob();
    // 'month' / 'all' were the old presets; 'month' is today's MTD.
    this.dateRange = RANGE_LABELS[prefs.range] ? prefs.range : 'mtd';
    this.customFrom = prefs.customFrom || null;
    this.customTo = prefs.customTo || null;
    this.sortBy = prefs.sort || 'last_seen';
    this.searchQ = '';
    this.clearedBefore = parseFloat(localStorage.getItem('historyClearedBefore') || '0');
    this._loaded = false;
    this._loadAbortController = null;
    this._visibleCount = HistoryPage.PAGE_SIZE;
    this._tickInterval = null;
    this._refreshInterval = null;
    this._hasFiring = false;

    this.tableEl = document.getElementById('historyFullTable');
    this.badge = document.getElementById('historyBadge');
    this.metaEl = document.getElementById('historyMeta');
    this.searchEl = document.getElementById('historySearch');
    this.jobSelectEl = document.getElementById('historyJobFilter');
    this.rangeSelectEl = document.getElementById('historyRangeSelect');
    this.customRangeEl = document.getElementById('historyCustomRange');
    this.customFromEl = document.getElementById('historyFrom');
    this.customToEl = document.getElementById('historyTo');
    this.sortSelectEl = document.getElementById('historySortSelect');
    this.pagerEl = document.getElementById('historyPager');
    this.pagerLabelEl = document.getElementById('historyPagerLabel');

    this.statTotal = document.getElementById('histTotal');
    this.statOngoing = document.getElementById('histOngoing');
    this.statResolved = document.getElementById('histResolved');
    this.statDowntime = document.getElementById('histDowntime');

    this._bindEvents();
  }

  _savePrefs() {
    savePrefs({
      severity: this.severityFilter, status: this.statusFilter, range: this.dateRange, sort: this.sortBy,
      customFrom: this.customFrom, customTo: this.customTo,
    });
  }

  _bindEvents() {
    window.addEventListener('iw:duration-format-changed', () => this._render());

    // Paint the restored filters.
    document.querySelectorAll('[data-hist-filter]').forEach(b =>
      b.classList.toggle('chip-active', b.dataset.histFilter === this.severityFilter));
    document.querySelectorAll('[data-hist-status]').forEach(b =>
      b.classList.toggle('chip-active', b.dataset.histStatus === this.statusFilter));
    if (this.rangeSelectEl) this.rangeSelectEl.value = this.dateRange;
    this._syncCustomInputs();
    if (this.sortSelectEl) this.sortSelectEl.value = this.sortBy;

    // "Hide older" is a browser-only cut-off that survives reloads: the meta
    // line says how many it hides and offers the way back, at any time (the
    // old undo only appeared once EVERY row was hidden).
    this.metaEl.addEventListener('click', e => {
      if (!e.target.closest('[data-show-hidden]')) return;
      this.clearedBefore = 0;
      localStorage.removeItem('historyClearedBefore');
      this._render();
    });

    document.querySelectorAll('[data-hist-filter]').forEach(btn => {
      btn.addEventListener('click', () => {
        this.severityFilter = btn.dataset.histFilter;
        this._savePrefs();
        document.querySelectorAll('[data-hist-filter]').forEach(b =>
          b.classList.toggle('chip-active', b.dataset.histFilter === this.severityFilter)
        );
        this._resetPaging();
        this._render();
      });
    });

    document.querySelectorAll('[data-hist-status]').forEach(btn => {
      btn.addEventListener('click', () => {
        this.statusFilter = btn.dataset.histStatus;
        this._savePrefs();
        document.querySelectorAll('[data-hist-status]').forEach(b =>
          b.classList.toggle('chip-active', b.dataset.histStatus === this.statusFilter)
        );
        this._resetPaging();
        this._render();
      });
    });

    this.searchEl.addEventListener('input', () => {
      this.searchQ = this.searchEl.value.toLowerCase();
      this._resetPaging();
      this._render();
    });

    // Shared with the Live Alert Log tab (ui/job-filter.js).
    bindJobSelect(this.jobSelectEl, job => {
      this.jobFilter = job;
      this._resetPaging();
      this._render();
    });

    // Range scopes the table, the summary cards and both exports alike —
    // all of them read _filteredSorted().
    this.rangeSelectEl.addEventListener('change', () => {
      this.dateRange = this.rangeSelectEl.value;
      if (this.dateRange === 'custom' && !(this.customFrom && this.customTo)) {
        const now = Math.floor(Date.now() / 60000) * 60;
        this.customFrom = now - 86400;
        this.customTo = now;
      }
      this._syncCustomInputs();
      this._savePrefs();
      this._resetPaging();
      this._render();
    });

    [this.customFromEl, this.customToEl].forEach(el => el.addEventListener('change', () => {
      const from = wibInputToEpoch(this.customFromEl.value);
      const to = wibInputToEpoch(this.customToEl.value);
      if (from == null || to == null) return; // half-typed: keep the last complete range
      this.customFrom = from;
      this.customTo = to;
      this._savePrefs();
      this._resetPaging();
      this._render();
    }));

    this.sortSelectEl.addEventListener('change', () => {
      this.sortBy = this.sortSelectEl.value;
      this._savePrefs();
      this._render();
    });

    document.getElementById('exportHistory').addEventListener('click', () => this._exportCSV());
    document.getElementById('exportHistoryReport').addEventListener('click', () => this._exportReport());

    document.getElementById('clearHistory').addEventListener('click', () => {
      this.clearedBefore = Date.now() / 1000;
      localStorage.setItem('historyClearedBefore', this.clearedBefore);
      this._resetPaging();
      this._render();
    });

    document.getElementById('historyLoadMore').addEventListener('click', () => {
      this._visibleCount += HistoryPage.PAGE_SIZE;
      this._render();
    });

    // Delegated + keyboard-reachable (a plain click-only div is invisible to
    // D-pad/remote nav) — opens the existing target detail drawer (task #5)
    // instead of an inline expand: one detail surface per host, not two.
    this.tableEl.addEventListener('click', e => {
      const resolveBtn = e.target.closest('[data-resolve-key]');
      if (resolveBtn) {
        e.stopPropagation();
        this._resolveIncident(resolveBtn.dataset.resolveKey);
        return;
      }
      const row = e.target.closest('[data-row-key]');
      if (row) this._openRowDrawer(row.dataset.rowKey);
    });
    this.tableEl.addEventListener('keydown', e => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      const row = e.target.closest('[data-row-key]');
      if (!row) return;
      e.preventDefault();
      this._openRowDrawer(row.dataset.rowKey);
    });
  }

  _syncCustomInputs() {
    this.customRangeEl.hidden = this.dateRange !== 'custom';
    if (this.customFrom) this.customFromEl.value = epochToWibInput(this.customFrom);
    if (this.customTo) this.customToEl.value = epochToWibInput(this.customTo);
  }

  _resetPaging() {
    this._visibleCount = HistoryPage.PAGE_SIZE;
  }

  onActivate() {
    if (!this._loaded) this._renderLoading();
    this.load();
    this._startTicking();
    // It loaded once per tab switch: an incident that fired or resolved while
    // the tab stayed open never showed. Re-read it while it's on screen.
    if (this._refreshInterval) clearInterval(this._refreshInterval);
    this._refreshInterval = setInterval(() => { if (!document.hidden) this.load(); }, HistoryPage.REFRESH_MS);
  }

  onDeactivate() {
    this._stopTicking();
    if (this._refreshInterval) { clearInterval(this._refreshInterval); this._refreshInterval = null; }
  }

  // Only ticks (re-renders once a second) while a still-open incident is
  // visible, so a live "down Xm Ys" age keeps counting — the same idea as
  // LogsPage._startPolling, reused here because History can legitimately
  // show a not-yet-resolved incident (TargetDown fired, hasn't cleared).
  _startTicking() {
    this._stopTicking();
    this._tickInterval = setInterval(() => {
      if (this._hasFiring) this._render();
    }, 1000);
  }

  _stopTicking() {
    if (this._tickInterval) { clearInterval(this._tickInterval); this._tickInterval = null; }
  }

  async load() {
    if (this._loadAbortController) this._loadAbortController.abort();
    const controller = new AbortController();
    this._loadAbortController = controller;

    try {
      const res = await fetch('/history', { signal: controller.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      this.data = data;
      this._loaded = true;
      addJobs(this.data.map(r => r.job));
      this._render();
    } catch (e) {
      if (e.name === 'AbortError') return;
      console.error('[History] load failed:', e);
      if (!this._loaded) this._renderError(e.message);
    } finally {
      if (this._loadAbortController === controller) this._loadAbortController = null;
    }
  }

  _renderLoading() {
    this.tableEl.innerHTML = `
      <div class="empty-state">
        <div class="es-text">Loading incident history…</div>
      </div>`;
    // Stat cards + filtered-count line must not show "0" while real data is
    // still in flight — that reads as "no incidents" instead of "loading".
    this.metaEl.textContent = 'Loading…';
    this.badge.textContent = '—';
    [this.statTotal, this.statOngoing, this.statResolved, this.statDowntime].forEach(el => { el.textContent = '—'; });
  }

  _renderError(msg) {
    this.tableEl.innerHTML = `
      <div class="empty-state">
        <div class="es-text" style="color:var(--critical, #EF4444);">Failed to load incident history — ${this._esc(msg || 'network error')}</div>
      </div>`;
  }

  // [from, to] epoch seconds of the selected range. Presets run up to now;
  // MTD starts 00:00 WIB on the 1st of the current WIB month.
  _rangeBounds() {
    const now = Date.now() / 1000;
    if (this.dateRange === '24h') return { from: now - 86400, to: now };
    if (this.dateRange === '7d') return { from: now - 7 * 86400, to: now };
    if (this.dateRange === '30d') return { from: now - 30 * 86400, to: now };
    if (this.dateRange === 'custom') {
      const a = this.customFrom ?? now - 86400;
      const b = this.customTo ?? now;
      return { from: Math.min(a, b), to: Math.max(a, b) };
    }
    const wibNow = new Date(Date.now() + WIB_OFFSET_SEC * 1000);
    const monthStartWib = Date.UTC(wibNow.getUTCFullYear(), wibNow.getUTCMonth(), 1);
    return { from: (monthStartWib - WIB_OFFSET_SEC * 1000) / 1000, to: now };
  }

  // Incidents still in view after "Clear" — a real, undoable cut-off.
  _visibleData() {
    return this.clearedBefore ? this.data.filter(r => (r.time || 0) > this.clearedBefore) : this.data;
  }

  // Cleared + date range. An Ongoing incident's activity runs up to now, so
  // an outage down for 2 months still shows in "24H" (see overlapsRange).
  _rangedData() {
    const { from, to } = this._rangeBounds();
    const now = Date.now() / 1000;
    return this._visibleData().filter(r => overlapsRange(r, from, to, now));
  }

  // One summary for the cards and the PDF, always over the rows listed.
  _summary(rows) {
    const ongoing = rows.filter(r => this._isOngoing(r)).length;
    return {
      total: rows.length,
      ongoing,
      resolved: rows.length - ongoing,
      downSeconds: rows.reduce((sum, r) => sum + this._downSeconds(r), 0),
    };
  }

  _updateStats(rows) {
    const s = this._summary(rows);
    this.statTotal.textContent = s.total;
    this.statOngoing.textContent = s.ongoing;
    this.statResolved.textContent = s.resolved;
    this.statDowntime.textContent = this._fmtDur(s.downSeconds);
  }

  // Last activity: now for a still-open incident, its resolve time otherwise.
  _lastSeen(inc) {
    return this._isOngoing(inc) ? Date.now() / 1000 : (inc.resolved_time || inc.time || 0);
  }

  _isOngoing(inc) {
    return isOngoing(inc);
  }

  // "Total Down" is a cumulative figure across every occurrence of this
  // incident (task #3: "durasi agregat"), not just the current/latest one —
  // total_down_seconds is the sum banked server-side on each past resolve;
  // an Ongoing incident adds its still-running current session on top.
  _downSeconds(inc) {
    const banked = typeof inc.total_down_seconds === 'number' ? inc.total_down_seconds : (inc.duration_seconds || 0);
    if (this._isOngoing(inc)) return banked + Math.max(0, Date.now() / 1000 - (inc.time || 0));
    return banked;
  }

  _filteredSorted() {
    let rows = this._rangedData();
    if (this.severityFilter !== 'all') {
      rows = rows.filter(r => (r.severity || '').toLowerCase() === this.severityFilter);
    }
    if (this.statusFilter !== 'all') {
      const wantOngoing = this.statusFilter === 'ongoing';
      rows = rows.filter(r => this._isOngoing(r) === wantOngoing);
    }
    if (this.jobFilter !== 'all') {
      rows = rows.filter(r => (r.job || '') === this.jobFilter);
    }
    if (this.searchQ) {
      rows = rows.filter(r =>
        (r.name || '').toLowerCase().includes(this.searchQ) ||
        (r.instance || '').toLowerCase().includes(this.searchQ) ||
        (r.summary || '').toLowerCase().includes(this.searchQ)
      );
    }

    const sorted = rows.slice();
    if (this.sortBy === 'total_down') {
      sorted.sort((a, b) => this._downSeconds(b) - this._downSeconds(a));
    } else if (this.sortBy === 'occurrences') {
      sorted.sort((a, b) => (b.occurrences || 1) - (a.occurrences || 1));
    } else {
      sorted.sort((a, b) => this._lastSeen(b) - this._lastSeen(a));
    }
    return sorted;
  }

  _render() {
    const rows = this._filteredSorted();
    this._updateStats(rows);
    // Reacts to every active filter (severity/status/job/search/range) —
    // the fixed grand total lives on the "Total Incidents" stat card instead
    // (task: stop showing the same number twice).
    let meta = this._esc(`${rows.length} incident${rows.length !== 1 ? 's' : ''} (filtered)`);
    if (this.clearedBefore) {
      const hidden = this.data.length - this._visibleData().length;
      meta += ` · <span class="al-meta-hidden">${hidden} hidden before ${this._esc(this._fmt(this.clearedBefore))}</span>` +
        ' <button type="button" class="btn-link al-meta-show" data-show-hidden>Show</button>';
    }
    this.metaEl.innerHTML = meta;
    this.badge.textContent = rows.length;
    this._hasFiring = rows.some(r => this._isOngoing(r));

    if (rows.length === 0) {
      // Distinguish "cleared" (a real, undoable state) from "no match"
      // (adjust your filter/search) — same empty table otherwise reads as broken.
      const clearedAll = this.clearedBefore > 0 && this.data.length > 0 &&
        this.data.every(r => (r.time || 0) <= this.clearedBefore);
      this.tableEl.innerHTML = clearedAll ? `
        <div class="empty-state">
          <div class="es-icon" aria-hidden="true">
            <svg width="28" height="28" viewBox="0 0 28 28" fill="none">
              <path d="M6 22V8a2 2 0 012-2h12a2 2 0 012 2v14" stroke="currentColor" stroke-width="1.5"/>
              <path d="M3 22h22M10 11h8M10 15h5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
            </svg>
          </div>
          <div class="es-text">History cleared — new incidents will appear here</div>
          <button class="btn btn-secondary btn-sm" id="undoHistoryClear" type="button">Show cleared incidents</button>
        </div>` : `
        <div class="empty-state">
          <div class="es-icon" aria-hidden="true">
            <svg width="28" height="28" viewBox="0 0 28 28" fill="none">
              <path d="M6 22V8a2 2 0 012-2h12a2 2 0 012 2v14" stroke="currentColor" stroke-width="1.5"/>
              <path d="M3 22h22M10 11h8M10 15h5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
            </svg>
          </div>
          <div class="es-text">No incidents match your filter</div>
        </div>`;
      if (clearedAll) {
        document.getElementById('undoHistoryClear').addEventListener('click', () => {
          this.clearedBefore = 0;
          localStorage.removeItem('historyClearedBefore');
          this._render();
        });
      }
      this.pagerEl.hidden = true;
      return;
    }

    // Pagination: only `_visibleCount` rows ever hit the DOM (task #11 — a
    // fleet with 100s of incidents shouldn't render them all at once). A
    // "Show more" bump is the lazy version of a virtual-scroll list; add
    // one if this table routinely needs to show thousands at a time.
    const page = rows.slice(0, this._visibleCount);

    const focused = document.activeElement;
    const focusedKey = (focused && this.tableEl.contains(focused)) ? focused.dataset.rowKey : null;

    this.tableEl.innerHTML = page.map(inc => `<div class="history-entry">${this._renderRow(inc)}</div>`).join('');

    if (focusedKey) {
      const el = this.tableEl.querySelector(`[data-row-key="${CSS.escape(focusedKey)}"]`);
      if (el) el.focus();
    }

    if (rows.length > page.length) {
      this.pagerEl.hidden = false;
      this.pagerLabelEl.textContent = `Showing ${page.length} of ${rows.length}`;
    } else {
      this.pagerEl.hidden = true;
    }
  }

  _renderRow(inc) {
    const rawSev = (inc.severity || 'critical').toLowerCase();
    // Clamp to the known set — the value is stored from the Alertmanager
    // webhook and flows straight into a class name and text below.
    // Known severities get their colour; anything else shows as itself (it
    // used to be relabelled CRITICAL).
    const known = ['critical', 'warning', 'info'].includes(rawSev);
    const sev = known ? rawSev : 'info';
    const sevLabel = known ? sev.toUpperCase() : rawSev.toUpperCase().slice(0, 16);
    const ongoing = this._isOngoing(inc);
    const rowKey = inc.key || `${inc.instance}|${inc.name}|${inc.time}`;
    // Same alertname → plain-English mapping the live feed uses, so one
    // incident does not read as "SlowResponse" here and "Slow response"
    // there (audit 2.8).
    const jobSub = [inc.job, LogsPage.friendlyAlertName(inc.name)].filter(Boolean).join(' · ');
    // Root cause sub-text (task #4) — lastError when this incident recorded
    // one (poller-sourced TargetDown outages do), else the summary text
    // already carries a classification like "unreachable (HTTP 503)".
    const errDetail = inc.last_error || inc.summary || '';
    // Cumulative across every occurrence (_downSeconds), not just the
    // current/latest one — see its comment for why duration_seconds alone
    // isn't "Total Down" once an incident has flapped more than once.
    const downtime = ongoing
      ? `${this.monitor.instancesPage._fmtDownAging(this._downSeconds(inc) * 1000)} (open)`
      : this._fmtDur(this._downSeconds(inc));
    // Who (and when) acknowledged this incident — persisted on the row so
    // it still shows after the live ack record is cleared on resolve.
    const ackLine = inc.acknowledged_by
      ? `<div class="history-ack">✓ Acked by ${this._esc(inc.acknowledged_by)} · ${this._fmt(inc.acknowledged_at)}</div>`
      : '';

    // Force-resolve control (audit F1) — only for an admin, only on a still
    // -Ongoing incident. Backstop for a stuck incident that no automatic path
    // can clear (host removed from Prometheus, so the poller never sees it
    // recover). Lives inside the Host cell so it needs no grid-column change.
    const canResolve = ongoing && isAdminLike(window.currentUser) && inc.key;
    const resolveLine = canResolve
      ? `<button type="button" class="history-resolve-btn" data-resolve-key="${this._esc(inc.key)}" title="Force-resolve this stuck incident">Force-resolve</button>`
      : '';

    // Severity color is a property of the alert (critical=red, warning=amber),
    // independent of open/resolved — that distinction lives on the Status
    // column and the row background (.history-row-active) instead.
    const sevClass = `history-sev-${sev}`;
    const statusClass = ongoing ? 'history-status-ongoing' : 'history-status-resolved';
    const statusLabel = ongoing ? 'Ongoing' : 'Resolved';

    return `<div class="history-row-full${ongoing ? ' history-row-active' : ''}" data-row-key="${this._esc(rowKey)}" tabindex="0" role="button" aria-label="Open details for ${this._esc(inc.instance || 'incident')}">
      <div class="history-chip">
        <div>
          <div class="history-host">${this._esc(inc.instance || '—')}</div>
          <div class="history-sub">${this._esc(jobSub || '—')}${errDetail ? ` — ${this._esc(errDetail)}` : ''}</div>
          ${ackLine}
          ${resolveLine}
        </div>
      </div>
      <span class="history-status ${statusClass}"><span class="history-status-dot"></span>${statusLabel}</span>
      <span class="history-sev ${sevClass}">${this._esc(sevLabel)}</span>
      <span class="history-occurrences">×${inc.occurrences || 1}</span>
      <span class="history-firstseen">${this._fmt(inc.first_seen || inc.time)}</span>
      <span class="history-downtime">${downtime}</span>
      <span class="history-lastseen">${ongoing ? 'now' : this._fmt(inc.resolved_time || inc.time)}</span>
    </div>`;
  }

  // Row click -> the same target detail drawer InstancesPage already uses
  // (task #5), instead of a second, competing detail UI. Prefers the live
  // target object (has current health/labels/etc.); falls back to a minimal
  // one built from the incident row itself for a host that's since been
  // removed from monitoring.
  _openRowDrawer(rowKey) {
    const inc = this.data.find(r => (r.key || `${r.instance}|${r.name}|${r.time}`) === rowKey);
    if (!inc) return;
    const live = (this.monitor.instancesPage.data || []).find(t => t.instance === inc.instance);
    const target = live || {
      instance: inc.instance,
      job: inc.job || '',
      health: this._isOngoing(inc) ? 'down' : 'up',
      responseTimeMs: 0,
      httpStatusCode: inc.http_status_code,
      lastError: inc.last_error || inc.summary || '',
      labels: {},
      isWeb: false,
      downSince: this._isOngoing(inc) ? inc.time : null,
      active_alerts: []
    };
    this.monitor.instancesPage._openDrawer(target);
  }

  // Force-resolve a stuck incident via POST /api/alerts/resolve (audit F1).
  async _resolveIncident(key) {
    if (!key) return;
    const toast = (m) => this.monitor?.instancesPage?._triggerEventToast?.(m);
    const ok = await window.showConfirmDialog({
      title: 'Force-Resolve Incident',
      message: `Mark "${key}" as resolved? Use this only for a stuck incident that no longer reflects reality — e.g. a host removed from Prometheus, whose recovery the poller can never observe.`,
      confirmText: 'Force-resolve',
      cancelText: 'Cancel',
      isDanger: true
    });
    if (!ok) return;
    try {
      const res = await apiFetch('/api/alerts/resolve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key })
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.ok) {
        toast(data.changed ? 'Incident force-resolved.' : 'Incident was not firing — no change.');
        this.load();
        this.monitor?.instancesPage?.load?.();
      } else if (res.status === 403) {
        toast('Permission denied: admin required to resolve incidents.');
      } else {
        toast(data.error || 'Failed to resolve incident.');
      }
    } catch (ex) {
      console.warn('[InfraWatch] resolve incident failed:', ex);
      toast('Failed to resolve incident — see console.');
    }
  }

  _fmt(ts) {
    return formatWib(ts);
  }

  _fmtDur(s) {
    if (typeof s !== 'number' || isNaN(s)) return '—';
    return formatDuration(s * 1000, { compact: true });
  }

  // Exports what the table shows (every active filter, all pages), with
  // full ISO WIB timestamps.
  _exportCSV() {
    const header = 'FirstSeen,LastSeen,Alert,Instance,Job,Severity,Status,Occurrences,LastOccurrenceDurationSeconds,TotalDownSeconds,LastError\n';
    const rows = this._filteredSorted().map(r =>
      [
        isoWib(r.first_seen || r.time), this._isOngoing(r) ? 'ongoing' : isoWib(r.resolved_time || r.time),
        r.name, r.instance, r.job, r.severity,
        r.status || 'firing',
        r.occurrences || 1,
        typeof r.duration_seconds === 'number' ? Math.round(r.duration_seconds) : '',
        Math.round(this._downSeconds(r)),
        r.last_error || r.summary
      ].map(csvCell).join(',')
    ).join('\n');
    const blob = new Blob([header + rows], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `infrawatch-history-${Date.now()}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  // Active non-range filters, spelled out on the report so its numbers read
  // against what the operator had selected.
  _filterText() {
    const f = [];
    if (this.severityFilter !== 'all') f.push(`Severity: ${this.severityFilter}`);
    if (this.statusFilter !== 'all') f.push(`Status: ${this.statusFilter}`);
    if (this.jobFilter !== 'all') f.push(`Job: ${this.jobFilter}`);
    if (this.searchQ) f.push(`Search: "${this.searchQ}"`);
    if (this.clearedBefore) f.push(`Hidden before ${isoWib(this.clearedBefore)}`);
    return f.join(' · ');
  }

  // Same rows as the table and the CSV (_filteredSorted), laid out as a report.
  _exportReport() {
    const rows = this._filteredSorted();
    const { from, to } = this._rangeBounds();
    const s = this._summary(rows);
    const now = Date.now() / 1000;
    const bare = ts => isoWib(ts).replace(' WIB', '');
    const title = `Incident History Report ${isoWib(now).slice(0, 10)}`;
    printHtml(reportHtml({
      title,
      range: `${RANGE_LABELS[this.dateRange]}: ${isoWib(from)} – ${isoWib(to)}`,
      generated: isoWib(now),
      filters: this._filterText(),
      summary: [
        ['Total incidents', s.total], ['Ongoing', s.ongoing],
        ['Resolved', s.resolved], ['Total downtime', this._fmtDur(s.downSeconds)],
      ],
      rows: rows.map(r => {
        const ongoing = this._isOngoing(r);
        const n = r.occurrences || 1;
        return {
          start: bare(r.first_seen || r.time),
          end: ongoing ? 'Ongoing' : bare(r.resolved_time || r.time),
          duration: this._fmtDur(this._downSeconds(r)),
          durationNote: n > 1 ? `across ${n} occurrences` : '',
          host: r.instance || '—',
          job: r.job || '',
          type: LogsPage.friendlyAlertName(r.name) || '—',
          severity: r.severity || '',
          status: ongoing ? 'Ongoing' : 'Resolved',
          ongoing,
        };
      }),
    }), title);
  }

  _esc(s) { return escapeHtml(s); }
}

HistoryPage.PAGE_SIZE = 40;
HistoryPage.REFRESH_MS = 30000;
