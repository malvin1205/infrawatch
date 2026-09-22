/* Availability: polling + cache, the period / custom-range controls,
 * the availability sub-nav, the data-quality audit, and the availability
 * breakdown modal + trend. Installed onto InstancesPage.prototype so the
 * methods keep their original `this` and every existing call site works
 * unchanged. */
import { apiFetch } from './net.js';
import { DATE_LOCALE } from './ui/format.js';

// An SLA target is an exact operator-set value, not a measurement — unlike
// availability/coverage %, it must never get silently rounded for display.
// .toFixed(1) turns 99.99 into "100.0" (and 99.995 into "100.0"), which reads
// as the operator having set an unattainable 100% target when they didn't.
// Keep up to 3 decimals, trimming trailing zeros so the common 99.9/99.95
// case still prints clean.
function fmtTargetPct(v) {
  return typeof v === 'number' ? `${parseFloat(v.toFixed(3))}` : '—';
}

// Fixed UTC+7 offset for Asia/Jakarta (WIB) — no DST, so plain arithmetic is
// exact and doesn't need Intl/timezone-database support. Every clock in the
// Availability Breakdown modal (Trend hover, Downtime Calendar, Outage Rail)
// reads in WIB, matching the backend's day-bucketing in
// helpers._build_daily_downtime (see WIB_OFFSET_SEC there) — the two sides
// share one offset so they can never disagree about which day/hour an event
// falls in.
const WIB_OFFSET_SEC = 7 * 3600;

class _AvailabilityMethods {
  startAvailabilityPolling() {
    if (this.availabilityPollInterval) clearInterval(this.availabilityPollInterval);
    this.pollingEnabled = true;
    this.availabilityPollInterval = setInterval(() => this.loadAvailability(false), 15000);
  }

  stopAvailabilityPolling() {
    // Deliberate stop — _clearRetry() re-arms polling otherwise (see its
    // comment in dashboard.js).
    this.pollingEnabled = false;
    if (this.availabilityPollInterval) {
      clearInterval(this.availabilityPollInterval);
      this.availabilityPollInterval = null;
    }
    this._clearRetry('availability');
    if (this._availAbortController) {
      this._availAbortController.abort();
      this._availAbortController = null;
    }
  }

  _getAvailCacheKey(minutes = this.periodMinutes, job = this.selectedJob, end = this.periodEnd) {
    const jobKey = (job && job !== 'all') ? job : 'all';
    const minKey = Math.round(minutes || 1440);
    const endKey = end ? String(end) : 'live';
    return `${jobKey}:${minKey}:${endKey}`;
  }

  // Minutes from 00:00 WIB on the 1st of the current (WIB) month to now. A
  // plain fixed window like every other range — just calendar-aligned so it
  // lines up with how uptime is reported and billed to Indonesia-based
  // operators, not with whatever month UTC happens to be in for the last 7
  // hours of it.
  _monthToDateMinutes() {
    const wibNow = new Date(Date.now() + WIB_OFFSET_SEC * 1000);
    const monthStartWib = Date.UTC(wibNow.getUTCFullYear(), wibNow.getUTCMonth(), 1);
    const monthStart = monthStartWib - WIB_OFFSET_SEC * 1000;
    return Math.max(1, Math.round((Date.now() - monthStart) / 60000));
  }

  _updateAvailLoadingUI(isLoading) {
    const updatingBadge = document.getElementById('availUpdatingBadge');
    if (updatingBadge) updatingBadge.classList.toggle('hidden', !isLoading);
    // The badge alone is easy to miss — a slow Prometheus fan-out (several
    // seconds) otherwise leaves the whole modal body looking frozen on the
    // previous range's numbers with no sign a refresh is in flight.
    const modalBody = document.querySelector('.avail-modal-body');
    if (modalBody) modalBody.classList.toggle('is-refreshing', !!isLoading);
    // Same signal, mirrored onto the dashboard card's own Detail button —
    // the modal is usually closed, so the card is the only place an
    // operator would otherwise see the OLD range's number sitting there
    // looking finalized while a range switch or poll refresh is still in
    // flight. The button swaps icon+label for spinner+"Updating…" in place
    // (still clickable) rather than adding a second element to the card.
    const detailBtn = document.getElementById('availabilityDetailBtn');
    if (detailBtn) {
      detailBtn.classList.toggle('is-loading', !!isLoading);
      const label = detailBtn.querySelector('.sc-detail-label');
      if (label) label.textContent = isLoading ? 'Updating…' : 'Detail';
    }
  }

  // The headline % is honest math over whatever was observed, but for a young
  // Prometheus/DB a "7d"/"30d" window can be built from a few hours of samples.
  // Same rule the breakdown modal's own warning uses (_renderAvailabilityBreakdown).
  _availabilityCoverageIsLimited(data) {
    if (!data) return false;
    const covPct = typeof data.coverage_percent === 'number' ? data.coverage_percent : null;
    const status = data.data_status;
    return status === 'INSUFFICIENT_DATA' || status === 'PARTIAL' || (covPct !== null && covPct < 50);
  }

  _applyAvailabilityData(data, source = 'loadAvailability') {
    if (!data) return;
    this.availabilityBreakdown = data;
    this.availabilityMap = data.targets || {};

    // Availability card (Card 5): Updated to reflect the requested historical window
    const overall = (typeof data.overall === 'number') ? data.overall : null;
    const limited = overall !== null && this._availabilityCoverageIsLimited(data);
    if (this.statUptime) {
      // Mark the card when the window is mostly unobserved — otherwise the big
      // number implies full-window confidence it doesn't have. The Detail modal
      // carries the full telemetry audit (audit M2).
      this.statUptime.textContent = overall !== null ? `${overall.toFixed(2)}%${limited ? ' *' : ''}` : '—';
      this.statUptime.classList.toggle('is-limited-data', limited);
      if (limited) {
        const covPct = typeof data.coverage_percent === 'number' ? data.coverage_percent : null;
        this.statUptime.title = covPct !== null
          ? `Limited data — only ${covPct.toFixed(1)}% of this window was observed. Open Detail for the telemetry audit.`
          : 'Limited data for this window. Open Detail for the telemetry audit.';
      } else {
        this.statUptime.removeAttribute('title');
      }
    }

    // Target baseline on the dashboard card. The same percentage carried a
    // "target 99.9% / NON-COMPLIANT" verdict inside the modal and nothing at
    // all out here, so the number an operator sees first was the one with no
    // yardstick (audit 1.5). Target comes from the API, never a literal — it
    // is configurable per deployment.
    const availSub = document.getElementById('instAvailabilitySub');
    if (availSub) {
      const targetPct = typeof data.sla?.target_pct === 'number' ? data.sla.target_pct : null;
      if (targetPct === null || overall === null) {
        availSub.textContent = '';
        availSub.classList.remove('is-urgent');
      } else {
        const breached = overall < targetPct;
        availSub.textContent = breached
          ? `below ${targetPct}% target`
          : `meets ${targetPct}% target`;
        availSub.classList.toggle('is-urgent', breached);
      }
    }

    // Ensure range label is synchronized with the response data
    const respMinutes = Math.round(data.period_minutes || this.periodMinutes);
    let label = '24h';
    if (respMinutes === 60) label = '1h';
    else if (respMinutes === 10080) label = '7d';
    else if (respMinutes === 43200) label = '30d';
    if (this.periodLabel === 'custom') label = 'Custom';
    else if (this.periodLabel === 'mtd') label = 'Month to date';

    if (this.availabilityLabel) this.availabilityLabel.textContent = `Availability (${label})${limited ? ' · limited data' : ''}`;
    // Drawer captions too: the cache-hit path returns before loadAvailability()
    // reaches its own label writes, leaving the previous range's name behind.
    const drawerUptimeLabelEl = document.getElementById('drawerUptimeLabel');
    if (drawerUptimeLabelEl) drawerUptimeLabelEl.textContent = `Uptime (${label})`;
    const drawerSparklineRangeEl2 = document.getElementById('drawerSparklineRange');
    if (drawerSparklineRangeEl2) drawerSparklineRangeEl2.textContent = `(${label})`;

    // Refresh drawer uptime figure if a host is currently open
    if (this.selectedTarget) this._updateDrawerUptime(this.selectedTarget);

    // The open drawer's PROBE SUMMARY reads `entry` out of this payload, so it
    // has to be re-rendered when a new one lands. A range change fires both
    // loadAvailability() and loadTargetHistory(), but the availability fetch is
    // the slower of the two (Prometheus fan-out), so the summary used to render
    // against the PREVIOUS range's entry and then never refresh — leaving
    // "Failed 21.1h" from the 24h window sitting next to event-derived rows
    // that had correctly moved to 7d (found while fixing audit 1.4).
    if (this.selectedTarget && typeof this._renderDrawerProbeSummary === 'function') {
      const drawerEl = this.sideDrawer || document.getElementById('sideDrawer');
      if (drawerEl && drawerEl.classList.contains('drawer-open')) {
        this._renderDrawerProbeSummary(this.selectedTarget, this._lastDrawerEvents || []);
      }
    }

    // Refresh breakdown modal content if it's currently open
    if (this.availabilityBreakdownModal && !this.availabilityBreakdownModal.classList.contains('hidden')) {
      this._renderAvailabilityBreakdown(`_applyAvailabilityData:${source}`);
    }
  }

  async loadAvailability(force = false) {
    // Realtime mode is driven entirely by the live /instances poll (see
    // _updateStats()) — no historical Prometheus aggregate to fetch here.
    if (this.isRealtime) return;

    const cacheKey = this._getAvailCacheKey();
    const now = Date.now();
    const cached = this._availCache.get(cacheKey);
    const hasFreshCache = cached && (now - cached.timestamp < this._availCacheTTL);

    // 1. Instant Cache Render: If valid cached data exists, apply immediately with 0ms delay!
    if (cached && cached.data) {
      this._applyAvailabilityData(cached.data, 'cache_hit');
      this._displayedAvailKey = cacheKey;
      if (!force && hasFreshCache) {
        this._updateAvailLoadingUI(false);
        return;
      }
    }

    // force=true (manual refresh, custom range submit) supersedes in-flight requests.
    // Switching presets aborts stale in-flight requests to save network/backend bandwidth.
    // Only skip when the in-flight request is for the SAME key (e.g. the 15s
    // poll firing while an identical fetch is still pending) — an in-flight
    // request for a different job/period/end must always be aborted and
    // replaced, otherwise switching e.g. All Jobs -> blackbox-ping-internal
    // while the All Jobs response is still in flight drops the new request
    // and lets the stale All Jobs data land (and overwrite Card 5) once it
    // finally resolves.
    if (this._availAbortController) {
      if (!force && this._availLoading && this._availInFlightKey === cacheKey) {
        return;
      }
      this._availAbortController.abort();
    }
    const controller = new AbortController();
    this._availAbortController = controller;
    this._availInFlightKey = cacheKey;
    const seq = ++this._availRequestSeq;
    const isStale = () => seq !== this._availRequestSeq;

    this._availLoading = true;
    const currentJobKey = (this.selectedJob && this.selectedJob !== 'all') ? this.selectedJob : 'all';
    const hasMatchingData = this.availabilityBreakdown &&
      Math.round(this.availabilityBreakdown.period_minutes || 0) === Math.round(this.periodMinutes) &&
      ((this.availabilityBreakdown.job || 'all') === currentJobKey);
    this._updateAvailLoadingUI(!hasMatchingData);

    const rangeText = this._rangeDisplay();

    if (this.availabilityLabel) this.availabilityLabel.textContent = `Availability (${rangeText})`;
    const drawerUptimeLabel = document.getElementById('drawerUptimeLabel');
    if (drawerUptimeLabel) drawerUptimeLabel.textContent = `Uptime (${rangeText})`;
    const drawerSparklineRangeEl = document.getElementById('drawerSparklineRange');
    if (drawerSparklineRangeEl) drawerSparklineRangeEl.textContent = `(${rangeText})`;

    try {
      let url = `/api/availability?minutes=${Math.round(this.periodMinutes)}`;
      if (this.selectedJob && this.selectedJob !== 'all') {
        url += `&job=${encodeURIComponent(this.selectedJob)}`;
      }
      if (this.periodEnd) url += `&end=${this.periodEnd}`;

      const res = await fetch(url, { signal: controller.signal });
      const data = await res.json();

      if (isStale()) {
        return;
      }

      if (!data.ok) {
        this._availFailCount = Math.min(this._availFailCount + 1, 6);
        this._markAvailabilityUnavailable(cacheKey);
        this._scheduleRetry('availability');
        return;
      }
      this._availFailCount = 0;
      this._clearRetry('availability');

      // Store response in client-side memory cache
      this._availCache.set(cacheKey, { timestamp: Date.now(), data });
      this._applyAvailabilityData(data, 'network_response');
      this._displayedAvailKey = cacheKey;
    } catch (e) {
      if (e.name === 'AbortError' || isStale()) {
        return;
      }
      console.warn('[InfraWatch] Availability fetch failed:', e);
      this._availFailCount = Math.min(this._availFailCount + 1, 6);
      this._markAvailabilityUnavailable(cacheKey);
      this._scheduleRetry('availability');
    } finally {
      if (this._availAbortController === controller) {
        this._availAbortController = null;
        this._availInFlightKey = null;
        this._availLoading = false;
        this._updateAvailLoadingUI(false);
      }
    }
  }

  // The "Availability (<range>)" label is switched before the fetch, so a
  // failed fetch for a NEW range left the previous range's number sitting
  // under the new caption — a custom range that 503s read as if it had been
  // scored. Blank the number instead whenever what's painted isn't this
  // range; the retry (_scheduleRetry) repaints it once the fetch succeeds.
  _markAvailabilityUnavailable(wantedKey) {
    if (this._displayedAvailKey === wantedKey) return;
    if (this.statUptime) {
      this.statUptime.textContent = '—';
      this.statUptime.classList.remove('is-limited-data');
      this.statUptime.title = 'Availability for this range is unavailable — retrying.';
    }
  }

  _setActiveRangeChip(range) {
    if (!this.rangeChipsGroup) return;
    this.rangeChipsGroup.querySelectorAll('.chip').forEach(b => {
      b.classList.toggle('chip-active', b.dataset.range === range);
    });
  }

  // Human label for the active range, used in every "Availability (…)" caption.
  _rangeDisplay() {
    if (this.periodLabel === 'custom') return 'Custom';
    if (this.periodLabel === 'mtd') return 'Month to date';
    return this.periodLabel || '24h';
  }

  _toggleCustomRangePopover() {
    if (!this.customRangePopover) return;
    const isHidden = this.customRangePopover.classList.contains('hidden');
    if (isHidden) this._openCustomRangePopover();
    else this._closeCustomRangePopover();
  }

  _openCustomRangePopover() {
    if (!this.customRangePopover) return;
    if (this.customRangeErrorEl) this.customRangeErrorEl.classList.add('hidden');

    // Pre-fill with the currently active window (or last 24h by default)
    if (this.customRangeFromEl && !this.customRangeFromEl.value) {
      const end = this.periodEnd ? new Date(this.periodEnd * 1000) : new Date();
      const start = new Date(end.getTime() - this.periodMinutes * 60000);
      this.customRangeFromEl.value = this._toDatetimeLocalValue(start);
      this.customRangeToEl.value = this._toDatetimeLocalValue(end);
    }
    this.customRangePopover.classList.remove('hidden');
  }

  _closeCustomRangePopover() {
    if (!this.customRangePopover) return;
    this.customRangePopover.classList.add('hidden');
    // Revert chip highlight to whatever range is actually active
    if (this.periodLabel !== 'custom') this._setActiveRangeChip(this.periodLabel);
  }

  _toDatetimeLocalValue(date) {
    const pad = n => String(n).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
  }

