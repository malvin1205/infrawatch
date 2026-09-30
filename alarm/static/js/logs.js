/* Alert Logs / Incident History list page. */
import { escapeHtml, formatDuration, formatWib } from './ui/format.js';
import { addJobs, bindJobSelect, currentJob } from './ui/job-filter.js';

const store = {
  get(k, d) { try { return localStorage.getItem(k) ?? d; } catch (_) { return d; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch (_) { /* private mode */ } },
  del(k) { try { localStorage.removeItem(k); } catch (_) { /* private mode */ } },
};

export class LogsPage {
  // Page size of the feed; "Load older events" adds another page, up to what
  // the server keeps (event_logs retention).
  static LOG_FETCH_LIMIT = 100;
  static LOG_MAX_LIMIT = 5000;
  // A host that fired this many times in the loaded events is flagged as
  // flapping, so its rows read as one noisy host, not many incidents.
  static FLAP_MIN_FIRES = 4;

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

  // Which firing rows are still open: per alert+host, only the newest event
  // counts, and only if it is a 'firing' one. Rows arrive newest first.
  static openFiringRows(rows) {
    const seen = new Set();
    const open = new Set();
    for (const r of rows) {
      const k = r.key || `${r.name}|${r.instance}`;
      if (seen.has(k)) continue;
      seen.add(k);
      if (r.event === 'firing') open.add(r);
    }
    return open;
  }

  static flapCounts(rows) {
    const n = new Map();
    for (const r of rows) {
      if (r.event !== 'firing') continue;
      const k = r.key || `${r.name}|${r.instance}`;
      n.set(k, (n.get(k) || 0) + 1);
    }
    return n;
  }

  constructor(monitor) {
    this.monitor = monitor;
    this.data = [];
    this.filter = store.get('logsEventFilter', 'all');
    this.searchQ = '';
    this.isLive = true;
    this.interval = null;
    this.limit = LogsPage.LOG_FETCH_LIMIT;
    this.newestSeen = 0;  // newest event time the operator has seen (NEW badge)
    this.clearedBefore = parseFloat(store.get('logsClearedBefore', '0'));
    this._loaded = false;
    this._loadAbortController = null;

    this.stream = document.getElementById('logStream');
    this.metaEl = document.getElementById('logStreamMeta');
    this.searchEl = document.getElementById('logSearch');
    this.navBadge = document.getElementById('logsBadge');
    this.pagerEl = document.getElementById('logPager');

    this._bindEvents();
  }

  _bindEvents() {
    window.addEventListener('iw:duration-format-changed', () => this._render());

    const chips = document.querySelectorAll('[data-log-filter]');
    const paintChips = () => chips.forEach(b => b.classList.toggle('chip-active', b.dataset.logFilter === this.filter));
    paintChips();
    chips.forEach(btn => {
      btn.addEventListener('click', () => {
        this.filter = btn.dataset.logFilter;
        store.set('logsEventFilter', this.filter);
        paintChips();
        this._render();
      });
    });

    // Shared with Incident History (ui/job-filter.js). Filtered server-side,
    // so a job's newest events show, not whatever of it made the fleet-wide
    // newest page.
    bindJobSelect(document.getElementById('logsJobFilter'), () => {
      this.data = [];
      this.limit = LogsPage.LOG_FETCH_LIMIT;
      this._renderLoading();
      this.load();
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
      store.set('logsClearedBefore', this.clearedBefore);
      this._render();
    });

    // "Hide older" is a browser-only cut-off that survives reloads: the meta
    // line always says so and offers the way back.
    if (this.metaEl) {
      this.metaEl.addEventListener('click', e => {
        if (!e.target.closest('[data-show-hidden]')) return;
        this.clearedBefore = 0;
        store.del('logsClearedBefore');
        this._render();
      });
    }

    const more = document.getElementById('logLoadMore');
    if (more) {
      more.addEventListener('click', () => {
        this.limit = Math.min(LogsPage.LOG_MAX_LIMIT, this.limit + LogsPage.LOG_FETCH_LIMIT);
        this.load();
      });
    }
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
      // A background browser tab reads nothing: don't poll for it.
      if (this.isLive && !document.hidden) this.load();
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
      const job = currentJob();
      const jobQ = job === 'all' ? '' : `&job=${encodeURIComponent(job)}`;
      const res = await fetch(`/logs?limit=${this.limit}${jobQ}`, { signal: controller.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const logs = await res.json();
      addJobs(logs.map(r => r.job));

      this.data = logs;
      this._loaded = true;

      // NEW badge: events newer than the newest one already seen. Comparing
      // row counts went dead once the feed was full (it never grows past the
      // page size).
      const newest = logs.reduce((m, r) => Math.max(m, r.time || 0), 0);
      if (this.isActive || !this.newestSeen) {
        this.newestSeen = Math.max(this.newestSeen, newest);
      } else {
        const diff = logs.filter(r => (r.time || 0) > this.newestSeen).length;
        if (diff > 0) {
          this.newestSeen = newest;
          this.navBadge.textContent = `+${diff}`;
          this.navBadge.classList.remove('hidden');
          const mobileBadge = document.getElementById('mobileLogsBadge');
          if (mobileBadge) {
            mobileBadge.textContent = `+${diff}`;
            mobileBadge.hidden = false;
          }
          setTimeout(() => {
            this.navBadge.classList.add('hidden');
            if (mobileBadge) mobileBadge.hidden = true;
          }, 4000);
        }
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
    const all = this.data;
    const open = LogsPage.openFiringRows(all);
    const flaps = LogsPage.flapCounts(all);
    let rows = all;
    let hidden = 0;

    if (this.clearedBefore) {
      rows = rows.filter(r => (r.time || 0) > this.clearedBefore);
      hidden = all.length - rows.length;
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

    const atCap = all.length >= this.limit;
    if (this.metaEl) {
      let meta = `${rows.length} event${rows.length !== 1 ? 's' : ''}`;
      if (rows.length !== all.length) meta += ` of ${all.length} loaded`;
      if (atCap) meta += ` · newest ${this.limit}`;
      let html = this._esc(meta);
      if (this.clearedBefore) {
        html += ` · <span class="al-meta-hidden">${hidden} hidden before ${this._esc(formatWib(this.clearedBefore))}</span>` +
          ' <button type="button" class="btn-link al-meta-show" data-show-hidden>Show</button>';
      }
      this.metaEl.innerHTML = html;
    }
    if (this.pagerEl) this.pagerEl.hidden = !(atCap && this.limit < LogsPage.LOG_MAX_LIMIT);

    if (rows.length === 0) {
      const why = all.length === 0
        ? 'No log entries yet — waiting for alerts…'
        : (this.clearedBefore && hidden === all.length
          ? 'All loaded events are hidden by "Hide older" — use Show above'
          : 'No alert events match the current filter');
      this.stream.innerHTML = `
        <div class="empty-state">
          <div class="es-icon" aria-hidden="true">
            <svg width="32" height="32" viewBox="0 0 32 32" fill="none">
              <path d="M4 26V8a2 2 0 012-2h20a2 2 0 012 2v18" stroke="currentColor" stroke-width="1.5"/>
              <path d="M2 26h28M10 13h12M10 18h8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
            </svg>
          </div>
          <div class="es-text">${why}</div>
        </div>`;
      return;
    }

    this.stream.innerHTML = rows.map(r => {
      const ev = r.event || 'unknown';
      const firing = ev === 'firing';
      const openNow = firing && open.has(r);
      const jobSub = [r.job, LogsPage.friendlyAlertName(r.name)].filter(Boolean).join(' · ');
      // One column, two quantities: label them.
      const meta = ev === 'resolved'
        ? (typeof r.duration_seconds === 'number' ? `down ${this._fmtDur(r.duration_seconds)}` : '—')
        : (typeof r.latency_ms === 'number' ? `rt ${r.latency_ms}ms` : '—');
      const flapN = flaps.get(r.key || `${r.name}|${r.instance}`) || 0;
      const flapChip = flapN >= LogsPage.FLAP_MIN_FIRES
        ? `<span class="al-flap" title="Fired ${flapN} times in the loaded events">flapping ×${flapN}</span>`
        : '';
      // Ack is live-joined server-side onto still-firing rows only (see
      // app.py: _annotate_logs_with_acknowledgment) — a resolved row here
      // never carries it, that detail lives in Incident History instead.
      const ackLine = r.acknowledged_by
        ? `<span class="al-sub">✓ Acked by ${this._esc(r.acknowledged_by)} · ${this._fmt(r.acknowledged_at)}</span>`
        : '';
      const rowCls = openNow ? 'al-row-firing' : (firing ? 'al-row-past' : 'al-row-resolved');
      const dotCls = openNow ? 'al-dot-firing' : (firing ? 'al-dot-past' : 'al-dot-resolved');
      const badgeCls = firing ? 'al-badge-firing' : 'al-badge-resolved';
      return `<div class="al-entry">
        <div class="al-row ${rowCls}">
          <span class="al-dot ${dotCls}"></span>
          <div class="al-chip">
            <span class="al-host">${this._esc(r.instance || '—')}</span>
            <span class="al-sub">${this._esc(jobSub || '—')}${flapChip}</span>
            ${ackLine}
          </div>
          <span class="al-badge ${badgeCls}" title="${openNow ? 'Still firing' : (firing ? 'Fired — has since recovered' : 'Resolved')}">${ev.toUpperCase()}</span>
          <span class="al-fill" title="${this._esc(r.summary || '')}">${this._esc(r.summary || '—')}</span>
          <span class="al-duration">${this._esc(meta)}</span>
          <span class="al-time">${this._fmt(r.time)}</span>
        </div>
      </div>`;
    }).join('');
  }

  _fmt(ts) {
    return formatWib(ts, { seconds: true });
  }

  _fmtDur(s) {
    if (typeof s !== 'number' || isNaN(s)) return '—';
    return formatDuration(s * 1000, { compact: true });
  }

  _esc(s) { return escapeHtml(s); }
}
