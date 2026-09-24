/* Alert Logs / Incident History list page. */
import { escapeHtml, formatDuration } from './ui/format.js';

export class LogsPage {
  // One place the feed's cap is defined, so the fetch and the "newest N only"
  // note can never drift apart (audit 1.10).
  static LOG_FETCH_LIMIT = 100;

  // Prometheus alertname → operator English. The rule names are Prometheus's
  // identifiers, not labels meant for a NOC screen (audit 2.8). Unknown names
  // fall back to de-CamelCasing so a new rule reads sensibly without a code
  // change, and the original is kept in the row's tooltip for cross-reference.
  static ALERT_NAMES = {
    TargetDown: 'Host unreachable',
    SlowResponse: 'Slow response',
    InstanceDown: 'Host unreachable',
    ProbeFailed: 'Check failed',
  };

  static friendlyAlertName(name) {
    if (!name) return '';
    if (LogsPage.ALERT_NAMES[name]) return LogsPage.ALERT_NAMES[name];
    const spaced = String(name).replace(/([a-z0-9])([A-Z])/g, '$1 $2');
    return spaced.charAt(0).toUpperCase() + spaced.slice(1).toLowerCase();
  }

  constructor(monitor) {
    this.monitor = monitor;
    this.data = [];
    this.filter = 'all';
    this.searchQ = '';
    this.isLive = true;
    this.interval = null;
    this.seenCount = 0;  // for NEW badge
    this.clearedBefore = parseFloat(localStorage.getItem('logsClearedBefore') || '0');
    this._loaded = false;
    this._loadAbortController = null;

    this.stream = document.getElementById('logStream');
    this.metaEl = document.getElementById('logStreamMeta');
    this.searchEl = document.getElementById('logSearch');
    this.navBadge = document.getElementById('logsBadge');

    this._bindEvents();
  }

  _bindEvents() {
    window.addEventListener('iw:duration-format-changed', () => this._render());

    document.querySelectorAll('[data-log-filter]').forEach(btn => {
      btn.addEventListener('click', () => {
        this.filter = btn.dataset.logFilter;
        document.querySelectorAll('[data-log-filter]').forEach(b =>
          b.classList.toggle('chip-active', b.dataset.logFilter === this.filter)
        );
        this._render();
      });
    });

    this.searchEl.addEventListener('input', () => {
      this.searchQ = this.searchEl.value.toLowerCase();
      this._render();
    });

    document.getElementById('logLiveToggle').addEventListener('change', e => {
      this.isLive = e.target.checked;
      if (this.isLive) this.load();
    });

    document.getElementById('clearLogs').addEventListener('click', () => {
      this.clearedBefore = Date.now() / 1000;
      localStorage.setItem('logsClearedBefore', this.clearedBefore);
      this._render();
    });
  }

  onActivate() {
    this.isActive = true;
    this.navBadge.classList.add('hidden');
    if (!this._loaded) this._renderLoading();
    this.load();
    this._startPolling(5000);
  }

  onDeactivate() {
    this.isActive = false;
    this._startPolling(30000);
  }

  _startPolling(intervalMs = 5000) {
    this._stopPolling();
    this.interval = setInterval(() => {
      if (this.isLive) this.load();
    }, intervalMs);
  }

  _stopPolling() {
    if (this.interval) { clearInterval(this.interval); this.interval = null; }
  }