  _applyCustomRange() {
    const fromVal = this.customRangeFromEl ? this.customRangeFromEl.value : '';
    const toVal = this.customRangeToEl ? this.customRangeToEl.value : '';
    const showError = msg => {
      if (this.customRangeErrorEl) {
        this.customRangeErrorEl.textContent = msg;
        this.customRangeErrorEl.classList.remove('hidden');
      }
    };

    if (!fromVal || !toVal) {
      showError('Please select start and end date & time');
      return;
    }

    const fromDate = new Date(fromVal);
    const toDate = new Date(toVal);

    if (isNaN(fromDate.getTime()) || isNaN(toDate.getTime())) {
      showError('Please select a valid date & time');
      return;
    }

    const minutes = (toDate.getTime() - fromDate.getTime()) / 60000;

    if (!(minutes > 0)) {
      showError('"To" date must be after "From" date');
      return;
    }
    if (minutes > 90 * 1440) {
      showError('Maximum range is 90 days');
      return;
    }
    if (toDate.getTime() > Date.now() + 60000) {
      showError('Range cannot be in the future');
      return;
    }

    this.isRealtime = false;
    if (this.availabilityDetailBtn) this.availabilityDetailBtn.style.display = '';
    this.periodMinutes = minutes;
    this.periodEnd = Math.floor(toDate.getTime() / 1000);
    this.periodLabel = 'custom';

    this._trendZoom = { lo: null, hi: null };
    this._calendarOpenDate = null;
    if (typeof this._clearTrendHighlight === 'function') this._clearTrendHighlight();

    this._setActiveRangeChip('custom');
    this.customRangePopover.classList.add('hidden');
    this.loadAvailability();
    if (this.selectedTarget) {
      this.loadTargetHistory(this.selectedTarget.instance);
    }
  }

  /* ── Availability Breakdown sub-nav (Overview & Ranking <-> Data Quality
     & Telemetry Audit) ── */
  _initAvailSubnav() {
    const btnRanking = document.getElementById('btnSubnavRanking');
    const btnAudit = document.getElementById('btnSubnavAudit');
    const paneRanking = document.getElementById('paneAvailRanking');
    const paneAudit = document.getElementById('paneAvailAudit');
    const btnReturn = document.getElementById('btnReturnToRanking');
    const warnBtn = document.getElementById('metricFleetDataWarning');
    if (!btnRanking || !btnAudit || !paneRanking || !paneAudit) return;

    const showAvailTab = (tab) => {
      const isAudit = tab === 'audit';
      paneRanking.classList.toggle('hidden', isAudit);
      paneAudit.classList.toggle('hidden', !isAudit);
      btnRanking.classList.toggle('is-active', !isAudit);
      btnAudit.classList.toggle('is-active', isAudit);
      btnRanking.setAttribute('aria-selected', String(!isAudit));
      btnAudit.setAttribute('aria-selected', String(isAudit));
      // Roving tabindex: only the active tab is a Tab stop (WAI-ARIA APG).
      btnRanking.tabIndex = isAudit ? -1 : 0;
      btnAudit.tabIndex = isAudit ? 0 : -1;
      if (isAudit) this._renderTelemetryAudit();
    };
    this._showAvailTab = showAvailTab;

    btnRanking.addEventListener('click', () => showAvailTab('ranking'));
    btnAudit.addEventListener('click', () => showAvailTab('audit'));
    if (btnReturn) btnReturn.addEventListener('click', () => showAvailTab('ranking'));

    // Arrow / Home / End key navigation between the two tabs (APG tab pattern);
    // moving to a tab also activates it.
    const onTabKey = (e) => {
      if (e.key === 'ArrowRight' || e.key === 'ArrowDown' || e.key === 'End') {
        e.preventDefault();
        showAvailTab('audit');
        btnAudit.focus();
      } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp' || e.key === 'Home') {
        e.preventDefault();
        showAvailTab('ranking');
        btnRanking.focus();
      }
    };
    btnRanking.addEventListener('keydown', onTabKey);
    btnAudit.addEventListener('keydown', onTabKey);
    // The fleet card's "Limited data" warning links straight to the audit
    // view that explains why — same idea as its "View Telemetry Audit ➔"
    // label already promises.
    if (warnBtn) warnBtn.addEventListener('click', () => showAvailTab('audit'));
  }

  /* ── Availability / SLA settings popover (gear icon) — Node Exporter
     correlation toggle. GET/POST /api/settings/availability. ── */
  _initAvailSettingsPopover() {
    const wrap = document.getElementById('availSettingsDd');
    const btn = document.getElementById('availSettingsBtn');
    const popover = document.getElementById('availSettingsPopover');
    const checkbox = document.getElementById('useNodeExporterCheckbox');
    if (!wrap || !btn || !popover) return;

    const open = () => {
      popover.classList.remove('hidden');
      btn.setAttribute('aria-expanded', 'true');
      this._loadAvailabilitySettings();
    };
    const close = () => {
      if (popover.classList.contains('hidden')) return;
      popover.classList.add('hidden');
      btn.setAttribute('aria-expanded', 'false');
    };
    this._closeAvailSettingsPopover = close;

    btn.addEventListener('click', e => {
      e.stopPropagation();
      if (popover.classList.contains('hidden')) open(); else close();
    });

    if (checkbox) {
      checkbox.addEventListener('change', () => this._saveAvailabilitySettings(checkbox.checked));
    }
    this._bindSlaTargetInput();

    // Same click-outside/Escape convention as the Default Job popover.
    document.addEventListener('click', e => {
      if (!wrap.contains(e.target)) close();
    });
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape' && !popover.classList.contains('hidden')) {
        // Swallow the Escape here so the window-level BACK interceptor doesn't
        // also close the whole Availability Breakdown modal underneath.
        e.stopPropagation();
        close();
        btn.focus();
      }
    });
  }

  async _loadAvailabilitySettings() {
    const checkbox = document.getElementById('useNodeExporterCheckbox');
    const slaInput = document.getElementById('defaultSlaTargetInput');
    const resetBtn = document.getElementById('slaTargetResetBtn');
    const errEl = document.getElementById('slaTargetError');
    if (errEl) errEl.classList.add('hidden');
    if (!checkbox && !slaInput) return;
    try {
      const res = await apiFetch('/api/settings/availability');
      const data = await res.json();
      if (!data.ok) return;
      if (checkbox) checkbox.checked = !!data.use_node_exporter_correlation;
      if (slaInput) {
        const override = data.default_sla_target_pct;
        const hasOverride = typeof override === 'number';
        // Last-saved override value, or '' when unset — the value this input
        // reverts to on Escape and the baseline _bindSlaTargetInput compares
        // against to decide whether a blur actually changed anything.
        this._slaTargetSaved = hasOverride ? override : '';
        slaInput.value = this._slaTargetSaved;
        slaInput.placeholder = fmtTargetPct(typeof data.effective_sla_target_pct === 'number' ? data.effective_sla_target_pct : 99.9);
        if (resetBtn) resetBtn.hidden = !hasOverride;
      }
    } catch (e) {
      // leave the controls showing whatever they last had — a stale read is
      // better than an error toast for a settings popover nobody's saving yet
    }
  }

  async _saveAvailabilitySettings(enabled) {
    const checkbox = document.getElementById('useNodeExporterCheckbox');
    try {
      const res = await apiFetch('/api/settings/availability', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ use_node_exporter_correlation: enabled })
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || 'Failed to save');
      this._triggerEventToast(enabled ? 'Node Exporter correlation enabled.' : 'Node Exporter correlation disabled.');
    } catch (e) {
      if (checkbox) checkbox.checked = !enabled; // revert the optimistic UI toggle
      this._triggerEventToast('Failed to save availability settings.');
    }
  }

  /* ── Default SLA target %, same popover — GET/POST /api/settings/availability
     (default_sla_target_pct). Persists fleet-wide; blank/reset reverts to
     SLA_TARGET_PCT / the hardcoded 99.9 (see get_sla_target_pct()). ── */
  _bindSlaTargetInput() {
    const input = document.getElementById('defaultSlaTargetInput');
    const resetBtn = document.getElementById('slaTargetResetBtn');
    if (!input) return;

    const commit = async () => {
      const raw = input.value.trim();
      // Unchanged since load — including the common "opened the popover,
      // changed nothing, clicked away" case — skip the round trip entirely.
      if (raw === String(this._slaTargetSaved ?? '')) return;

      const errEl = document.getElementById('slaTargetError');
      if (errEl) errEl.classList.add('hidden');

      let pct = null; // null == clear the override
      if (raw !== '') {
        pct = Number(raw);
        if (!Number.isFinite(pct) || pct < 0 || pct > 100) {
          if (errEl) { errEl.textContent = 'Enter a number between 0 and 100.'; errEl.classList.remove('hidden'); }
          return; // leave the invalid text in place so the operator can fix it
        }
      }
      await this._saveDefaultSlaTarget(pct);
    };

    input.addEventListener('blur', commit);
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); input.blur(); } // blur triggers commit()
      else if (e.key === 'Escape') { input.value = this._slaTargetSaved ?? ''; input.blur(); }
    });
    if (resetBtn) {
      resetBtn.addEventListener('click', async () => {
        input.value = '';
        await this._saveDefaultSlaTarget(null);
      });
    }
  }

  async _saveDefaultSlaTarget(pct) {
    const input = document.getElementById('defaultSlaTargetInput');
    const resetBtn = document.getElementById('slaTargetResetBtn');
    const errEl = document.getElementById('slaTargetError');
    const previous = this._slaTargetSaved;
    try {
      const res = await apiFetch('/api/settings/availability', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ default_sla_target_pct: pct })
      });
      let data = {};
      try { data = await res.json(); } catch (_) { /* non-JSON error body */ }
      if (!res.ok || !data.ok) throw new Error(data.error || 'Failed to save');

      this._slaTargetSaved = pct === null ? '' : pct;
      if (input && typeof data.effective_sla_target_pct === 'number') {
        input.placeholder = fmtTargetPct(data.effective_sla_target_pct);
      }
      if (resetBtn) resetBtn.hidden = (pct === null);
      this._triggerEventToast(
        pct === null ? 'SLA target reset to default.' : `Default SLA target set to ${pct}%.`);
      // The new target changes the SLA card, the audit table's SLA/Target
      // column and every per-host budget still using the fleet default —
      // force a fresh /api/availability fetch (bypassing the client cache)
      // rather than leaving the modal showing numbers computed against the
      // old target until the next 15s poll.
      this.loadAvailability(true);
    } catch (e) {
      if (errEl) { errEl.textContent = e.message || 'Failed to save.'; errEl.classList.remove('hidden'); }
      if (input) input.value = previous ?? ''; // revert the optimistic edit
    }
  }

  /* ── Data Quality & Telemetry Audit pane ── */
  _initAuditFilters() {
    const chips = Array.from(document.querySelectorAll('.audit-chip[data-filter]'));
    chips.forEach(chip => {
      chip.addEventListener('click', () => {
        this._auditFilter = chip.dataset.filter;
        chips.forEach(c => c.classList.toggle('is-active', c === chip));
        this._renderAuditTable();
      });
    });
    const searchInput = document.getElementById('auditSearchInput');
    if (searchInput) {
      searchInput.addEventListener('input', () => {
        this._auditSearchQ = searchInput.value;
        this._renderAuditTable();
      });
    }
  }

  // Renders the whole audit pane from the SAME /api/availability response
  // already fetched for the Overview & Ranking pane (this.availabilityBreakdown)
  // — telemetry_audit/sla/entries[].sla_budget are all already in it, no
  // second request needed. Runs on every refresh regardless of which
  // sub-tab is showing, same as the rest of _renderAvailabilityBreakdown —
  // the "LIMITED DATA" sub-nav badge needs to stay current even before the
  // operator has clicked into the tab.
  _renderTelemetryAudit() {
    // Always kept in sync with the latest data (not gated on the pane being
    // visible) — the "LIMITED DATA" sub-nav badge needs to reflect current
    // status even before the operator has clicked into the tab.
    const data = this.availabilityBreakdown;
    if (!data) return;

    const audit = data.telemetry_audit || {};
    const sla = data.sla || {};
    const fmtPct = v => typeof v === 'number' ? `${v.toFixed(2)}%` : '—';
    const fmtDur = s => this._formatDowntimeDuration(s || 0).replace(' downtime', '');

    // SLA Availability card — fleet_aggregate is already the
    // maintenance-excluded figure (see fleet_availability.py), matching
    // this card's "excl. planned maintenance" label exactly.
    const fleetAvail = typeof data.fleet_aggregate?.value === 'number' ? data.fleet_aggregate.value : null;
    const slaCard = document.getElementById('auditSlaCard');
    const slaValueEl = document.getElementById('auditSlaValue');
    const slaBadgeEl = document.getElementById('auditSlaBadge');
    const slaTargetEl = document.getElementById('auditSlaTarget');
    const slaMaintEl = document.getElementById('auditSlaMaint');

    if (slaValueEl) slaValueEl.textContent = fmtPct(fleetAvail);
    if (slaTargetEl) slaTargetEl.textContent = `target ${fmtTargetPct(sla.target_pct)}%`;

    let slaState = 'is-mid', slaLabel = 'INSUFFICIENT DATA';
    if (sla.has_data) {
      slaState = sla.window?.breached ? 'is-bad' : 'is-ok';
      slaLabel = sla.window?.breached ? 'NON-COMPLIANT' : 'COMPLIANT';
    }
    if (slaCard) slaCard.className = `audit-sla-card ${slaState}`;
    if (slaBadgeEl) { slaBadgeEl.textContent = slaLabel; slaBadgeEl.className = `audit-sla-badge ${slaState}`; }

    const maintSec = data.maintenance_excluded_seconds || 0;
    if (slaMaintEl) {
      // #auditSlaMaint uses the bare native `hidden` attribute in markup
      // (no "hidden" class, unlike e.g. #auditSubnavBadge) — toggle the
      // property, not classList, or this would silently never show.
      slaMaintEl.hidden = maintSec <= 0;
      if (maintSec > 0) slaMaintEl.textContent = `${fmtDur(maintSec)} excluded (maintenance)`;
    }

    // Downtime Budget card
    const budgetFillEl = document.getElementById('auditBudgetFill');
    const budgetStateEl = document.getElementById('auditBudgetState');
    const budgetUsedEl = document.getElementById('auditBudgetUsed');
    const budgetProjEl = document.getElementById('auditBudgetProjection');

    if (sla.has_data && sla.window) {
      const usedPct = Math.max(0, sla.window.used_percent || 0);
      const state = sla.window.breached ? 'is-bad' : (usedPct >= 75 ? 'is-mid' : 'is-ok');
      if (budgetFillEl) { budgetFillEl.style.width = `${Math.min(100, usedPct)}%`; budgetFillEl.className = `audit-budget-fill ${state}`; }
      if (budgetStateEl) { budgetStateEl.textContent = sla.window.breached ? 'BREACHED' : `${usedPct.toFixed(0)}% USED`; budgetStateEl.className = `audit-budget-state ${state}`; }
      // observed/allowed are fleet-wide host-hours (summed across every scored
      // host, not wall-clock time). Naming the scope stopped "1434h used of
      // 5h 22m allowed" reading as physically impossible, but nobody can divide
      // 1434 by 224 at a glance — so lead with the ratio and the per-host
      // average, which are the numbers an operator can actually act on, and
      // keep the raw totals as the supporting line (audit 1.3).
      const scoredHosts = data.counts?.scored || 0;
      const usedSec = sla.window.observed_downtime_seconds || 0;
      const allowedSec = sla.window.allowed_downtime_seconds || 0;
      if (budgetUsedEl) {
        if (scoredHosts > 1) {
          const perHostUsed = fmtDur(usedSec / scoredHosts);
          const perHostAllowed = fmtDur(allowedSec / scoredHosts);
          const overTxt = allowedSec > 0
            ? (usedSec > allowedSec
              ? `${(usedSec / allowedSec).toFixed(usedSec / allowedSec >= 10 ? 0 : 1)}× over budget`
              : `${((usedSec / allowedSec) * 100).toFixed(0)}% of budget used`)
            : '—';
          budgetUsedEl.innerHTML =
            `<strong>${this._esc(overTxt)}</strong> — avg <strong>${this._esc(perHostUsed)}</strong> downtime per host ` +
            `vs ${this._esc(perHostAllowed)} allowed each` +
            `<span class="audit-budget-raw">fleet total ${this._esc(fmtDur(usedSec))} used of ${this._esc(fmtDur(allowedSec))} allowed · ${scoredHosts} hosts</span>`;
        } else {
          budgetUsedEl.textContent = `${fmtDur(usedSec)} used of ${fmtDur(allowedSec)} allowed`;
        }
      }
      if (budgetProjEl) {
        budgetProjEl.textContent = sla.projected
          ? (sla.projected.breach
            ? `⚠ Projected to breach in ${sla.projected.days}d at current rate`
            : `On track for ${sla.projected.days}d projection`)
          : '';
      }
    } else {
      if (budgetFillEl) { budgetFillEl.style.width = '0%'; budgetFillEl.className = 'audit-budget-fill'; }
      if (budgetStateEl) { budgetStateEl.textContent = '—'; budgetStateEl.className = 'audit-budget-state'; }
      if (budgetUsedEl) budgetUsedEl.textContent = '— used of —';
      if (budgetProjEl) budgetProjEl.textContent = '';
    }

    // Coverage source one-liner
    const statusEl = document.getElementById('auditStatus');
    const statusTextEl = document.getElementById('auditStatusText');
    const statusSrcEl = document.getElementById('auditStatusSrc');
    const confLevel = audit.confidence_level || 'LOW';
    const statusState = confLevel === 'HIGH' ? 'is-ok' : (confLevel === 'MODERATE' ? 'is-warn' : 'is-bad');
    if (statusEl) statusEl.className = `audit-status ${statusState}`;
    if (statusTextEl) statusTextEl.textContent = audit.root_cause_hint || audit.recommendation || 'No telemetry audit data available for this window.';
    // "source: materialized" (or hybrid / fallback / nodata) leaked the
    // storage strategy's internal name straight onto an operator screen —
    // meaningless at best, and "fallback"/"nodata" read as "the monitoring is
    // broken" with nothing to say otherwise (audit 2.1 / 5.8).
    if (statusSrcEl) {
      const src = audit.storage?.source;
      const SOURCE_LABELS = {
        materialized: 'Data source: stored history (complete)',
        hybrid: 'Data source: live query + stored history',
        fallback: '⚠ Estimated from partial data — Prometheus did not answer in full',
        nodata: '⚠ No data recorded for this range',
      };
      statusSrcEl.textContent = src ? (SOURCE_LABELS[src] || `Data source: ${src}`) : '';
      statusSrcEl.classList.toggle('is-degraded', src === 'fallback' || src === 'nodata');
    }

    // Coverage split cards (Observed / Unmonitored / Planned maintenance)
    const coverageSec = audit.coverage_seconds ?? data.coverage_seconds ?? 0;
    const missingSec = audit.missing_seconds ?? data.missing_seconds ?? 0;
    const winSec = audit.requested_window_seconds || data.requested_window_seconds || (coverageSec + missingSec) || 1;
    // Compact window label for the sub-line: "24h" reads cleaner than
    // fmtDur's "24h 00m" when the window is a whole number of hours.
    const winLabel = winSec % 3600 === 0 ? `${winSec / 3600}h` : fmtDur(winSec);
    const covPct = typeof audit.coverage_percent === 'number' ? audit.coverage_percent : (data.coverage_percent || 0);
    const missPct = typeof audit.missing_percent === 'number' ? audit.missing_percent : Math.max(0, 100 - covPct);

    const setCoverageCard = (valId, subId, sec, pct, subText) => {
      const valEl = document.getElementById(valId);
      const subEl = document.getElementById(subId);
      if (valEl) valEl.textContent = fmtDur(sec);
      // Never round a partial figure up to a flat 100.0% — "23h 59m" labelled
      // "100.0% of 24h" is the kind of small lie that teaches operators not to
      // trust the panel (audit 1.9). Same guard at the 0% end.
      let pctTxt = pct.toFixed(1);
      if (pctTxt === '100.0' && pct < 100) pctTxt = '99.9';
      if (pctTxt === '0.0' && pct > 0) pctTxt = '<0.1';
      if (subEl) subEl.textContent = subText || `${pctTxt}% of ${winLabel}`;
    };
    setCoverageCard('auditMetricObserved', 'auditMetricObservedPct', coverageSec, covPct);
    setCoverageCard('auditMetricMissing', 'auditMetricMissingPct', missingSec, missPct);

    // Unmonitored time is only worth an alarm colour when there is enough of it
    // to distort the numbers. 25s out of 24h (0.0%) painted amber told the
    // operator to investigate a rounding error (audit 3.6); below 1% of the
    // window it renders as ordinary muted text.
    const missingValEl = document.getElementById('auditMetricMissing');
    if (missingValEl) missingValEl.classList.toggle('text-missing', missPct >= 1);

    const maintCard = document.getElementById('auditMaintCard');
    const auditGrid = document.getElementById('auditGrid');
    // Headline = wall-clock planned-maintenance time scheduled inside the
    // selected range (what the operator expects to see — "4m", not "4s").
    // Sub-line = how much of that has actually left the SLA denominator so
    // far; it lags the headline while the last minutes of telemetry are
    // still being aggregated, then catches up. Both are fleet totals.
    const maintSchedSec = data.maintenance_scheduled_seconds || 0;
    if (maintSchedSec > 0 || maintSec > 0) {
      if (maintCard) maintCard.hidden = false;
      if (auditGrid) auditGrid.classList.add('has-maint');
      const mVal = document.getElementById('auditMetricMaint');
      const mSub = document.getElementById('auditMetricMaintPct');
      // Always minutes:seconds, even for a value under 60s — fmtDur alone
      // would render the carved figure as a bare "4s" and hide that it is
      // 4s *of 4 minutes scheduled* (the rest is telemetry not yet
      // aggregated). Showing both makes the lag self-evident.
      const fmtMS = s => { s = Math.max(0, Math.round(s)); return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`; };
      if (mVal) mVal.textContent = fmtDur(maintSchedSec || maintSec);
      if (mSub) mSub.textContent = `${fmtMS(maintSec)} of ${fmtMS(maintSchedSec)} excl. from SLA so far`;
    } else {
      if (maintCard) maintCard.hidden = true;
      if (auditGrid) auditGrid.classList.remove('has-maint');
    }

    // Sub-nav "LIMITED DATA" badge
    const subnavBadge = document.getElementById('auditSubnavBadge');
    if (subnavBadge) {
      const isLimited = confLevel === 'LOW' || data.data_status === 'INSUFFICIENT_DATA' || data.data_status === 'PARTIAL';
      subnavBadge.classList.toggle('hidden', !isLimited);
    }

    this._renderAuditTable();
  }

  _renderAuditTable() {
    const tbody = document.getElementById('auditTableBody');
    const countEl = document.getElementById('auditTableHostCount');
    if (!tbody) return;
    const entries = this.availabilityBreakdown?.entries || [];
    const filter = this._auditFilter || 'all';
    const q = (this._auditSearchQ || '').trim().toLowerCase();

    let rows = entries.filter(e => {
      const cov = e.coverage_pct ?? e.coverage_percent ?? 0;
      if (q && !((e.name || e.id || '')).toLowerCase().includes(q)) return false;
      if (filter === 'breach') return e.sla_status === 'NON_COMPLIANT';
      if (filter === 'limited') return cov < 50;
      if (filter === 'optimal') return cov >= 95;
      return true;
    });

    if (countEl) countEl.textContent = `${rows.length} host${rows.length !== 1 ? 's' : ''}`;

    if (rows.length === 0) {
      tbody.innerHTML = `<tr><td colspan="5" class="audit-empty-row">No hosts match this filter</td></tr>`;
      return;
    }

    // Worst coverage first — an audit view exists to surface problems, not
    // to repeat the Overview pane's default ordering.
    rows.sort((a, b) => (a.coverage_pct ?? a.coverage_percent ?? 0) - (b.coverage_pct ?? b.coverage_percent ?? 0));

    tbody.innerHTML = rows.map(e => {
      const cov = e.coverage_pct ?? e.coverage_percent ?? 0;
      const isLim = cov < 50;
      // Per-host "why is coverage low" — hint + recommendation from the backend
      // telemetry audit, so a limited row explains itself on hover.
      const covReason = [e.root_cause_hint, e.recommendation].filter(Boolean).join(' — ')
        || `${cov.toFixed(1)}% of this window was observed for ${e.name || e.id || 'this host'}.`;
      const covTitle = ` title="${this._esc(covReason)}"`;
      const sla = this._slaBadgeInfo(e);
      const slaCls = sla.cls === 'alt-ok' ? 'text-ok' : (sla.cls === 'alt-warning' ? 'text-bad' : 'text-dim');
      const budget = e.sla_budget || {};
      const targetPct = typeof e.sla_target_pct === 'number' ? e.sla_target_pct : budget.target_pct;
      const downtimeSec = e.sla_downtime_seconds ?? e.downtime_seconds ?? 0;
      // Below the SLA coverage gate there isn't enough observed time to judge
      // the error budget — an 86s/24h allowance measured against 20min of
      // data would read "Breached" on almost anything. Show n/a instead.
      // (undefined sla_eligible = legacy entry, keep prior behaviour.)
      const slaEligible = e.sla_eligible !== false;
      const budgetLeftTxt = !slaEligible ? 'n/a'
        : budget.has_data
          ? (budget.window?.breached ? 'Breached' : this._formatDowntimeDuration(budget.window?.remaining_seconds || 0).replace(' downtime', ''))
          : '—';
      const budgetCls = (!slaEligible || !budget.has_data) ? 'text-dim'
        : (budget.window?.breached ? 'text-bad' : ((budget.window?.used_percent || 0) >= 75 ? 'text-mid' : 'text-ok'));
      const budgetTitle = !slaEligible ? ' title="Coverage below the SLA threshold — not enough data to score the error budget"' : '';

      return `<tr>
        <td>
          <span class="audit-host-name">${this._esc(e.name || e.id || '—')}</span>
          <span class="audit-host-job">${this._esc(e.job || '—')}</span>
        </td>
        <td${covTitle}>
          <div class="audit-cov-cell">
            <span class="audit-cov-pct${isLim ? ' is-lim' : ''}">${cov.toFixed(1)}%</span>
            <div class="audit-cov-bar-wrap"><div class="audit-cov-bar-fill${isLim ? ' bar-limited' : ''}" style="width:${Math.max(0, Math.min(100, cov))}%;"></div></div>
          </div>
        </td>
        <td class="ta-r mono">
          <span class="${slaCls}">${typeof e.availability_pct === 'number' ? e.availability_pct.toFixed(2) + '%' : '—'}</span>
          <span class="audit-tgt"> / ${fmtTargetPct(targetPct)}%</span>
        </td>
        <td class="ta-r mono">${this._formatDowntimeDuration(downtimeSec).replace(' downtime', '')}</td>
        <td class="ta-r mono"${budgetTitle}><span class="${budgetCls}">${budgetLeftTxt}</span></td>
      </tr>`;
    }).join('');
  }

  /* ── Availability breakdown modal (Historical service health) ── */
  _openAvailabilityBreakdown() {
    if (!this.availabilityBreakdownModal) return;
    // Remember what had focus so it can be restored on close (WCAG 2.4.3).
    this._preBreakdownFocusEl = document.activeElement;
    this.availabilityBreakdownModal.classList.remove('hidden');
    document.body.classList.add('modal-open');
    if (this._untrapBreakdown) this._untrapBreakdown();
    this._untrapBreakdown = window.trapModalFocus(this.availabilityBreakdownModal);

    // Move focus into the dialog. The close button is always present and is a
    // safe first stop (Enter on it just re-closes).
    const closeBtn = document.getElementById('closeAvailabilityBreakdown');
    if (closeBtn) setTimeout(() => closeBtn.focus(), 0);

    // Month-to-date has no fixed minute count (it grows every minute the
    // month runs, see _monthToDateMinutes) but its <option value="mtd"> is a
    // sentinel string, not a number — matching it by parsing every option's
    // value as a float and comparing to the current minutes never hits, so
    // opening the modal while MTD is selected silently left the dropdown on
    // whatever it last showed (usually "Last 24 Hours") while the trend/
    // calendar/headline underneath had already loaded real MTD data: the
    // range label and the numbers on screen disagreed until the operator
    // touched the dropdown themselves.
    const modalRangeSelect = document.getElementById('modalRangeSelect');
    if (modalRangeSelect) {
      if (this.periodLabel === 'mtd') {
        modalRangeSelect.value = 'mtd';
      } else {
        const curMins = Math.round(this.periodMinutes);
        const matchingOpt = Array.from(modalRangeSelect.options).find(o => Math.round(parseFloat(o.value)) === curMins);
        if (matchingOpt) {
          modalRangeSelect.value = matchingOpt.value;
        }
      }
      // The select is skinned into a custom dropdown (ui/select-skin.js)
      // whose visible trigger label only redraws on user interaction or a
      // dispatched 'change' — a bare `.value =` (above) leaves the real
      // value correct but the on-screen text stuck on whatever was last
      // shown. Dispatching 'change' isn't an option here: dashboard.js's
      // own listener on this element would treat it as a user-initiated
      // range switch and fire a redundant Prometheus fetch even when the
      // data underneath is already cached. Just re-paint the label text
      // directly instead.
      const ddLabel = modalRangeSelect.parentElement && modalRangeSelect.parentElement.querySelector('.job-dd-label');
      if (ddLabel) {
        const opt = modalRangeSelect.options[modalRangeSelect.selectedIndex];
        if (opt) ddLabel.textContent = opt.textContent;
      }
    }

    const currentMins = Math.round(this.periodMinutes);
    const currentJob = (this.selectedJob && this.selectedJob !== 'all') ? this.selectedJob : 'all';
    const cacheKey = this._getAvailCacheKey();
    const cached = this._availCache.get(cacheKey);

    if (cached && cached.data &&
        Math.round(cached.data.period_minutes || 0) === currentMins &&
        ((cached.data.job || 'all') === currentJob)) {
      // Modal is already unhidden above, so _applyAvailabilityData's own
      // modal-open check already triggers a render — a second explicit call
      // here just re-renders the same data.
      this._applyAvailabilityData(cached.data, '_openAvailabilityBreakdown');
    } else {
      this.loadAvailability(true);
    }
  }

  _closeAvailabilityBreakdown() {
    if (this._untrapBreakdown) { this._untrapBreakdown(); this._untrapBreakdown = null; }
    if (this.availabilityBreakdownModal) this.availabilityBreakdownModal.classList.add('hidden');

    // Reopening should start fresh, not resume wherever the last visit left
    // off — otherwise the expanded calendar day panel and scroll position
    // leak across close/reopen (and across unrelated range changes, since
    // both live on `this`, not on the modal's DOM).
    this._calendarOpenDate = null;
    this._trendZoom = { lo: null, hi: null };
    this._clearTrendHighlight();
    const scrollEl = this.availabilityBreakdownModal?.querySelector('.avb-scroll');
    if (scrollEl) scrollEl.scrollTop = 0;

    const availSortMenu = document.getElementById('availSortMenu');
    const availSortTrigger = document.getElementById('availSortTrigger');
    availSortMenu?.classList.add('hidden');
    availSortTrigger?.setAttribute('aria-expanded', 'false');

    if (!document.querySelector('.modal-backdrop:not(.hidden):not(#availabilityBreakdownModal)')) {
      document.body.classList.remove('modal-open');
    }

    // Return focus to whatever opened the modal (usually the Detail button).
    if (this._preBreakdownFocusEl && document.contains(this._preBreakdownFocusEl)) {
      this._preBreakdownFocusEl.focus();
    }
    this._preBreakdownFocusEl = null;
  }

  // Format downtime in seconds to human-readable format: "12h 18m downtime", "4m 20s downtime", "0s downtime"
  _formatDowntimeDuration(seconds) {
    if (!seconds || seconds <= 0) return '0s downtime';
    if (seconds < 60) return `${Math.round(seconds)}s downtime`;
    if (seconds < 3600) {
      const m = Math.floor(seconds / 60);
      const s = Math.round(seconds % 60);
      return s > 0 ? `${m}m ${s}s downtime` : `${m}m downtime`;
    }
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    return `${h}h ${m.toString().padStart(2, '0')}m downtime`;
  }

  // Get clean friendly role/job badge for a host
  _getHostRoleLabel(target, entry) {
    if (target && target.labels && target.labels.role) return target.labels.role;
    if (target && target.labels && target.labels.job && target.labels.job !== 'blackbox') return target.labels.job;
    const job = (target && target.job) || (entry && entry.job) || '';
    if (job === 'blackbox-ping-internal' || job === 'ping') return 'ICMP Ping';
    if (job === 'blackbox_http' || job === 'http' || (target && target.isWeb)) return 'Web Server';
    if (job === 'custom') return 'Custom Target';
    if (job) return job;
    return 'Server';
  }

  // Single source of truth for SLA status (used by detail drawer)
  _slaBadgeInfo(entry) {
    const status = entry && entry.sla_status;
    if (status === 'COMPLIANT') return { cls: 'alt-ok', label: 'COMPLIANT' };
    if (status === 'NON_COMPLIANT') return { cls: 'alt-warning', label: 'NON-COMPLIANT' };
    if (status === 'INSUFFICIENT_DATA') return { cls: 'alt-insufficient', label: 'INSUFFICIENT DATA' };
    const cov = typeof entry?.coverage_percent === 'number' ? entry.coverage_percent
      : (typeof entry?.coverage_pct === 'number' ? entry.coverage_pct : null);
    const avail = typeof entry?.availability_pct === 'number' ? entry.availability_pct : null;
    if (avail === null || cov === null || cov < 50) return { cls: 'alt-insufficient', label: 'INSUFFICIENT DATA' };
    return avail >= 99.9 ? { cls: 'alt-ok', label: 'COMPLIANT' } : { cls: 'alt-warning', label: 'NON-COMPLIANT' };
  }

  // Human duration label for an offset of `sec` seconds before "now".
  _trendOffsetLabel(sec) {
    if (sec <= 60) return 'now';
    if (sec < 3600) return `-${Math.round(sec / 60)}m`;
    if (sec < 86400 * 2) return `-${Math.round(sec / 3600)}h`;
    return `-${Math.round(sec / 86400)}d`;
  }

  // Absolute timestamp label for the hover tooltip — time-of-day for short
  // windows, calendar date for multi-day ones. WIB (UTC+7) throughout, like
  // every other clock in this modal (Downtime Calendar day labels, Outage
  // Rail): the Trend point and the rail segment for the same moment must
  // show the same number, or correlating a dip here with the rail below
  // means doing timezone math by hand.
  _trendTsLabel(ts, windowSec, isEnd = false, startTs = 0) {
    const d = new Date((ts + WIB_OFFSET_SEC) * 1000);
    const pad = n => String(n).padStart(2, '0');
    if (windowSec <= 86400 * 2) {
      const hh = d.getUTCHours(), mm = d.getUTCMinutes();
      // A full-day zoom's end lands on 00:00 of the NEXT day — say "24:00" of
      // the day it's closing out, same convention as the Calendar's day-detail
      // ranges, so "zoomed to 00:00 – 00:00" never reads as a zero-width window.
      if (isEnd && hh === 0 && mm === 0 && ts > startTs) return '24:00 WIB';
      return `${pad(hh)}:${pad(mm)} WIB`;
    }
    const mon = d.toLocaleString(undefined, { month: 'short', timeZone: 'UTC' });
    return `${mon} ${d.getUTCDate()}, ${pad(d.getUTCHours())}:00 WIB`;
  }

  /* ── Availability Trend chart (hourly fleet availability) ──
     Draws data.trend ([{ts, availability_pct}], newest last) as an SVG line +
     area into #avbTrendPlot, over the SAME window the breakdown is scored for
     (data.trend_start_ts .. data.trend_end_ts) — 24h/7d/30d/MTD/custom, not a
     frozen 24h. Fewer than 2 points -> keep the placeholder. The y-axis
     auto-zooms to the data (100% pinned at top). A pointer overlay adds a
     crosshair + tooltip on hover. ── */
  // `zoomOverride` lets a drag-zoom call re-render synchronously with a
  // window not yet reflected on `this._trendZoom` (avoids a stale-frame
  // flash); normal calls (poll refresh, tab switch) omit it and read
  // this._trendZoom as usual.
  _renderAvailabilityTrend(data, zoomOverride) {
    const plot = document.getElementById('avbTrendPlot');
    if (!plot) return;
    const section = plot.closest('.avb-trend-section');
    const emptyEl = plot.querySelector('.avb-trend-empty');
    const gridLabels = plot.querySelectorAll('.avb-trend-grid span i');
    const subEl = section && section.querySelector('.modal-title-sub');
    const xAxisSpans = section ? section.querySelectorAll('.avb-trend-xaxis span') : [];
    let wrap = document.getElementById('avbTrendSvgWrap');
    let hover = document.getElementById('avbTrendHover');

    this._lastAvailabilityData = data;
    const fullEnd = typeof data.trend_end_ts === 'number' ? data.trend_end_ts : (Date.now() / 1000);
    const fullStart = typeof data.trend_start_ts === 'number' && data.trend_start_ts < fullEnd
      ? data.trend_start_ts
      : fullEnd - 86400;

    const bucketSec = typeof data.trend_bucket_seconds === 'number' ? data.trend_bucket_seconds : 3600;

    if (!this._trendZoom || (typeof this._trendZoom.lo === 'number' && typeof this._trendZoom.hi === 'number' && (this._trendZoom.lo >= fullEnd || this._trendZoom.hi <= fullStart || this._trendZoom.lo >= this._trendZoom.hi))) {
      this._trendZoom = { lo: null, hi: null };
    }
    const zoom = zoomOverride || this._trendZoom;

    const allPts = Array.isArray(data && data.trend)
      ? data.trend.filter(p => p && typeof p.ts === 'number' && typeof p.availability_pct === 'number')
      : [];
    allPts.sort((a, b) => a.ts - b.ts);

    const startTs = (typeof zoom.lo === 'number') ? Math.max(fullStart, zoom.lo) : fullStart;
    const endTs = (typeof zoom.hi === 'number') ? Math.min(fullEnd, zoom.hi) : fullEnd;
    const windowSec = Math.max(1, endTs - startTs);
    const isZoomed = startTs > fullStart + 1 || endTs < fullEnd - 1;
    const pts = allPts.filter(p => p.ts >= startTs && (p.ts <= endTs || (p.ts - bucketSec < endTs && Math.abs(endTs - fullEnd) < 60)));

    const resetBtn = document.getElementById('avbTrendZoomReset');
    if (resetBtn) resetBtn.classList.toggle('hidden', !isZoomed);

    // Caption reflects the active range (drives from periodLabel, same source
    // as every other "Availability (…)" label in the modal) — or the zoomed
    // span, once zoomed, so the header never claims a wider window than the
    // chart is actually showing.
    if (subEl) {
      subEl.textContent = isZoomed
        ? `· zoomed to ${this._trendTsLabel(startTs, windowSec)} – ${this._trendTsLabel(endTs, windowSec, true, startTs)}`
        : (this.periodLabel === 'mtd' ? '· month to date'
          : this.periodLabel === 'custom' ? '· selected range'
            : `· last ${this.periodLabel || '24h'}`);
    }
    // 5 evenly spaced x-axis ticks across the visible window.
    if (xAxisSpans.length === 5) {
      for (let i = 0; i < 5; i++) {
        xAxisSpans[i].textContent = isZoomed
          ? this._calendarFormatTime(startTs + windowSec * (i / 4), i === 4, startTs)
          : this._trendOffsetLabel(windowSec * (1 - i / 4));
      }
    }

    const resetGrid = () => {
      if (gridLabels.length === 3) {
        gridLabels[0].textContent = '100%';
        gridLabels[1].textContent = '50%';
        gridLabels[2].textContent = '0%';
      }
    };

    if (pts.length < 2) {
      if (wrap) wrap.remove();
      if (hover) { hover.remove(); }
      if (emptyEl) emptyEl.classList.remove('hidden');
      resetGrid();
      return;
    }

    if (emptyEl) emptyEl.classList.add('hidden');

    // y-domain: 100% pinned at the top, lower bound snapped below the worst
    // slot (never above 95, never below 0) so a near-flat healthy line still
    // shows shape without lying about the scale.
    const worst = Math.min(...pts.map(p => p.availability_pct));
    const yMax = 100;
    let yMin = Math.max(0, Math.floor((worst - 2) / 5) * 5);
    if (yMin >= yMax) yMin = yMax - 5;
    const yMid = Math.round((yMin + yMax) / 2);
    if (gridLabels.length === 3) {
      gridLabels[0].textContent = `${yMax}%`;
      gridLabels[1].textContent = `${yMid}%`;
      gridLabels[2].textContent = `${yMin}%`;
    }

    const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
    const xOf = ts => clamp(((ts - startTs) / windowSec) * 100, 0, 100);
    const yOf = v => clamp(((yMax - v) / (yMax - yMin)) * 100, 0, 100);
    const coords = pts.map(p => [xOf(p.ts), yOf(p.availability_pct)]);

    // The drawn line/area extends flat from the last real sample to the
    // visible right edge (x=100) when that sample doesn't already reach it —
    // e.g. a zoom whose end falls between two bucket boundaries, or the
    // in-progress bucket sitting slightly before `endTs`. This is a display-
    // only extension of the last KNOWN value (nothing changed since that
    // sample), never a new coordinate: `coords`/`pts` (hover crosshair, click
    // event-detail lookup) are untouched, so the drawn edge still hover/
    // click-resolves to the real last point behind it.
    const drawCoords = coords[coords.length - 1][0] < 99.95
      ? [...coords, [100, coords[coords.length - 1][1]]]
      : coords;
    const lineD = drawCoords.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(2)} ${y.toFixed(2)}`).join(' ');
    const areaD = `${lineD} L${drawCoords[drawCoords.length - 1][0].toFixed(2)} 100 L${drawCoords[0][0].toFixed(2)} 100 Z`;

    if (!wrap) {
      // Build the <svg> as a string inside an HTML <div> — same pattern as
      // _renderSparkline; avoids relying on SVGElement.innerHTML. Appended
      // after .avb-trend-grid so the line paints over the grid lines.
      wrap = document.createElement('div');
      wrap.id = 'avbTrendSvgWrap';
      wrap.className = 'avb-trend-svg-wrap';
      wrap.setAttribute('aria-hidden', 'true');
      plot.appendChild(wrap);
    }
    // SLA target reference line. Without it the trend showed a flat line at
    // ~73% with nothing to compare against, so "is this bad?" needed a trip to
    // another tab (audit 4.6). Target comes from the API — it is configurable
    // per deployment — and is only drawn when it falls inside the y-domain.
    const targetPct = typeof data.sla?.target_pct === 'number' ? data.sla.target_pct : null;
    let targetSvg = '';
    if (targetPct !== null && targetPct <= yMax && targetPct >= yMin) {
      const ty = yOf(targetPct).toFixed(2);
      targetSvg =
        `<line class="avb-trend-target" x1="0" y1="${ty}" x2="100" y2="${ty}" vector-effect="non-scaling-stroke"></line>`;
    }

    // Drop/recovery markers — explicit, so "the trend moved because a host
    // went down/came back" never has to be inferred from the line's slope
    // alone, and so there's an actual visual target for each: previously
    // only recoveries got a tick, which meant a DOWN moment had nothing
    // concrete on the chart to click. Reads the SAME fleet sweep as the
    // tooltip/detail panel, so a tick's position and the panel's answer for
    // clicking it can never disagree. Capped past a few dozen in one view —
    // they'd be a smear, not a signal, and hover/click still answer
    // precisely for any point regardless.
    this._fleetSweep = this._buildFleetSweep(data.daily, fullStart, fullEnd);
    const visibleRecoveries = this._fleetSweep.changes.filter(c => c.type === 'recovery' && c.ts >= startTs && c.ts <= endTs);
    const visibleDrops = this._fleetSweep.changes.filter(c => c.type === 'drop' && c.ts >= startTs && c.ts <= endTs);
    const recoverySvg = visibleRecoveries.length <= 40
      ? visibleRecoveries.map(c =>
        `<line class="avb-trend-recovery-tick" x1="${xOf(c.ts).toFixed(2)}" y1="0" x2="${xOf(c.ts).toFixed(2)}" y2="100" vector-effect="non-scaling-stroke"></line>`
      ).join('')
      : '';
    const dropSvg = visibleDrops.length <= 40
      ? visibleDrops.map(c =>
        `<line class="avb-trend-drop-tick" x1="${xOf(c.ts).toFixed(2)}" y1="0" x2="${xOf(c.ts).toFixed(2)}" y2="100" vector-effect="non-scaling-stroke"></line>`
      ).join('')
      : '';

    wrap.innerHTML =
      `<svg class="avb-trend-svg" viewBox="0 0 100 100" preserveAspectRatio="none">` +
      `<path class="avb-trend-area" d="${areaD}"></path>` +
      dropSvg +
      recoverySvg +
      `<path class="avb-trend-line" d="${lineD}" vector-effect="non-scaling-stroke"></path>` +
      targetSvg +
      `</svg>`;

    // Legend note for the reference line — an unexplained dashed line is just
    // another unlabelled mark.
    const targetNoteEl = document.getElementById('avbTrendTargetNote');
    if (targetNoteEl) {
      if (targetPct === null) {
        targetNoteEl.textContent = '';
      } else if (targetPct < yMin) {
        targetNoteEl.textContent = `SLA target ${targetPct}% — below this chart's range`;
      } else {
        targetNoteEl.textContent = `╌╌ SLA target ${targetPct}%${recoverySvg ? ' · │ green = a host recovered' : ''}`;
      }
    }

    // ── Interactive overlay: hover for a crosshair readout, drag to zoom,
    // plain click to pin an exact event detail panel below. `sweep`/
    // `entriesByHost` let the tooltip and detail panel answer "why did it
    // move here" from the SAME daily/events data already in this payload —
    // no extra fetch, and it always agrees with the Downtime Calendar /
    // Outage Today chart since all three read the same fleet sweep
    // (_buildFleetSweep).
    this._entriesByHost = new Map((data.entries || []).map(e => [e.id || e.name, e]));
    this._trendHoverState = {
      coords, pts, windowSec, bucketSec, startTs, endTs,
      sweep: this._fleetSweep,
    };
    // Persistent pin, separate from the transient hover crosshair — set by
    // clicking Outage Today so the operator can see, without guessing,
    // which point on this chart that event actually moved.
    this._renderTrendPin(plot);
    if (!hover) {
      hover = document.createElement('div');
      hover.id = 'avbTrendHover';
      hover.className = 'avb-trend-hover';
      hover.innerHTML =
        '<div class="avb-trend-cross"></div>' +
        '<div class="avb-trend-dot"></div>' +
        '<div class="avb-trend-tip"></div>';
      plot.appendChild(hover);

      const move = e => {
        const st = this._trendHoverState;
        if (!st || st.coords.length < 2) return;
        const rect = hover.getBoundingClientRect();
        if (!rect.width) return;
        const xp = clamp(((e.clientX - rect.left) / rect.width) * 100, 0, 100);
        let best = 0, bd = Infinity;
        for (let i = 0; i < st.coords.length; i++) {
          const d = Math.abs(st.coords[i][0] - xp);
          if (d < bd) { bd = d; best = i; }
        }
        const [cx, cy] = st.coords[best];
        const p = st.pts[best];
        const cross = hover.querySelector('.avb-trend-cross');
        const dot = hover.querySelector('.avb-trend-dot');
        const tip = hover.querySelector('.avb-trend-tip');
        cross.style.left = `${cx}%`;
        dot.style.left = `${cx}%`;
        dot.style.top = `${cy}%`;
        tip.textContent = `${this._trendTsLabel(Math.min(p.ts, st.endTs), st.windowSec)} · ${p.availability_pct.toFixed(2)}%${this._trendWhyText(p, st)}`;
        tip.style.left = `${cx}%`;
        tip.style.top = `${cy}%`;
        tip.classList.toggle('flip-x', cx > 62);
        tip.classList.toggle('edge-left', cx < 38);
        tip.classList.toggle('flip-y', cy < 22);
        hover.classList.add('active');
      };
      hover.addEventListener('pointermove', move);
      hover.addEventListener('pointerleave', () => hover.classList.remove('active'));
    }

    // Domain MUST be the exact [startTs, endTs] this render just drew the
    // line/ticks against — not the raw, unclamped zoom.lo/zoom.hi. Those two
    // used to diverge (this passed raw zoom bounds while drawing used the
    // fullStart/fullEnd-clamped ones) whenever the loaded window shifted
    // under an already-set zoom — e.g. a rolling "last 24h" range sliding
    // forward while zoomed into an older slice, or switching period/date
    // while zoomed. When they diverge, a click's pixel position maps to a
    // DIFFERENT timestamp than the one the pixel is actually drawn at, so
    // the closest change found there can belong to a different host/state
    // entirely than whatever the operator's cursor was actually over.
    // Passing the same already-clamped values used for `xOf` makes draw and
    // click agree by construction — there is no second copy of the domain
    // left to drift out of sync.
    this._attachZoomDrag(
      plot,
      { lo: startTs, hi: endTs },
      (lo, hi) => {
        this._clearTrendHighlight();
        this._trendZoom = { lo, hi };
        this._renderAvailabilityTrend(this._lastAvailabilityData, this._trendZoom);
      },
      (ts, clientX) => this._pinEventDetail('avbTrendEventDetail', ts, this._fleetSweep, windowSec, clientX)
    );
    const hint = document.getElementById('avbTrendHint');
    if (hint && resetBtn && !resetBtn.dataset.wired) {
      resetBtn.dataset.wired = '1';
      resetBtn.addEventListener('click', () => {
        this._trendZoom = { lo: null, hi: null };
        this._clearTrendHighlight();
        this._renderAvailabilityTrend(this._lastAvailabilityData);
      });
    }
    const todayBtn = document.getElementById('avbTrendTodayBtn');
    if (todayBtn && !todayBtn.dataset.wired) {
      todayBtn.dataset.wired = '1';
      todayBtn.addEventListener('click', () => {
        this._clearTrendHighlight();
        this._zoomTrendToWibDay(this._todayWibDateStr());
      });
    }
  }

  // Persistent pin element for cross-highlighting — created once, moved (or
  // hidden) by _highlightTrendAt/_clearTrendHighlight. Visually identical to
  // the hover dot/tip but doesn't disappear when the pointer leaves, so a
  // click on an Outage Rail event stays pointed-at while the operator looks
  // at both panels.
  _renderTrendPin(plot) {
    if (!document.getElementById('avbTrendPin')) {
      const pin = document.createElement('div');
      pin.id = 'avbTrendPin';
      pin.className = 'avb-trend-hover avb-trend-pin hidden';
      pin.innerHTML =
        '<div class="avb-trend-cross"></div>' +
        '<div class="avb-trend-dot"></div>' +
        '<div class="avb-trend-tip"></div>';
      plot.appendChild(pin);
    }
  }

  // Moves the persistent Trend pin to `ts` (an Outage Rail event's exact
  // timestamp) and shows its readout. Silently no-ops if the Trend chart
  // isn't rendered yet or `ts` falls outside the current window — a rail
  // click for a day the Trend line doesn't cover isn't an error, just
  // nothing to point at up there.
  _highlightTrendAt(ts, pointOverride) {
    const st = this._trendHoverState;
    const pin = document.getElementById('avbTrendPin');
    if (!st || !pin || typeof ts !== 'number' || !st.pts || !st.pts.length) { this._clearTrendHighlight(); return; }
    if (!pointOverride && (ts < st.startTs - 1 || ts > st.startTs + st.windowSec + 1)) { this._clearTrendHighlight(); return; }
    let best = -1;
    if (pointOverride && st.pts) {
      best = st.pts.indexOf(pointOverride);
    }
    if (best === -1) {
      let bd = Infinity;
      for (let i = 0; i < st.pts.length; i++) {
        const d = Math.abs(st.pts[i].ts - ts);
        if (d < bd) { bd = d; best = i; }
      }
    }
    if (best === -1 || !st.coords[best] || !st.pts[best]) { this._clearTrendHighlight(); return; }
    const [cx, cy] = st.coords[best];
    const p = st.pts[best];
    pin.querySelector('.avb-trend-cross').style.left = `${cx}%`;
    const dot = pin.querySelector('.avb-trend-dot');
    dot.style.left = `${cx}%`;
    dot.style.top = `${cy}%`;
    const tip = pin.querySelector('.avb-trend-tip');
    tip.textContent = `${this._trendTsLabel(Math.min(p.ts, st.endTs), st.windowSec)} · ${p.availability_pct.toFixed(2)}%${this._trendWhyText(p, st)}`;
    tip.style.left = `${cx}%`;
    tip.style.top = `${cy}%`;
    tip.classList.toggle('flip-x', cx > 62);
    tip.classList.toggle('edge-left', cx < 38);
    tip.classList.toggle('flip-y', cy < 22);
    pin.classList.remove('hidden');
  }

  _clearTrendHighlight() {
    const pin = document.getElementById('avbTrendPin');
    if (pin) pin.classList.add('hidden');
    const evd = document.getElementById('avbTrendEventDetail');
    if (evd) {
      evd.classList.add('hidden');
      evd.innerHTML = '';
    }
  }

  // Shared click-drag-to-zoom for an SVG time-series plot. `domain` is
  // exactly `{lo, hi}` — the span THIS render drew the line/ticks against,
  // already clamped to whatever's actually on screen (zoomed or not; the
  // caller does the clamping, this never re-derives it). `onZoom(lo, hi)`
  // fires for a real drag (>=3px and >=30s), `onClick(ts)` for a plain
  // click. Listeners bind once per element regardless of how many times the
  // plot is re-rendered, but `domain` itself must NOT be — every re-render
  // (a poll tick, a Calendar day click, the Today button, a drag-zoom) passes
  // a fresh domain reflecting the window actually on screen right now.
  // Stashing it on the element (refreshed on every call, bind-or-not)
  // instead of closing over the first call's `domain` parameter is what
  // makes a click after any re-zoom land on the timestamp actually under
  // the cursor, instead of one computed against whatever window was loaded
  // first. `domain` must be a single flat range, never a "full range plus a
  // separately-tracked zoom sub-range" pair — two numbers that are supposed
  // to represent the same span but come from different variables are two
  // numbers that WILL eventually drift apart (that was the previous bug:
  // draw used the clamped span, click-mapping used the raw one).
  _attachZoomDrag(plotEl, domain, onZoom, onClick) {
    if (!plotEl) return;
    plotEl.__avbZoomDomain = domain;
    plotEl.__avbOnZoom = onZoom;
    plotEl.__avbOnClick = onClick;
    if (plotEl.dataset.zoomBound) return;
    plotEl.dataset.zoomBound = '1';
    const box = document.createElement('div');
    box.className = 'avb-zoom-box hidden';
    plotEl.appendChild(box);
    let dragging = false, dragged = false, startX = 0;
    const tsAtClientX = clientX => {
      const d = plotEl.__avbZoomDomain;
      const r = plotEl.getBoundingClientRect();
      if (!r.width) return d.lo;
      const frac = Math.max(0, Math.min(1, (clientX - r.left) / r.width));
      return d.lo + frac * (d.hi - d.lo);
    };
    plotEl.addEventListener('pointerdown', e => {
      if (e.button !== 0) return;
      dragging = true; dragged = false; startX = e.clientX;
      try { plotEl.setPointerCapture(e.pointerId); } catch (err) { /* not a pointer target yet — fine */ }
    });
    plotEl.addEventListener('pointermove', e => {
      if (!dragging) return;
      const r = plotEl.getBoundingClientRect();
      const x0 = Math.max(0, Math.min(r.width, startX - r.left));
      const x1 = Math.max(0, Math.min(r.width, e.clientX - r.left));
      if (Math.abs(x1 - x0) > 3) {
        dragged = true;
        box.style.left = `${Math.min(x0, x1)}px`;
        box.style.width = `${Math.abs(x1 - x0)}px`;
        box.classList.remove('hidden');
      }
    });
    const finish = e => {
      if (!dragging) return;
      dragging = false;
      box.classList.add('hidden');
      if (dragged) {
        const a = tsAtClientX(startX), b = tsAtClientX(e.clientX);
        const lo = Math.min(a, b), hi = Math.max(a, b);
        if (hi - lo >= 30 && typeof plotEl.__avbOnZoom === 'function') {
          plotEl.__avbOnZoom(lo, hi); // ignore a near-zero accidental drag
        }
      } else {
        if (typeof plotEl.__avbOnClick === 'function') {
          plotEl.__avbOnClick(tsAtClientX(e.clientX), e.clientX);
        }
      }
    };
    plotEl.addEventListener('pointerup', finish);
    plotEl.addEventListener('pointercancel', () => { dragging = false; box.classList.add('hidden'); });
  }

  // Pins `ts` as the selected moment for the Trend's event-detail panel and
  // renders its content. `sweep` is always _buildFleetSweep's output, so
  // this can never describe an event differently than the hover tooltip or
  // the Calendar. `windowSec` is the currently-visible span (post-zoom) —
  // used to scale the click-snap tolerance to the zoom level (see
  // _eventDetailHtml) so "click near a boundary" means the same number of
  // PIXELS whether zoomed to a week or to ten minutes.
  _pinEventDetail(containerId, ts, sweep, windowSec, clientX) {
    const el = document.getElementById(containerId);
    if (!el) return;
    if (ts === null || typeof ts !== 'number') {
      el.classList.add('hidden');
      el.innerHTML = '';
      return;
    }
    const st = this._trendHoverState;
    let point = null;
    if (st && Array.isArray(st.pts) && st.pts.length) {
      let bd = Infinity;
      for (let i = 0; i < st.pts.length; i++) {
        const d = Math.abs(st.pts[i].ts - ts);
        if (d < bd) { bd = d; point = st.pts[i]; }
      }
    }
    el.innerHTML = this._eventDetailHtml(ts, sweep, windowSec, st, point);
    el.classList.remove('hidden');
    if (containerId === 'avbTrendEventDetail') this._highlightTrendAt(ts, point);
  }

  // Stable per-occurrence reference (host + exact start second) so an
  // operator can name "this one" and mean the same occurrence every time it
  // comes up again — a DOWN->RECOVERED->DOWN cycle on the same host gets a
  // different ref per cycle since each has its own start_ts. This is NOT the
  // `incidents` table's row id (availability's own math never reads that
  // table — see fleet.py) — it's synthesized from the same interval data the
  // Trend/Calendar already agree on, so it can never point at a different
  // occurrence than what's on screen.
  _evtRef(host, startTs) {
    const s = `${host}@${startTs}`;
    let h = 0;
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
    return 'EVT-' + Math.abs(h).toString(36).toUpperCase().padStart(6, '0').slice(0, 6);
  }

  // One affected host's full chain for the event-detail panel: identity
  // (host, endpoint, role), lifecycle state (DOWN/RECOVERED/ONGOING), the
  // exact down->recovery timestamps, duration, this window's availability
  // impact, and a stable reference. `entries`/`this.data` are the SAME
  // per-target data the Hosts Requiring Attention list and the target drawer
  // read, so impact/role here can never disagree with those.
  //
  // `changeType` ('drop'|'recovery'), when given, names the SPECIFIC
  // boundary this row is about — the badge always reflects that, never the
  // occurrence's overall fate. `isOngoing`/`laterRecoveryTs` describe that
  // overall fate instead (the pill + chain-end), a different question: a
  // row for the DOWN edge of an outage that later recovers must still say
  // "DOWN" (that IS what happened at this edge), while its pill can say
  // "RECOVERED" (it didn't stay down). Conflating the two — deciding the
  // badge from isOngoing instead of changeType — is what let a clicked
  // DOWN tick render as a "RECOVERED" row.
  _evdHostRowHtml({ host, name, job, startTs, endTs, isOngoing, changeType, id, isPrimary, durationOverride, laterRecoveryTs, entries, openStart }) {
    const target = (this.data || []).find(t => t.instance === host);
    const endpoint = target && target.scrapeUrl && target.scrapeUrl !== host ? target.scrapeUrl : null;
    const roleLabel = this._getHostRoleLabel(target, { job });
    const entry = entries.get(host);

    // `startTs` for a carried-in interval is where the WINDOW (or the daily
    // data behind it) starts seeing the outage, not where it actually began —
    // an outage running since well before the window opened was showing as a
    // fresh "DOWN {window-start time}" with a duration measured from that
    // same fake start, understating a real multi-week outage as a few hundred
    // hours. The live poll's `downSince` is the authoritative answer for a
    // STILL-ongoing outage (same value the target drawer's "Down Xh Ym"
    // reads) — but it describes the host's CURRENT down streak, so it must
    // never be borrowed for an already-RECOVERED carried-in row (the host
    // may be down again for an unrelated, more recent reason, or back up
    // entirely). Those just get an honest lower bound instead of a fabricated
    // exact start.
    const liveDownSince = isOngoing && target && typeof target.downSince === 'number' ? target.downSince : null;
    const carriedIn = !!openStart;
    const trueStartTs = carriedIn && liveDownSince && liveDownSince < startTs ? liveDownSince : startTs;
    const startIsExact = !carriedIn || trueStartTs !== startTs;

    const durSec = isOngoing
      ? (carriedIn ? Math.max(0, Date.now() / 1000 - trueStartTs) : (typeof durationOverride === 'number' ? durationOverride : Math.max(0, endTs - startTs)))
      : Math.max(0, endTs - trueStartTs);
    const durTxt = this._formatDowntimeDuration(durSec).replace(' downtime', '')
      + (carriedIn && !startIsExact ? ' (at least)' : '');
    // A carried-in start is, by definition, from a different calendar day
    // than whatever range/day is on screen — a bare "14:23 WIB" reads as
    // "today". Spell out the date for those; same-window drops/recoveries
    // keep the existing bare-time format used everywhere else in this modal.
    const fmtDate = ts => {
      const d = new Date((ts + WIB_OFFSET_SEC) * 1000);
      const mon = d.toLocaleString(undefined, { month: 'short', timeZone: 'UTC' });
      return `${mon} ${d.getUTCDate()}`;
    };
    const startTxt = !carriedIn
      ? `${this._calendarFormatTime(trueStartTs)} WIB`
      : startIsExact
        ? `${fmtDate(trueStartTs)}, ${this._calendarFormatTime(trueStartTs)} WIB`
        : `before ${fmtDate(trueStartTs)}, ${this._calendarFormatTime(trueStartTs)} WIB`;
    const availTxt = entry && typeof entry.availability_pct === 'number'
      ? `${entry.availability_pct.toFixed(2)}%`
      : '—';
    const badgeIsDown = changeType ? changeType === 'drop' : isOngoing;
    const chainEnd = isOngoing
      ? (laterRecoveryTs
        ? `recovers ${this._calendarFormatTime(laterRecoveryTs)} WIB later`
        : 'ongoing')
      : `RECOVERED ${this._calendarFormatTime(endTs)} WIB`;
    const ref = id || this._evtRef(host, startTs);
    return `
      <div class="avb-evd-row${isPrimary ? ' is-primary' : ''}">
        <div class="avb-evd-row-top">
          <span class="avb-evd-badge ${badgeIsDown ? 'is-down' : 'is-rec'}">${badgeIsDown ? 'DOWN' : 'RECOVERED'}</span>
          <span class="avb-evd-host" title="${this._esc(host)}">${this._esc(name)}</span>
          <span class="avb-evd-role">${this._esc(roleLabel)}</span>
          <span class="avb-evd-status-pill ${isOngoing ? 'is-ongoing' : 'is-resolved'}">${isOngoing ? 'ONGOING' : 'RECOVERED'}</span>
        </div>
        ${endpoint ? `<div class="avb-evd-endpoint" title="Probe target">${this._esc(endpoint)}</div>` : ''}
        <div class="avb-evd-chain">
          <span>DOWN ${startTxt}</span>
          <span class="avb-evd-chain-arrow">&rarr;</span>
          <span class="${isOngoing ? 'is-ongoing' : ''}">${chainEnd}</span>
          ${carriedIn ? `<span class="avb-evd-carried" title="This outage was already in progress when the selected window opened — shown duration/start reflect the full outage, not just the visible portion">carried in</span>` : ''}
        </div>
        <div class="avb-evd-meta">
          <span>${durTxt}${isOngoing && !laterRecoveryTs ? ' so far' : ''}</span>
          <span>Impact ${availTxt} this window</span>
          <span class="avb-evd-ref" title="Stable reference for this occurrence — a later DOWN on the same host gets a different one">${ref}</span>
        </div>
      </div>`;
  }

  // Structured detail for a single pinned moment. The closest change to `ts`
  // is THE clicked event — authoritative, read directly off its own interval
  // reference (`c.interval`, attached once in _buildFleetSweep), never
  // re-derived by searching intervals for a host+timestamp match. That
  // re-search was the actual bug: it could resolve to a different host's
  // change, or the wrong occurrence of the same host, whenever two
  // boundaries fell within the same tolerance window — visually you clicked
  // Host A's recovery tick, the panel searched for "some interval near this
  // timestamp" and could come back with Host B's drop instead. A direct
  // object reference removes the search entirely, so there is nothing left
  // to resolve incorrectly.
  //
  // Everything else within tolerance is real, separate context (other hosts
  // changing around the same moment) — shown below the primary row, never
  // blended into it.
  _eventDetailHtml(ts, sweep, windowSec, stOverride, pointOverride) {
    if (!sweep) return '';
    const st = stOverride || this._trendHoverState;
    let point = pointOverride || null;
    const bucketSec = (st && typeof st.bucketSec === 'number') ? st.bucketSec : 3600;

    if (!point && st && Array.isArray(st.pts) && st.pts.length) {
      let bd = Infinity;
      for (let i = 0; i < st.pts.length; i++) {
        const d = Math.abs(st.pts[i].ts - ts);
        if (d < bd) { bd = d; point = st.pts[i]; }
      }
    }

    // 1. Changes that occurred inside this point's bucket (the same slice the hover tooltip explains)
    const bucketStart = point ? (point.ts - bucketSec) : (ts - bucketSec);
    const bucketEnd = point ? point.ts : ts;
    const bucketChanges = sweep.changes.filter(c => c.ts >= bucketStart && c.ts <= bucketEnd);

    // 2. Also check if the user clicked very close to an exact change (within snap tolerance)
    const TOL = Math.max(15, Math.min(300, (windowSec || 86400) * 0.01));
    const tolChanges = sweep.changes.filter(c => Math.abs(c.ts - ts) <= TOL);

    // Combine and deduplicate
    const changeMap = new Map();
    bucketChanges.forEach(c => changeMap.set(c, c));
    tolChanges.forEach(c => changeMap.set(c, c));
    const nearby = [...changeMap.values()];

    nearby.sort((a, b) => {
      const d = Math.abs(a.ts - ts) - Math.abs(b.ts - ts);
      if (d !== 0) return d;
      // Recoveries prioritized over drops if distance is equal
      if (a.type !== b.type) return a.type === 'recovery' ? -1 : 1;
      return a.host < b.host ? -1 : a.host > b.host ? 1 : 0;
    });

    const displayTs = point ? Math.min(point.ts, st?.endTs || Infinity) : ts;
    const timeStr = point ? this._trendTsLabel(displayTs, windowSec) : `${this._calendarFormatTime(ts)} WIB`;
    const entries = this._entriesByHost || new Map();

    if (!nearby.length) {
      const evalTs = point ? point.ts : ts;
      const hostsDown = sweep.hostsDownAt(evalTs);
      if (!hostsDown.length) {
        return `
          <div class="avb-evd-head">
            <span class="avb-evd-time">${timeStr}</span>
            <span class="avb-evd-state is-up">UP</span>
          </div>
          <p class="avb-evd-sub">All monitored hosts up — no drop or recovery in this period</p>`;
      }
      const rows = hostsDown.map(iv => this._evdHostRowHtml({
        host: iv.host, name: iv.name, job: iv.job, id: iv.id,
        startTs: iv.s, isOngoing: true, durationOverride: evalTs - iv.s,
        laterRecoveryTs: iv.isRecovery ? iv.e : null,
        openStart: iv.openStart,
        entries,
      })).join('');
      const incidentTag = hostsDown.length > 1
        ? `<span class="avb-evd-incident-badge" title="Multiple hosts down during this period">INCIDENT</span>` : '';
      return `
        <div class="avb-evd-head">
          <span class="avb-evd-time">${timeStr}</span>
          <span class="avb-evd-state is-down">${hostsDown.length} down</span>
          ${incidentTag}
        </div>
        <p class="avb-evd-sub">Steady — no drop or recovery during this period</p>
        <div class="avb-evd-rows">${rows}</div>`;
    }

    const [primary, ...rest] = nearby;
    const primaryIsOngoing = primary.type === 'recovery' ? false : !primary.interval.isRecovery;
    const primaryRow = this._evdHostRowHtml({
      host: primary.host, name: primary.name, job: primary.interval.job,
      startTs: primary.interval.s, endTs: primary.interval.e,
      changeType: primary.type, isOngoing: primaryIsOngoing,
      id: primary.interval.id, isPrimary: true,
      openStart: primary.interval.openStart,
      entries,
    });
    const restRows = rest.map(c => this._evdHostRowHtml({
      host: c.host, name: c.name, job: c.interval.job,
      startTs: c.interval.s, endTs: c.interval.e,
      changeType: c.type, isOngoing: c.type === 'recovery' ? false : !c.interval.isRecovery,
      id: c.interval.id,
      openStart: c.interval.openStart,
      entries,
    })).join('');
    const incidentTag = nearby.length > 1
      ? `<span class="avb-evd-incident-badge" title="Multiple state changes clustered in this period">INCIDENT</span>` : '';
    const primaryLabel = primary.type === 'drop' ? 'DOWN' : 'RECOVERED';

    return `
      <div class="avb-evd-head">
        <span class="avb-evd-time">${timeStr}</span>
        <span class="avb-evd-state ${primary.type === 'drop' ? 'is-down' : 'is-up'}">${primaryLabel}</span>
        ${incidentTag}
      </div>
      <p class="avb-evd-sub">Selected: ${this._esc(primary.name)} ${primaryLabel.toLowerCase()} at ${this._calendarFormatTime(primary.ts)} WIB${rest.length ? ` · ${rest.length} other change${rest.length === 1 ? '' : 's'} in this period` : ''}</p>
      <div class="avb-evd-rows">${primaryRow}</div>
      ${restRows ? `<div class="avb-evd-rows avb-evd-rows-secondary">${restRows}</div>` : ''}`;
  }

  /* ── Downtime Calendar (day grid, below the Trend chart) ──
     Consumes data.daily from the SAME /api/availability response already
     rendered above by _renderAvailabilityTrend / the hosts list — no fetch
     of its own. Days are WIB calendar days (see helpers._build_daily_downtime);
     every label below reads WIB (UTC+7), never the viewer's local Date
     getters, so a cell's date never drifts a day off from the events grouped
     under it server-side. */
  _calendarSevClass(pct) {
    // Aligned with standard 99.9% SLA threshold and visual legend:
    // >= 99.9%: Good (green)
    // >= 99.0%: Minor / SLA breach (yellow)
    // >= 95.0%: Warning / High downtime (orange)
    // < 95.0%: Critical / Outage (red)
    if (typeof pct !== 'number') return 'ara-sev-warning';
    if (pct < 95.0) return 'ara-sev-critical';
    if (pct < 99.0) return 'ara-sev-orange';
    if (pct < 99.9) return 'ara-sev-warning';
    return 'ara-sev-good';
  }

  _calendarDayLabel(dateStr) {
    const d = new Date(`${dateStr}T00:00:00Z`);
    const wd = d.toLocaleString(undefined, { weekday: 'short', timeZone: 'UTC' });
    const mon = d.toLocaleString(undefined, { month: 'short', timeZone: 'UTC' });
    return `${wd}, ${mon} ${d.getUTCDate()}`;
  }

  _calendarStartLabel(ts) {
    return this._calendarFormatTime(ts);
  }

  _calendarFormatTime(ts, isEnd = false, startTs = 0) {
    if (!ts) return '—';
    const d = new Date((ts + WIB_OFFSET_SEC) * 1000);
    const pad = n => String(n).padStart(2, '0');
    const hh = d.getUTCHours();
    const mm = d.getUTCMinutes();
    if (isEnd && hh === 0 && mm === 0 && ts > startTs) {
      return '24:00';
    }
    return `${pad(hh)}:${pad(mm)}`;
  }

  _calendarTimeInfo(e) {
    if (!e || (!e.start_ts && !e.end_ts)) {
      return {
        rangeStr: '—',
        isAllDay: false,
        incidentCount: 1,
        intervalsDetail: '',
        pattern: 'partial',
        badgeText: 'Partial Outage',
        badgeClass: 'pill-info'
      };
    }

    const dur = e.duration_sec || 0;
    const isAllDay = dur >= 86340 || (e.start_ts && e.end_ts && (e.end_ts - e.start_ts >= 86340));
    const startStr = this._calendarFormatTime(e.start_ts);
    const endStr = this._calendarFormatTime(e.end_ts, true, e.start_ts);
    const count = e.incident_count || (Array.isArray(e.intervals) ? e.intervals.length : 1);

    let rangeStr = `${startStr} – ${endStr}`;
    let isAllDayOutage = false;
    if (isAllDay || (startStr === '00:00' && endStr === '24:00')) {
      rangeStr = '00:00 – 24:00';
      isAllDayOutage = true;
    }

    let pattern = 'partial';
    let badgeText = 'Partial Outage';
    let badgeClass = 'pill-info';

    if (isAllDayOutage) {
      pattern = 'all-day';
      badgeText = '24h Outage';
      badgeClass = 'pill-danger';
    } else if (count > 1) {
      pattern = 'flapping';
      badgeText = `Flapping (${count}x)`;
      badgeClass = 'pill-warning';
    } else if (dur >= 14400) { // >= 4 hours
      pattern = 'major';
      badgeText = 'Major Outage';
      badgeClass = 'pill-orange';
    }

    let intervalsDetail = '';
    if (count > 1 && Array.isArray(e.intervals) && e.intervals.length > 0) {
      const parts = e.intervals.slice(0, 5).map(inv => {
        const s = this._calendarFormatTime(inv.start_ts);
        const en = this._calendarFormatTime(inv.end_ts, true, inv.start_ts);
        const dStr = this._formatDowntimeDuration(inv.duration_sec).replace(' downtime', '');
        return `${s}–${en} (${dStr})`;
      });
      const more = e.intervals.length > 5 ? ` +${e.intervals.length - 5} more` : '';
      intervalsDetail = `${count} incidents: ${parts.join(', ')}${more}`;
    }

    return {
      rangeStr,
      isAllDay: isAllDayOutage,
      incidentCount: count,
      intervalsDetail,
      pattern,
      badgeText,
      badgeClass
    };
  }

  // Worst weekday insight (toggle-only): group by WIB weekday (the date
  // string is already a WIB calendar date), average availability_pct per
  // group — the same basis the cells are colored by —
  // and surface the lowest. Ties keep the first weekday encountered.
  _calendarWorstWeekday(daily) {
    const sums = new Array(7).fill(0), counts = new Array(7).fill(0);
    daily.forEach(d => {
      if (typeof d.availability_pct !== 'number') return;
      const dow = new Date(`${d.date}T00:00:00Z`).getUTCDay();
      sums[dow] += d.availability_pct;
      counts[dow] += 1;
    });
    const names = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    let worstDow = -1, worstAvg = Infinity;
    for (let dow = 0; dow < 7; dow++) {
      if (!counts[dow]) continue;
      const avg = sums[dow] / counts[dow];
      if (avg < worstAvg) { worstAvg = avg; worstDow = dow; }
    }
    return (worstDow < 0 || worstAvg >= 100.0) ? null : names[worstDow];
  }

  _calendarWorstDates(daily, n) {
    return new Set(
      [...daily]
        .filter(d => typeof d.availability_pct === 'number' && (d.availability_pct < 100.0 || (d.hosts_down && d.hosts_down > 0)))
        .sort((a, b) => a.availability_pct - b.availability_pct)
        .slice(0, n)
        .map(d => d.date)
    );
  }

  // WIB midnight of a `daily[].date` string, as an absolute epoch second.
  // The date string is already a WIB calendar date (helpers._build_daily_
  // downtime buckets by WIB day) — 00:00 WIB of that date is 7h *before*
  // what `${date}T00:00:00Z` parses to, since that literal string is UTC
  // midnight of the same calendar digits.
  _wibDayStartTs(dateStr) {
    return Date.parse(`${dateStr}T00:00:00Z`) / 1000 - WIB_OFFSET_SEC;
  }

  // Retargets the Trend chart to one WIB calendar day — the Calendar's whole
  // job is picking this date, and "today" is just this called with today's
  // WIB date. Never fetches: _calendarDayWindow clips to whatever window is
  // already loaded (trend_start_ts/trend_end_ts), so this can't race a poll
  // or an in-flight load, and _renderAvailabilityTrend persists _trendZoom
  // across every later re-render (poll ticks included) until explicitly reset.
  _zoomTrendToWibDay(dateStr) {
    this._clearTrendHighlight();
    const dayStart = this._wibDayStartTs(dateStr);
    this._trendZoom = this._calendarDayWindow(dayStart);
    this._renderAvailabilityTrend(this._lastAvailabilityData, this._trendZoom);
    document.getElementById('avbTrendPlot')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  _todayWibDateStr() {
    const d = new Date((Date.now() / 1000 + WIB_OFFSET_SEC) * 1000);
    const pad = n => String(n).padStart(2, '0');
    return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  }

  // Single source of truth for "what was down, when, exactly" across the
  // whole payload — built once from data.daily[].events[].intervals, the
  // same merged, second-precision intervals the backend already computed.
  // Trend hover, the Outage Rail, and the Affected Hosts table all read
  // THIS, so a 15:45–16:32 outage is one continuous event everywhere, never
  // two hourly blocks, and the three views can never disagree about a
  // timestamp, a host, or a duration.
  //
  // Cross-day outages (still open at a WIB day's last bucket) are re-merged
  // across the day seam here using the carried_in/still_down flags the
  // backend attaches per interval, the same way helpers._build_daily_
  // downtime merges intervals within a day.
  //
  // Returns:
  //   intervals — [{host, name, job, s, e, openStart, openEnd}], sorted by s,
  //               clipped to [lo, hi]
  //   changes   — [{ts, host, name, type: 'drop'|'recovery'}], sorted by ts
  //   steps     — [{ts, down}], a step function of fleet down-count over
  //               [lo, hi]; down-count is constant between consecutive ts
  //   downAt(ts), hostsDownAt(ts) — O(n) lookups against `intervals`
  _buildFleetSweep(daily, lo, hi) {
    lo = typeof lo === 'number' ? lo : -Infinity;
    hi = typeof hi === 'number' ? hi : Infinity;

    const perHost = new Map();
    (daily || []).forEach(day => {
      (day.events || []).forEach(e => {
        const ivs = (Array.isArray(e.intervals) && e.intervals.length)
          ? e.intervals
          : (e.start_ts ? [{ start_ts: e.start_ts, end_ts: e.end_ts, carried_in: false, still_down: false }] : []);
        const list = perHost.get(e.instance) || [];
        ivs.forEach(iv => {
          if (!iv.start_ts) return;
          const s = iv.start_ts, en = iv.end_ts || iv.start_ts;
          const openStart = !!iv.carried_in;
          const openEnd = !!iv.still_down;
          const last = list[list.length - 1];
          if (last && last.openEnd && openStart && s - last.e <= 3600) {
            // Same host, touching across a day seam (yesterday's last bucket
            // was still down, today's first bucket opened already down) —
            // one interval, not two.
            last.e = Math.max(last.e, en);
            last.openEnd = openEnd;
            return;
          }
          list.push({ s, e: en, openStart, openEnd, host: e.instance, name: e.name || e.instance, job: e.job });
        });
        perHost.set(e.instance, list);
      });
    });

    const intervals = [];
    perHost.forEach(list => {
      list.forEach(iv => {
        const cs = Math.max(iv.s, lo), ce = Math.min(iv.e, hi);
        if (ce <= cs) return;
        // A boundary only counts as a real drop/recovery when the window
        // actually shows the RAW edge (iv.s/iv.e, not the clipped cs/ce) AND
        // the backend didn't already flag it as a continuation. Comparing
        // clipped-edge proximity to lo/hi (the old approach) breaks the
        // moment "now" drifts even a few seconds past the last materialized
        // bucket — completely normal, since buckets aggregate ~60s behind
        // live — because a genuinely still-down host's clipped end then sits
        // just short of `hi`, and the still-down flag got silently
        // overridden into a false "recovery". Checking the raw bound against
        // lo/hi sidesteps that entirely: still_down alone decides recovery,
        // never how close the clip happened to land next to the window edge.
        // `id` is this occurrence's stable identity (host + its true start
        // second, never the clipped one) — computed once here so every
        // change/lookup derived from this SAME interval object shares
        // exactly one id, instead of each caller re-deriving its own.
        intervals.push({
          id: this._evtRef(iv.host, iv.s), host: iv.host, name: iv.name, job: iv.job, s: cs, e: ce,
          isDrop: iv.s >= lo && !iv.openStart,
          isRecovery: iv.e <= hi && !iv.openEnd,
          // Carried straight through from the per-day merge: true when `cs`
          // is NOT the real start of the outage, just where this window (or
          // the daily data feeding it) starts seeing it. Consumers that
          // narrate "DOWN since {s}" must check this first — otherwise an
          // outage that began long before the window opened gets displayed
          // (and its duration computed) as if it started exactly at the
          // window boundary. See _evdHostRowHtml.
          openStart: !!iv.openStart,
          openEnd: !!iv.openEnd,
        });
      });
    });
    intervals.sort((a, b) => a.s - b.s);

    // Each change carries a DIRECT reference to the interval that produced
    // it — the detail panel reads `c.interval` straight off the clicked
    // change, never re-searching `intervals` by host+timestamp proximity.
    // That re-search was the root cause of a real class of bugs: a click
    // resolved via "closest interval boundary within 1s" instead of "the
    // exact interval this tick was drawn for" could occasionally pick a
    // neighboring occurrence (same host, a different DOWN/RECOVERED cycle
    // moments away) — same failure shape as picking the wrong element when
    // two DOM nodes overlap. A direct reference makes that class of mismatch
    // structurally impossible, not just less likely.
    const changes = [];
    intervals.forEach(iv => {
      if (iv.isDrop) changes.push({ ts: iv.s, host: iv.host, name: iv.name, type: 'drop', interval: iv });
      if (iv.isRecovery) changes.push({ ts: iv.e, host: iv.host, name: iv.name, type: 'recovery', interval: iv });
    });
    changes.sort((a, b) => a.ts - b.ts);

    // Sweep once, left to right: each interval only ever touches its own two
    // boundaries, so this is O(n log n) (the sort), never O(intervals² ).
    const delta = new Map();
    intervals.forEach(iv => {
      delta.set(iv.s, (delta.get(iv.s) || 0) + 1);
      delta.set(iv.e, (delta.get(iv.e) || 0) - 1);
    });
    const bounds = [...delta.keys()].sort((a, b) => a - b);
    let running = 0;
    const steps = [];
    if (isFinite(lo)) steps.push({ ts: lo, down: 0 });
    bounds.forEach(ts => {
      running += delta.get(ts);
      steps.push({ ts, down: Math.max(0, running) });
    });
    if (isFinite(hi) && (!steps.length || steps[steps.length - 1].ts < hi)) {
      steps.push({ ts: hi, down: running });
    }

    return {
      intervals, changes, steps,
      downAt(ts) {
        let n = 0;
        for (const iv of intervals) { if (iv.s <= ts && ts < iv.e) n++; }
        return n;
      },
      hostsDownAt(ts) {
        return intervals.filter(iv => iv.s <= ts && ts < iv.e);
      },
    };
  }

  // The "why did it move" fragment appended to the Trend hover tooltip.
  // Reads the SAME fleet sweep the Outage Rail draws from (_buildFleetSweep,
  // built once for the whole window), so it can never describe a different
  // set of events for the same moment — exact drops/recoveries within
  // [p.ts, p.ts+bucket), whatever the trend's bucket width happens to be
  // (hourly for 24h/7d, a few hours for 30d).
  _trendWhyText(p, st) {
    const bucketStart = p.ts - st.bucketSec;
    const bucketEnd = p.ts;
    const changesHere = st.sweep.changes.filter(c => c.ts >= bucketStart && c.ts <= bucketEnd);
    const downCount = Math.max(st.sweep.downAt(p.ts), st.sweep.downAt(bucketStart));
    if (downCount === 0 && !changesHere.length) return '';
    const drops = changesHere.filter(c => c.type === 'drop').length;
    const recs = changesHere.filter(c => c.type === 'recovery').length;
    if (drops || recs) {
      const parts = [];
      if (drops) parts.push(`${drops} dropped`);
      if (recs) parts.push(`${recs} recovered`);
      return ` — ${parts.join(', ')}`;
    }
    if (downCount > 0) return ` — ${downCount} host${downCount === 1 ? '' : 's'} down, steady`;
    return '';
  }

  // The portion of a WIB calendar day the selected range actually covers,
  // as [lo, hi] absolute seconds — never wider than [dayStartTs,
  // dayStartTs+86400]. A 24h range straddles two calendar days, so the
  // older day's early hours were never queried; drawing that stretch as flat
  // "nothing was down" would be a lie the range dropdown contradicts.
  // trend_start_ts/trend_end_ts are the same window the whole payload was
  // computed over (engine._build_payload).
  _calendarDayWindow(dayStartTs) {
    const d = this.availabilityBreakdown || {};
    const ws = typeof d.trend_start_ts === 'number' ? d.trend_start_ts : dayStartTs;
    const we = typeof d.trend_end_ts === 'number' ? d.trend_end_ts : dayStartTs + 86400;
    return { lo: Math.max(dayStartTs, ws), hi: Math.min(dayStartTs + 86400, we) };
  }

  _renderDowntimeCalendar(data) {
    const gridEl = document.getElementById('avbCalendarGrid');
    if (!gridEl) return;

    const daily = Array.isArray(data && data.daily) ? data.daily : [];
    this._calendarDaily = daily;

    if (!data && this._availLoading) {
      gridEl.innerHTML = '<div class="de-empty">Loading downtime calendar...</div>';
      return;
    }
    if (daily.length === 0) {
      gridEl.innerHTML = '<div class="de-empty">No calendar data for this range yet.</div>';
      return;
    }

    // Selected day may have scrolled out of the window on a range change.
    if (this._calendarOpenDate && !daily.some(d => d.date === this._calendarOpenDate)) {
      this._calendarOpenDate = null;
    }

    const worstOn = !!this._calendarWorstOn;
    const worstDates = worstOn ? this._calendarWorstDates(daily, 3) : null;

    // Calendar weekday offset (Monday-first grid: 0=Mon, ..., 6=Sun)
    let emptyCellsHtml = '';
    let dayCellsHtml = '';
    if (daily.length > 0) {
      const dailyMap = new Map(daily.map(d => [d.date, d]));
      const firstDate = new Date(`${daily[0].date}T00:00:00Z`);
      const lastDate = new Date(`${daily[daily.length - 1].date}T00:00:00Z`);
      const firstDow = firstDate.getUTCDay(); // 0 = Sun, 1 = Mon, ..., 6 = Sat
      const leadingOffset = (firstDow + 6) % 7;
      if (leadingOffset > 0) {
        emptyCellsHtml = Array.from({ length: leadingOffset }, () =>
          '<div class="avb-calendar-cell is-empty" aria-hidden="true"></div>'
        ).join('');
      }

      const cells = [];
      let cur = new Date(firstDate.getTime());
      while (cur <= lastDate) {
        const y = cur.getUTCFullYear();
        const m = String(cur.getUTCMonth() + 1).padStart(2, '0');
        const day = String(cur.getUTCDate()).padStart(2, '0');
        const dateStr = `${y}-${m}-${day}`;
        const dayNum = cur.getUTCDate();
        const d = dailyMap.get(dateStr);

        if (d) {
          const sevClass = this._calendarSevClass(d.availability_pct);
          const isSelected = d.date === this._calendarOpenDate;
          const isWorst = worstOn && worstDates && worstDates.has(d.date);
          const availPctTxt = typeof d.availability_pct === 'number' ? `${d.availability_pct.toFixed(1)}%` : '—';
          const availPctPrecise = typeof d.availability_pct === 'number' ? `${d.availability_pct.toFixed(2)}%` : '—';
          const tooltip = `${d.date}: ${availPctPrecise} availability${d.hosts_down ? `, ${d.hosts_down} host${d.hosts_down === 1 ? '' : 's'} down` : ''}`;
          cells.push(`
            <button type="button" class="avb-calendar-cell ${sevClass}${isSelected ? ' is-selected' : ''}${isWorst ? ' is-worst' : ''}"
                    data-date="${d.date}"
                    title="${tooltip}"
                    aria-label="${this._calendarDayLabel(d.date)}, ${availPctPrecise} availability, ${d.hosts_down} host${d.hosts_down === 1 ? '' : 's'} down"
                    aria-pressed="${isSelected}">
              <span class="avb-calendar-date-num">${dayNum}</span>
              <span class="avb-calendar-avail-pct">${availPctTxt}</span>
              ${d.hosts_down ? `<span class="avb-calendar-badge" title="${d.hosts_down} host${d.hosts_down === 1 ? '' : 's'} were down at some point on this day">${d.hosts_down}<span class="avb-calendar-badge-unit"> hosts</span></span>` : ''}
            </button>`);
        } else {
          cells.push(`
            <div class="avb-calendar-cell is-empty" aria-hidden="true" title="${dateStr}: No data">
              <span class="avb-calendar-date-num">${dayNum}</span>
              <span class="avb-calendar-avail-pct">—</span>
            </div>`);
        }
        cur.setUTCDate(cur.getUTCDate() + 1);
      }
      dayCellsHtml = cells.join('');
    }

    gridEl.innerHTML = emptyCellsHtml + dayCellsHtml;

    const toggleBtn = document.getElementById('avbCalendarWorstToggle');
    if (toggleBtn) {
      toggleBtn.classList.toggle('is-active', worstOn);
      toggleBtn.setAttribute('aria-pressed', String(worstOn));
      // Offering to highlight "3 worst days" out of 2 is nonsense, and on a
      // 24h range there is nothing to rank at all (audit 5.2).
      const rankable = daily.length >= 4;
      toggleBtn.classList.toggle('hidden', !rankable);
      if (!rankable && worstOn) {
        this._calendarWorstOn = false;
      }
    }

    // A MON–SUN grid drawn for a 24h range is mostly empty cells, which reads
    // as missing data rather than "your range only covers two days" (audit
    // 5.1). Say what the grid is showing instead of leaving it to be guessed.
    const captionEl = document.getElementById('avbCalendarCaption');
    if (captionEl) {
      const dayWord = daily.length === 1 ? 'day' : 'days';
      captionEl.textContent = daily.length < 7
        ? `Showing ${daily.length} ${dayWord} in the selected range — empty cells are outside it. Badge = hosts down at any point that day.`
        : 'Badge = hosts down at any point that day (not hosts down now).';
    }
    const insightEl = document.getElementById('avbCalendarWeekdayInsight');
    if (insightEl) {
      const worstWeekday = worstOn ? this._calendarWorstWeekday(daily) : null;
      insightEl.textContent = worstWeekday ? `Most downtime: ${worstWeekday}` : '';
      insightEl.classList.toggle('hidden', !worstWeekday);
    }

    const subScopeEl = document.getElementById('avbCalendarSubScope');
    if (subScopeEl) {
      const jobLabel = (this.selectedJob && this.selectedJob !== 'all') ? `job: ${this.selectedJob}` : 'all jobs';
      subScopeEl.textContent = `· ${jobLabel} · selected range`;
    }
  }

  // Cell click: the Calendar's only job is picking a date for the Trend —
  // same click again deselects and resets the Trend to the full range.
  // Delegated handler lives in dashboard.js.
  _toggleCalendarDay(dateStr) {
    const wasSelected = this._calendarOpenDate === dateStr;
    this._calendarOpenDate = wasSelected ? null : dateStr;
    this._renderDowntimeCalendar(this.availabilityBreakdown);
    this._clearTrendHighlight();
    if (wasSelected) {
      this._trendZoom = { lo: null, hi: null };
      this._renderAvailabilityTrend(this._lastAvailabilityData);
    } else {
      this._zoomTrendToWibDay(dateStr);
    }
  }

  _toggleCalendarWorst() {
    this._calendarWorstOn = !this._calendarWorstOn;
    this._renderDowntimeCalendar(this.availabilityBreakdown);
  }

  // Shared host-detail navigation for any instance string, wherever it's
  // clicked from (Hosts Requiring Attention row, calendar detail panel row).
  // `events[].instance` is the same raw instance id `this.data` is keyed by
  // (see _build_daily_downtime: name === instance, same as entries[] today),
  // so this is exactly the Hosts Requiring Attention row lookup, unchanged.
  _openHostFromInstance(inst) {
    if (!inst) return;
    const target = this.data.find(t => t.instance === inst) || { instance: inst, job: 'blackbox' };
    this._closeAvailabilityBreakdown();
    this._openDrawer(target);
  }

  _renderAvailabilityBreakdown(source = 'direct') {
    const data = this.availabilityBreakdown;
    const expectedMins = Math.round(this.periodMinutes);
    const currentJobKey = (this.selectedJob && this.selectedJob !== 'all') ? this.selectedJob : 'all';
    const isMatchingData = data &&
      Math.round(data.period_minutes || 0) === expectedMins &&
      ((data.job || 'all') === currentJobKey);

    this._updateAvailLoadingUI(this._availLoading && !isMatchingData);

    const modalSubtitleEl = document.getElementById('availModalSubtitle');
    if (modalSubtitleEl) {
      const jobName = (this.selectedJob && this.selectedJob !== 'all') ? this.selectedJob : null;
      if (jobName) {
        modalSubtitleEl.innerHTML = `Historical availability for job: <span class="avb-job-scope-pill">${this._esc(jobName)}</span>`;
      } else {
        modalSubtitleEl.textContent = 'Historical availability across all infrastructure.';
      }
    }

    // Render the audit pane + trend chart FIRST — the ranking code below has
    // several early returns (no entries, healthy fleet -> empty attention list)
    // that would otherwise skip these and leave stale content after a poll.
    this._renderTelemetryAudit();
    this._renderAvailabilityTrend(data);
    this._renderDowntimeCalendar(data);

    // 1. Fleet Availability (Card 1)
    const fleetAvail = (data?.fleet_aggregate && typeof data.fleet_aggregate.value === 'number')
      ? data.fleet_aggregate.value
      : (typeof data?.overall === 'number' ? data.overall : null);

    const aggEl = document.getElementById('metricFleetAggregate');
    const legendUpEl = document.getElementById('legendUptimePct');
    const legendDownEl = document.getElementById('legendDowntimePct');
    // Revamp visuals (presentation only, driven by the same fleet_aggregate value)
    const ringEl = document.getElementById('avbFleetRing');       // donut ring on the Fleet card
    const splitUpEl = document.getElementById('avbHealthyUpBar');  // uptime/downtime split bar on the Healthy Hosts card
    const splitDownEl = document.getElementById('avbHealthyDownBar');
    const RING_CIRCUMFERENCE = 2 * Math.PI * 26; // r = 26 (see .avb-ring markup)

    // Drive the ring via inline style props (strokeDasharray + strokeDashoffset),
    // not setAttribute: an inline style reliably wins the cascade, and the
    // dasharray must be re-asserted here so it exactly matches the computed
    // circumference (the markup's rounded "163.36" left a hairline gap at 100%).
    const setRing = pct => {
      if (!ringEl) return;
      ringEl.style.strokeDasharray = `${RING_CIRCUMFERENCE}`;
      ringEl.style.strokeDashoffset = `${RING_CIRCUMFERENCE * (1 - Math.max(0, Math.min(100, pct)) / 100)}`;
    };

    if (fleetAvail !== null) {
      const clamped = Math.max(0, Math.min(100, fleetAvail));
      const upPctStr = `${fleetAvail.toFixed(2)}%`;
      const downPct = Math.max(0, 100 - fleetAvail);
      const downPctStr = `${downPct.toFixed(2)}%`;

      if (aggEl) aggEl.textContent = upPctStr;
      if (legendUpEl) legendUpEl.textContent = upPctStr;
      if (legendDownEl) legendDownEl.textContent = downPctStr;
      setRing(clamped);
      if (splitUpEl) splitUpEl.style.width = `${clamped.toFixed(2)}%`;
      if (splitDownEl) splitDownEl.style.width = `${(100 - clamped).toFixed(2)}%`;
    } else {
      if (aggEl) aggEl.textContent = '—';
      if (legendUpEl) legendUpEl.textContent = '—';
      if (legendDownEl) legendDownEl.textContent = '—';
      setRing(0);
      if (splitUpEl) splitUpEl.style.width = '0%';
      if (splitDownEl) splitDownEl.style.width = '0%';
    }

    // Fleet-level data confidence warning — the headline % is real math over
    // whatever got observed, but for a young Prometheus/DB (retention just
    // started, SQLite not backfilled yet) a "7d"/"30d" window can be built
    // from a few hours of actual samples. Surface that instead of letting
    // the big number imply full-window confidence it doesn't have.
    const warnEl = document.getElementById('metricFleetDataWarning');
    const warnTextEl = document.getElementById('metricFleetDataWarningText');
    if (warnEl) {
      const covPct = typeof data?.coverage_percent === 'number' ? data.coverage_percent : null;
      const status = data?.data_status;
      const isLimited = status === 'INSUFFICIENT_DATA' || status === 'PARTIAL' || (covPct !== null && covPct < 50);
      if (fleetAvail !== null && isLimited && covPct !== null) {
        // Set only the text span's content — warnEl is a <button> with its
        // own icon span (ahw-icon, rendered separately) and a "View
        // telemetry audit" action span alongside this one; overwriting the
        // whole button's textContent used to wipe both of those out every
        // refresh, and prefixing this string with its own "⚠" used to draw
        // the warning glyph twice.
        if (warnTextEl) warnTextEl.textContent = `Limited data — only ${covPct.toFixed(1)}% of this window observed`;
        warnEl.hidden = false;
      } else {
        warnEl.hidden = true;
      }
    }

    // 2. Healthy Hosts (Card 2)
    // Denominator = every monitored host (server_count), NOT just the ones with
    // telemetry: a host we have no data for is not demonstrably "healthy", and
    // "41 / 50" next to "View all (51)" / "51 hosts" elsewhere reads as a bug.
    // The % is recomputed from the same two numbers so the headline and the
    // sub-label can never disagree.
    const healthyCount = data?.health_ratio?.healthy_count ?? data?.healthy_hosts_count ?? null;
    const totalCount = data?.health_ratio?.server_count
      ?? data?.health_ratio?.total_count
      ?? data?.counts?.total
      ?? (data?.entries ? data.entries.length : null);

    const healthEl = document.getElementById('metricHealthRatio');
    const healthyCountEl = document.getElementById('metricHealthyHostsCount');
    const healthyNoteEl = document.getElementById('metricHealthyHostsNote');

    if (healthyCount !== null && typeof totalCount === 'number' && totalCount > 0) {
      const healthyPct = (healthyCount / totalCount) * 100;
      if (healthEl) healthEl.textContent = `${healthyCount} / ${totalCount}`;
      if (healthyCountEl) healthyCountEl.textContent = `${healthyPct.toFixed(2)}% healthy`;
    } else {
      if (healthEl) healthEl.textContent = '—';
      if (healthyCountEl) healthyCountEl.textContent = '— healthy';
    }
    // The denominator above folds in hosts no longer monitored (deleted,
    // renamed, or dropped from Prometheus) that still have telemetry inside
    // this window — see _reincorporate_removed_targets. Without this line
    // "205 / 307" next to a dashboard reading "228 Total Hosts" looks like a
    // bug instead of the deliberate "don't erase a chronically-down host's
    // history just because it's gone" behavior it actually is.
    if (healthyNoteEl) {
      const removedCount = data?.counts?.removed || 0;
      healthyNoteEl.textContent = removedCount > 0
        ? `Never went down in this range · includes ${removedCount} host${removedCount === 1 ? '' : 's'} no longer monitored`
        : 'Never went down in this range';
    }

    // Keep hidden secondary metrics updated for test/DOM compatibility
    const avgEl = document.getElementById('metricFleetAverage');
    if (avgEl) avgEl.textContent = (data?.fleet_average?.value !== null && typeof data?.fleet_average?.value === 'number') ? `${data.fleet_average.value.toFixed(2)}%` : '—';
    const slaEl = document.getElementById('metricSlaCompliance');
    if (slaEl) slaEl.textContent = (data?.sla_compliance_ratio?.value !== null && typeof data?.sla_compliance_ratio?.value === 'number') ? `${data.sla_compliance_ratio.value.toFixed(2)}%` : '—';
    const covRatioEl = document.getElementById('metricCoverageRatio');
    if (covRatioEl) covRatioEl.textContent = (data?.coverage_ratio?.value !== null && typeof data?.coverage_ratio?.value === 'number') ? `${data.coverage_ratio.value.toFixed(2)}%` : '—';

    // 3. Hosts Requiring Attention
    const listEl = document.getElementById('hostsRequiringAttentionList');
    if (!listEl) return;

    if (!data && this._availLoading) {
      listEl.innerHTML = '<div class="de-empty" style="padding: 24px; text-align: center; color: var(--text-secondary);"><span class="avail-updating-spinner" style="margin-right:8px;"></span> Loading host availability data...</div>';
      return;
    }

    const rawEntries = (data && Array.isArray(data.entries)) ? data.entries
      : (data && data.per_server && Array.isArray(data.per_server.values) ? data.per_server.values : []);

    if (rawEntries.length === 0) {
      listEl.innerHTML = '<div class="de-empty" style="padding: 24px; text-align: center; color: var(--text-secondary);">No monitored hosts found.</div>';
      return;
    }

    // Normalizing and preparing entries
    const processedHosts = rawEntries.map(e => {
      const avail = typeof e.availability_pct === 'number' ? e.availability_pct : null;
      const downMin = typeof e.downtime_minutes === 'number' ? e.downtime_minutes : 0;
      const downSec = typeof e.downtime_seconds === 'number' ? e.downtime_seconds : (downMin * 60);
      const inc = parseInt(e.incidents || e.incident_count || 0, 10) || 0;
      const covPct = typeof e.coverage_percent === 'number' ? e.coverage_percent : (typeof e.coverage_pct === 'number' ? e.coverage_pct : 0);
      const obsSec = typeof e.observed_seconds === 'number' ? e.observed_seconds : ((e.observed_minutes || e.coverage_minutes || 0) * 60);

      const isNoData = obsSec <= 0 || avail === null;
      const isLimitedData = !isNoData && (covPct < 50);

      return {
        id: e.id || e.name,
        name: e.name || e.id || '—',
        job: e.job || '',
        availability: avail,
        downtimeDurationSeconds: downSec,
        incidentCount: inc,
        coveragePercent: covPct,
        observedDurationSeconds: obsSec,
        isNoData: isNoData,
        isLimitedData: isLimitedData,
        rawEntry: e
      };
    });

    const sortMode = this._breakdownSort || 'avail_asc';

    // Synchronize custom dropdown trigger label & active items
    const sortLabels = {
      avail_asc: 'Lowest Availability',
      incidents_desc: 'Most Incidents',
      downtime_desc: 'Longest Downtime',
      avail_desc: 'Highest Availability',
      name_asc: 'Host Name (A-Z)',
      name_desc: 'Host Name (Z-A)'
    };

    const triggerTextEl = document.getElementById('availSortTriggerText');
    if (triggerTextEl) {
      triggerTextEl.textContent = sortLabels[sortMode] || 'Lowest Availability';
    }

    const sortMenuEl = document.getElementById('availSortMenu');
    if (sortMenuEl) {
      sortMenuEl.querySelectorAll('.avail-sort-item').forEach(item => {
        const isSelected = item.dataset.value === sortMode;
        item.classList.toggle('is-active', isSelected);
        item.setAttribute('aria-selected', String(isSelected));
      });
    }

    const subtitleEl = document.getElementById('availAttentionSubtitle');
    if (subtitleEl) {
      const subtitleMap = {
        avail_asc: 'Sorted by lowest availability (ascending)',
        avail_desc: 'Sorted by highest availability (descending)',
        incidents_desc: 'Sorted by most incidents (descending)',
        downtime_desc: 'Sorted by longest downtime (descending)',
        name_asc: 'Sorted by host name (A to Z)',
        name_desc: 'Sorted by host name (Z to A)'
      };
      subtitleEl.textContent = subtitleMap[sortMode] || 'Sorted by availability (ascending)';
    }

    const arrowName = document.getElementById('sortArrowName');
    const arrowAvail = document.getElementById('sortArrowAvail');
    const arrowImpact = document.getElementById('sortArrowImpact');
    const btnName = document.querySelector('.ath-sort-btn[data-sort-key="name"]');
    const btnAvail = document.querySelector('.ath-sort-btn[data-sort-key="avail"]');
    const btnImpact = document.querySelector('.ath-sort-btn[data-sort-key="impact"]');

    if (arrowName) arrowName.textContent = '';
    if (arrowAvail) arrowAvail.textContent = '';
    if (arrowImpact) arrowImpact.textContent = '';
    btnName?.classList.remove('ath-sorted');
    btnAvail?.classList.remove('ath-sorted');
    btnImpact?.classList.remove('ath-sorted');

    if (sortMode === 'name_asc' || sortMode === 'name_desc') {
      btnName?.classList.add('ath-sorted');
      if (arrowName) arrowName.textContent = sortMode === 'name_asc' ? '▲' : '▼';
    } else if (sortMode === 'avail_asc' || sortMode === 'avail_desc') {
      btnAvail?.classList.add('ath-sorted');
      if (arrowAvail) arrowAvail.textContent = sortMode === 'avail_asc' ? '▲' : '▼';
    } else if (sortMode === 'incidents_desc' || sortMode === 'downtime_desc') {
      btnImpact?.classList.add('ath-sorted');
      if (arrowImpact) arrowImpact.textContent = '▼';
    }

    // Dynamic Multi-criteria Sorting
    processedHosts.sort((a, b) => {
      if (sortMode === 'incidents_desc') {
        if (b.incidentCount !== a.incidentCount) return b.incidentCount - a.incidentCount;
        if (b.downtimeDurationSeconds !== a.downtimeDurationSeconds) return b.downtimeDurationSeconds - a.downtimeDurationSeconds;
        const availA = a.availability !== null ? a.availability : 999;
        const availB = b.availability !== null ? b.availability : 999;
        return availA - availB;
      }
      if (sortMode === 'downtime_desc') {
        if (b.downtimeDurationSeconds !== a.downtimeDurationSeconds) return b.downtimeDurationSeconds - a.downtimeDurationSeconds;
        if (b.incidentCount !== a.incidentCount) return b.incidentCount - a.incidentCount;
        const availA = a.availability !== null ? a.availability : 999;
        const availB = b.availability !== null ? b.availability : 999;
        return availA - availB;
      }
      if (sortMode === 'avail_desc') {
        const availA = a.availability !== null ? a.availability : -1;
        const availB = b.availability !== null ? b.availability : -1;
        if (availA !== availB) return availB - availA;
        if (a.downtimeDurationSeconds !== b.downtimeDurationSeconds) return a.downtimeDurationSeconds - b.downtimeDurationSeconds;
        return a.incidentCount - b.incidentCount;
      }
      if (sortMode === 'name_asc') {
        return (a.name || '').localeCompare(b.name || '', undefined, { numeric: true, sensitivity: 'base' });
      }
      if (sortMode === 'name_desc') {
        return (b.name || '').localeCompare(a.name || '', undefined, { numeric: true, sensitivity: 'base' });
      }
      // Default: 'avail_asc' (Lowest availability first)
      const availA = a.availability !== null ? a.availability : 999;
      const availB = b.availability !== null ? b.availability : 999;
      if (availA !== availB) return availA - availB;
      if (b.downtimeDurationSeconds !== a.downtimeDurationSeconds) return b.downtimeDurationSeconds - a.downtimeDurationSeconds;
      return b.incidentCount - a.incidentCount;
    });

    // Update toggle button text with host counts
    const lbl = document.getElementById('viewAllHostsLabel');
    if (lbl) {
      lbl.textContent = this._showAllHostsInBreakdown ? 'Show top hosts' : `View all (${processedHosts.length})`;
    }

    // Filter to the hosts that actually match the current "attention" lens.
    // If none match, priorityHosts is left empty on purpose so the empty
    // state below renders instead of falling back to showing healthy hosts
    // under a "Hosts Requiring Attention" heading. The "avail_desc" /
    // "name_asc" / "name_desc" modes are plain rankings and keep every host.
    let priorityHosts = processedHosts;
    if (sortMode === 'incidents_desc') {
      priorityHosts = processedHosts.filter(h => h.incidentCount > 0);
    } else if (sortMode === 'downtime_desc') {
      priorityHosts = processedHosts.filter(h => h.downtimeDurationSeconds > 0);
    } else if (sortMode === 'avail_asc') {
      priorityHosts = processedHosts.filter(h => (h.availability !== null && h.availability < 100) || h.downtimeDurationSeconds > 0 || h.incidentCount > 0 || h.isNoData);
    }

    const displayList = this._showAllHostsInBreakdown
      ? processedHosts
      : priorityHosts.slice(0, 5);

    if (displayList.length === 0) {
      const allNoData = processedHosts.length > 0 && processedHosts.every(h => h.isNoData);
      let emptyMsg;
      if (allNoData) {
        emptyMsg = 'No telemetry data recorded for monitored hosts in this time range.';
      } else if (sortMode === 'incidents_desc') {
        emptyMsg = 'No incidents recorded for any monitored host in this time range.';
      } else if (sortMode === 'downtime_desc') {
        emptyMsg = 'No downtime recorded for any monitored host in this time range.';
      } else {
        emptyMsg = 'All monitored hosts currently have 100% availability with zero recorded downtime.';
      }
      listEl.innerHTML = `<div class="de-empty" style="padding: 24px; text-align: center; color: var(--text-secondary);">${emptyMsg}</div>`;
      return;
    }

    // O(1) lookup instead of an O(N) find() per host
    const dataByInstance = new Map(this.data.map(t => [t.instance, t]));
    const rowsHtml = displayList.map(h => {
      const target = dataByInstance.get(h.id) || dataByInstance.get(h.name);
      const roleLabel = this._getHostRoleLabel(target, h);

      // Severity styling — a plain color dot carries the status; the
      // availability % text/color and badges already say what it means, so
      // the dot doesn't need its own glyph on top of that.
      let sevClass = 'ara-sev-good';
      let pctClass = 'pct-good';
      let barClass = 'bar-fill-good';

      if (h.isNoData) {
        sevClass = 'ara-sev-warning';
        pctClass = 'pct-muted';
        barClass = 'bar-fill-warning';
      } else if (h.availability < 60) {
        sevClass = 'ara-sev-critical';
        pctClass = 'pct-critical';
        barClass = 'bar-fill-critical';
      } else if (h.availability < 80) {
        sevClass = 'ara-sev-orange';
        pctClass = 'pct-orange';
        barClass = 'bar-fill-orange';
      } else if (h.availability < 95) {
        sevClass = 'ara-sev-warning';
        pctClass = 'pct-warning';
        barClass = 'bar-fill-warning';
      }

      const availText = h.isNoData ? '—' : `${h.availability.toFixed(2)}%`;
      // A host at 0.00% drew an empty grey track — visually identical to the
      // no-data case, so total failure and missing telemetry looked the same
      // (audit 5.3). Give a real zero a full-width bar in the critical colour;
      // only genuine no-data stays empty.
      const isZeroAvail = !h.isNoData && h.availability <= 0;
      const barWidth = h.isNoData ? 0 : (isZeroAvail ? 100 : Math.max(0, Math.min(100, h.availability)));
      const downtimeText = this._formatDowntimeDuration(h.downtimeDurationSeconds);
      const incidentsText = `${h.incidentCount} incident${h.incidentCount === 1 ? '' : 's'}`;

      let badgeHtml = '';
      if (h.isNoData) {
        badgeHtml = '<span class="ara-nodata-badge">NO DATA</span>';
      } else if (h.isLimitedData) {
        badgeHtml = '<span class="ara-limited-badge" title="Observed duration is < 50% of the selected window">LIMITED DATA</span>';
      }

      // "Hosts Requiring Attention" listed hosts a colleague had already
      // claimed with nothing to say so, so two operators could chase the same
      // outage (audit 4.3). acknowledged/_by/_at ride on the /instances row
      // this list is already joined against.
      let ackHtml = '';
      if (target && target.acknowledged && target.health !== 'up') {
        const who = target.acknowledged_by || 'operator';
        const when = target.acknowledged_at
          ? new Date(target.acknowledged_at * 1000).toLocaleString(DATE_LOCALE)
          : '';
        ackHtml = `<span class="ara-ack-badge" title="${this._esc(when ? `Acknowledged by ${who} at ${when}` : `Acknowledged by ${who}`)}">✓ ACKED</span>`;
      } else if (target && target.health !== 'up' && !target.maintenance && !target.suppressedBy) {
        ackHtml = '<span class="ara-unacked-badge" title="Nobody has acknowledged this outage yet">NEEDS ACK</span>';
      }

      return `
        <div class="ara-row" data-instance="${this._esc(h.id)}" role="button" tabindex="0" title="Click to view host details">
          <!-- Col 1: Host / IP -->
          <div class="ara-host-col">
            <span class="ara-severity-dot ${sevClass}" aria-hidden="true"></span>
            <div class="ara-host-meta">
              <span class="ara-hostname">${this._esc(h.name)}</span>
              <div class="ara-badges-row">
                <span class="ara-job-badge">${this._esc(roleLabel)}</span>
                ${badgeHtml}
                ${ackHtml}
              </div>
            </div>
          </div>

          <!-- Col 2: Availability & Bar -->
          <div class="ara-avail-col">
            <span class="ara-avail-pct ${pctClass}">${availText}</span>
            <div class="ara-bar-container">
              <div class="ara-bar-track">
                <div class="ara-bar-fill ${barClass}${isZeroAvail ? ' is-zero' : ''}" style="width: ${barWidth}%;"></div>
              </div>
            </div>
          </div>

          <!-- Col 3: Impact -->
          <div class="ara-impact-col">
            <div class="ara-impact-info">
              <div class="ara-impact-texts">
                <span class="ara-incidents-text">${incidentsText}</span>
                <span class="ara-downtime-text">${downtimeText}</span>
              </div>
            </div>
            <svg class="ara-chevron" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
              <polyline points="6 3 11 8 6 13"></polyline>
            </svg>
          </div>
        </div>`;
    }).join('');

    listEl.innerHTML = rowsHtml;
  }
}

export function installAvailability(Cls) {
  for (const k of Object.getOwnPropertyNames(_AvailabilityMethods.prototype)) {
    if (k !== 'constructor') Cls.prototype[k] = _AvailabilityMethods.prototype[k];
  }
}