  async load() {
    if (this._loadAbortController) this._loadAbortController.abort();
    const controller = new AbortController();
    this._loadAbortController = controller;

    try {
      const res = await fetch(`/logs?limit=${LogsPage.LOG_FETCH_LIMIT}`, { signal: controller.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const logs = await res.json();

      const prevCount = this.data.length;
      this.data = logs;
      this._loaded = true;

      // Show NEW badge only when the operator isn't already looking at this feed
      if (!this.isActive && prevCount > 0 && logs.length > prevCount) {
        const diff = logs.length - prevCount;
        this.navBadge.textContent = `+${diff}`;
        this.navBadge.classList.remove('hidden');
        const mobileBadge = document.getElementById('mobileLogsBadge');
        if (mobileBadge) {
          mobileBadge.textContent = `+${diff}`;
          mobileBadge.hidden = false;
        }
        // Hide after 4s
        setTimeout(() => {
          this.navBadge.classList.add('hidden');
          if (mobileBadge) mobileBadge.hidden = true;
        }, 4000);
      }

      this._render();
    } catch (e) {
      if (e.name === 'AbortError') return;
      console.error('[Logs] load failed:', e);
      if (!this._loaded) this._renderError(e.message);
    } finally {
      if (this._loadAbortController === controller) this._loadAbortController = null;
    }
  }

  _renderLoading() {
    this.stream.innerHTML = `
      <div class="empty-state">
        <div class="es-text">Loading alert logs…</div>
      </div>`;
  }

  _renderError(msg) {
    this.stream.innerHTML = `
      <div class="empty-state">
        <div class="es-text" style="color:var(--critical, #EF4444);">Failed to load alert logs — ${this._esc(msg || 'network error')}</div>
      </div>`;
  }

  _render() {
    let rows = this.data;

    if (this.clearedBefore) {
      rows = rows.filter(r => (r.time || 0) > this.clearedBefore);
    }
    if (this.filter !== 'all') {
      rows = rows.filter(r => r.event === this.filter);
    }
    if (this.searchQ) {
      rows = rows.filter(r =>
        (r.name || '').toLowerCase().includes(this.searchQ) ||
        (r.instance || '').toLowerCase().includes(this.searchQ) ||
        (r.summary || '').toLowerCase().includes(this.searchQ)
      );
    }

    // The feed is capped at LOG_FETCH_LIMIT server-side. A bare "100 events"
    // gave no way to tell a full list from a truncated one (audit 1.10), so
    // say when the cap is what's being seen.
    if (this.metaEl) {
      const atCap = this.data.length >= LogsPage.LOG_FETCH_LIMIT;
      const filtered = rows.length !== this.data.length;
      let metaTxt = `${rows.length} event${rows.length !== 1 ? 's' : ''}`;
      if (filtered) metaTxt += ` of ${this.data.length}`;
      if (atCap) metaTxt += ` · newest ${LogsPage.LOG_FETCH_LIMIT} only`;
      this.metaEl.textContent = metaTxt;
      this.metaEl.title = atCap
        ? `Showing the newest ${LogsPage.LOG_FETCH_LIMIT} alert events. Older events are in Incident History.`
        : '';
    }

    if (rows.length === 0) {
      this.stream.innerHTML = `
        <div class="empty-state">
          <div class="es-icon" aria-hidden="true">
            <svg width="32" height="32" viewBox="0 0 32 32" fill="none">
              <path d="M4 26V8a2 2 0 012-2h20a2 2 0 012 2v18" stroke="currentColor" stroke-width="1.5"/>
              <path d="M2 26h28M10 13h12M10 18h8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
            </svg>
          </div>
          <div class="es-text">${this.data.length > 0
          ? 'No alert events match the current filter'
          : 'No log entries yet — waiting for webhooks…'}</div>
        </div>`;
      return;
    }

    // ponytail: one row per event, no flap-grouping — a rolling-window
    // group view (mirroring Incident History's) is real added value here
    // too, but out of scope for this pass; add it if the raw feed gets too
    // noisy for a flapping host.
    this.stream.innerHTML = rows.map(r => {
      const ev = r.event || 'unknown';
      const firing = ev === 'firing';
      const jobSub = [r.job, LogsPage.friendlyAlertName(r.name)].filter(Boolean).join(' · ');
      const meta = ev === 'resolved'
        ? (typeof r.duration_seconds === 'number' ? this._fmtDur(r.duration_seconds) : '—')
        : (typeof r.latency_ms === 'number' ? `${r.latency_ms}ms` : '—');
      // Ack is live-joined server-side onto still-firing rows only (see
      // app.py: _annotate_logs_with_acknowledgment) — a resolved row here
      // never carries it, that detail lives in Incident History instead.
      const ackLine = r.acknowledged_by
        ? `<span class="al-sub">✓ Acked by ${this._esc(r.acknowledged_by)} · ${this._fmt(r.acknowledged_at)}</span>`
        : '';
      return `<div class="al-entry">
        <div class="al-row ${firing ? 'al-row-firing' : 'al-row-resolved'}">
          <span class="al-dot ${firing ? 'al-dot-firing' : 'al-dot-resolved'}"></span>
          <div class="al-chip">
            <span class="al-host">${this._esc(r.instance || '—')}</span>
            <span class="al-sub">${this._esc(jobSub || '—')}</span>
            ${ackLine}
          </div>
          <span class="al-badge ${firing ? 'al-badge-firing' : 'al-badge-resolved'}">${ev.toUpperCase()}</span>
          <span class="al-fill" title="${this._esc(r.summary || '')}">${this._esc(r.summary || '—')}</span>
          <span class="al-duration">${this._esc(meta)}</span>
          <span class="al-time">${this._fmt(r.time)}</span>
        </div>
      </div>`;
    }).join('');
  }

  _fmt(ts) {
    if (!ts) return '—';
    const d = new Date(ts * 1000);
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
  }

  _fmtDur(s) {
    if (typeof s !== 'number' || isNaN(s)) return '—';
    return formatDuration(s * 1000, { compact: true });
  }

  _esc(s) { return escapeHtml(s); }
}
