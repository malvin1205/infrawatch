/* Application shell: owns audio/alarm state, tab switching, endpoint
 * management, and constructs + coordinates the three page objects. */
import { apiFetch } from './net.js';
import { escapeHtml } from './ui/format.js';
import { InstancesPage } from './dashboard.js';
import { LogsPage } from './logs.js';
import { HistoryPage } from './history.js';

/* ════════════════════════════════════════════════════════════════════════════
   MAIN MONITOR (Dashboard + coordination)
   ════════════════════════════════════════════════════════════════════════════ */
// Alarm lifecycle timings (seconds), driven entirely by server timestamps
// (t.downSince, t.acknowledged_at) — see ServerMonitor._alarmPhaseFor(). No
// client-local per-outage flags/timers: every tick recomputes phase fresh
// from those two epoch values, so a refresh, a second tab, or a missed poll
// all converge on the same answer instead of needing to be kept in sync.
const ALARM_DELAY_S = 15;           // new outage: stay silent this long first...
const ALARM_INITIAL_BURST_S = 30;   // ...then alarm for this long
const ALARM_UNACKED_PERIOD_S = 120; // then, while unacked, re-alert every...
const ALARM_UNACKED_BURST_S = 10;   // ...for this long
const ALARM_ACK_COOLDOWN_S = 300;   // once acked: silence for this long...
const ALARM_ACKED_PERIOD_S = 300;   // ...then re-alert every...
const ALARM_ACKED_BURST_S = 10;     // ...for this long, repeating, while still down

export class ServerMonitor {
  constructor() {
    this.isMuted = false;
    this.isInitialized = false;
    this._alarmTickHandle = null;

    // ── DOM refs ──────────────────────────────────
    this.alarmAudio = document.getElementById('alarmAudio');

    // ── Sub-pages ─────────────────────────────────
    this.instancesPage = new InstancesPage(this);
    this.logsPage = new LogsPage(this);
    this.historyPage = new HistoryPage(this);

    this._bindLogsModal();
    this._bindSelfHealthModal();
    this._bindEvents();
    this.initialize();
  }

  /* ── Event binding ─────────────────────────────── */
  _bindEvents() {
    const enterBtn = document.getElementById('enterDashboardBtn');
    const splashOverlay = document.getElementById('splashOverlay');

    if (enterBtn && splashOverlay) {
      enterBtn.addEventListener('click', () => {
        this.unlockAudio();
        splashOverlay.classList.add('splash-hidden');
        try { localStorage.setItem('iw-audio-unlocked', 'true'); } catch (e) { }
        this._syncAlarmAudio();
      });
    }

    const soundBtn = document.getElementById('soundToggleBtn');
    if (soundBtn) {
      soundBtn.addEventListener('click', () => {
        this.toggleSound(this.isMuted); // toggles state
      });
    }

    this._bindBrandLegend();

    // Auto-unlock audio on user's first click or keypress anywhere
    const unlock = () => {
      this.unlockAudio();
      document.removeEventListener('click', unlock);
      document.removeEventListener('keydown', unlock);
    };
    document.addEventListener('click', unlock);
    document.addEventListener('keydown', unlock);
  }

  /* ── Status legend in logo (Variant B) ─────────── */
  _bindBrandLegend() {
    const brandWrap = document.getElementById('brandCluster') || document.querySelector('.topnav-brand');
    const brandBtn = document.getElementById('brandStatusTrigger');
    const legendRibbon = document.getElementById('brandStatusLegend');
    if (!brandBtn || !legendRibbon) return;

    const closeLegend = () => {
      if (!brandWrap.classList.contains('is-open')) return;
      brandWrap.classList.remove('is-open');
      brandBtn.setAttribute('aria-expanded', 'false');
      legendRibbon.setAttribute('aria-hidden', 'true');
    };

    const openLegend = () => {
      brandWrap.classList.add('is-open');
      brandBtn.setAttribute('aria-expanded', 'true');
      legendRibbon.setAttribute('aria-hidden', 'false');
    };

    brandBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (brandWrap.classList.contains('is-open')) {
        closeLegend();
      } else {
        openLegend();
      }
    });

    document.addEventListener('click', (e) => {
      if (!brandWrap.contains(e.target)) {
        closeLegend();
      }
    });

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && brandWrap.classList.contains('is-open')) {
        closeLegend();
      }
    });
  }

  initialize() {
    if (this.isInitialized) return;
    this.isInitialized = true;

    // Auto-bypass splash overlay if audio consent was previously recorded or running in kiosk mode
    const splashOverlay = document.getElementById('splashOverlay');
    if (splashOverlay && (localStorage.getItem('iw-audio-unlocked') === 'true' || (this.audioCtx && this.audioCtx.state === 'running'))) {
      splashOverlay.classList.add('splash-hidden');
      this.unlockAudio();
    }

    this.initEndpointManager();
    this.instancesPage.onActivate();
    this._startAlarmTicker();

    // Poll logs continuously (not just while the modal is open) so the
    // "+N new" nav badge can fire even when the operator is elsewhere —
    // slower cadence in the background, tightened to 5s once the modal opens.
    this.logsPage._startPolling(30000);
    this.logsPage.load();
    this._checkSelfHealth();
    this._selfHealthInterval = setInterval(() => this._checkSelfHealth(), 20000);

    // Kiosk / TV Standby lifecycle management: fully pause every recurring
    // timer while the tab/display is hidden (a backgrounded wallboard was
    // still hammering /instances every 5s, /api/availability every 15s,
    // /health every 20s and ticking 1/s), then resume with one immediate
    // clean sync on wake — no timer accumulation.
    document.addEventListener('visibilitychange', () => {
      const ip = this.instancesPage;
      if (document.visibilityState === 'visible') {
        ip.startPolling(ip.currentInterval);
        ip.startAvailabilityPolling();
        ip.startDownCounterTicker();
        this._startAlarmTicker();
        if (ip.autoRotate) ip._startAutoRotate();
        if (!this._selfHealthInterval) {
          this._selfHealthInterval = setInterval(() => this._checkSelfHealth(), 20000);
        }
        ip.load();
        ip.loadAvailability();
        this._checkSelfHealth();
      } else {
        ip.stopPolling();
        ip.stopAvailabilityPolling();
        ip.stopDownCounterTicker();
        this._stopAlarmTicker();
        ip._stopAutoRotate();
        if (this._selfHealthInterval) {
          clearInterval(this._selfHealthInterval);
          this._selfHealthInterval = null;
        }
      }
    });
  }

  // Phase 13 self-monitoring — reuses /health rather than a second endpoint.
  // Automatic polling is unchanged (still every 20s from initialize()) and
  // /health is still the only data source — this just also feeds the modal
  // below instead of a hover-only tooltip.
  async _checkSelfHealth() {
    const dot = document.getElementById('selfHealthDot');
    const btn = document.getElementById('selfHealthBtn');
    if (!dot || !btn) return;
    try {
      const res = await fetch('/health');
      const data = await res.json();
      this._lastHealthData = data;
      this._lastHealthSuccessAt = new Date();
      dot.style.background = data.ok ? 'var(--success)' : 'var(--critical)';
      btn.title = data.ok ? 'InfraWatch self-status: all systems OK (click for detail)' : 'InfraWatch self-status: degraded (click for detail)';
    } catch (e) {
      this._lastHealthData = null;
      dot.style.background = 'var(--critical)';
      btn.title = 'InfraWatch self-status: unreachable (click for detail)';
    }
    this._renderSelfHealthModal();
  }

  _bindSelfHealthModal() {
    const modal = document.getElementById('selfHealthModal');
    const btn = document.getElementById('selfHealthBtn');
    const closeBtn = document.getElementById('closeSelfHealthModal');
    if (!modal || !btn) return;

    const open = () => {
      modal.classList.remove('hidden');
      if (this._untrapSelfHealth) this._untrapSelfHealth();
      this._untrapSelfHealth = window.trapModalFocus(modal);
      this._checkSelfHealth(); // refresh on open rather than showing a stale snapshot
    };
    const close = () => {
      if (this._untrapSelfHealth) { this._untrapSelfHealth(); this._untrapSelfHealth = null; }
      modal.classList.add('hidden');
    };

    btn.addEventListener('click', open);
    if (closeBtn) closeBtn.addEventListener('click', close);
    modal.addEventListener('click', e => { if (e.target === modal) close(); });
  }

  _renderSelfHealthModal() {
    const list = document.getElementById('selfHealthList');
    const updatedEl = document.getElementById('selfHealthUpdated');
    if (!list) return;

    const data = this._lastHealthData;
    // Each component gets a plain-English note saying what stops working for
    // the operator if it fails. "Storage: OK" alone told them nothing about
    // what was at stake, and this modal answers the most urgent on-call
    // question of all — can I trust what the dashboard is showing me?
    // (audit 6.1)
    const rows = [
      ['Prometheus', 'prometheus', 'The metrics source. If down, no host status is current.'],
      ['Monitoring API', 'monitoring_api', 'Serves this dashboard. If down, the grid stops updating.'],
      ['Alarm Service', 'alarm_service', 'Raises alerts and the siren. If down, outages go unannounced.'],
      ['Storage', 'storage', 'Holds history and SLA data. If down, past incidents are unavailable.'],
    ];
    const c = (data && data.components) || {};
    list.innerHTML = rows.map(([label, key, impact]) => {
      const ok = !!(c[key] && c[key].ok);
      const dotColor = data ? (ok ? 'var(--success)' : 'var(--critical)') : 'var(--text-muted)';
      const stateTxt = data ? (ok ? 'OK' : 'DOWN') : 'Unknown';
      const stateColor = data ? (ok ? 'var(--success)' : 'var(--critical)') : 'var(--text-muted)';
      // Impact line only matters when something is actually wrong or unknown —
      // a healthy list stays as scannable as it was.
      const impactLine = (data && ok)
        ? ''
        : `<div class="self-health-impact">${this._esc ? this._esc(impact) : impact}</div>`;
      return `
        <div class="dil-row self-health-row">
          <span class="dil-label">
            <span style="display:inline-block; width:7px; height:7px; border-radius:50%; background:${dotColor}; margin-right:7px;"></span>${label}
            ${impactLine}
          </span>
          <span class="dil-value" style="color: ${stateColor};">${stateTxt}</span>
        </div>`;
    }).join('');

    if (updatedEl) {
      updatedEl.textContent = this._lastHealthSuccessAt
        ? `Last successful update: ${this._lastHealthSuccessAt.toLocaleTimeString()}`
        : 'Last successful update: never (endpoint unreachable)';
    }
  }



  /* ── Alert Logs / Incident History modal ───────── */
  _bindLogsModal() {
    const modal = document.getElementById('logsModal');
    const openBtn = document.getElementById('openLogsModalBtn');
    const closeBtn = document.getElementById('closeLogsModal');
    const tabs = {
      logs: { btn: document.getElementById('logsTabBtn'), panel: document.getElementById('logsTabPanel') },
      history: { btn: document.getElementById('historyTabBtn'), panel: document.getElementById('historyTabPanel') },
      maintenance: { btn: document.getElementById('maintenanceTabBtn'), panel: document.getElementById('maintenanceTabPanel') },
    };
    if (!modal || !openBtn) return;

    const showTab = (tab) => {
      Object.entries(tabs).forEach(([key, { btn, panel }]) => {
        const active = key === tab;
        if (panel) panel.classList.toggle('hidden', !active);
        if (btn) {
          btn.classList.toggle('chip-active', active);
          btn.setAttribute('aria-selected', String(active));
        }
      });
      if (tab !== 'history') this.historyPage.onDeactivate();
      if (tab === 'logs') this.logsPage.onActivate();
      else if (tab === 'history') this.historyPage.onActivate();
      else if (tab === 'maintenance') this.instancesPage._maintenanceManagerOnActivate();
    };

    Object.entries(tabs).forEach(([key, { btn }]) => {
      if (btn) btn.addEventListener('click', () => showTab(key));
    });

    const openModal = () => {
      modal.classList.remove('hidden');
      if (this._untrapLogs) this._untrapLogs();
      this._untrapLogs = window.trapModalFocus(modal);
      showTab('logs');
    };
    const closeModal = () => {
      if (this._untrapLogs) { this._untrapLogs(); this._untrapLogs = null; }
      modal.classList.add('hidden');
      this.logsPage.onDeactivate();
      this.historyPage.onDeactivate();
    };

    openBtn.addEventListener('click', openModal);
    if (closeBtn) closeBtn.addEventListener('click', closeModal);
    modal.addEventListener('click', e => { if (e.target === modal) closeModal(); });
  }

  /* ── Endpoint Manager ──────────────────────────── */
  async initEndpointManager() {
    const endpointSelect = document.getElementById('endpointSelect');
    const openBtn = document.getElementById('openEndpointModalBtn');
    const closeBtn = document.getElementById('closeEndpointModalBtn');
    const modal = document.getElementById('endpointModal');
    const addForm = document.getElementById('addEndpointForm');
    const urlInput = document.getElementById('endpointUrlInput');
    const errorEl = document.getElementById('addEndpointError');
    const listContainer = document.getElementById('endpointListContainer');

    // Read-only viewers get endpoints.read but not endpoints.write — the
    // server 403s Select/Delete/Add already, but leaving these fully
    // interactive here would let a viewer click something that can only
    // ever fail (same class of bug as ackAlarmBtn — see auth.js).
    const isReadOnlyUser = () => !window.currentUser
      || (window.currentUser.role !== 'admin' && window.currentUser.role !== 'owner');
    const readOnlyTitle = 'Read-only account — sign in as an operator to change this';
    const addSubmitBtn = addForm ? addForm.querySelector('button[type="submit"]') : null;
    if (isReadOnlyUser()) {
      if (urlInput) urlInput.disabled = true;
      if (addSubmitBtn) { addSubmitBtn.disabled = true; addSubmitBtn.title = readOnlyTitle; }
    }

    const fetchEndpoints = async () => {
      try {
        const res = await fetch('/api/endpoints');
        const data = await res.json();
        if (!data.ok) return;

        // Keep InstancesPage's notion of the active endpoint current — it
        // keys the per-endpoint Default Job (restore + save + badge).
        const active = data.endpoints.find(ep => ep.active);
        if (this.instancesPage) this.instancesPage._activeEndpoint = active ? active.url : null;

        // Populate topbar select dropdown
        if (endpointSelect) {
          endpointSelect.innerHTML = '';
          data.endpoints.forEach(ep => {
            const opt = document.createElement('option');
            opt.value = ep.url;
            opt.selected = ep.active;
            const displayUrl = ep.url.replace(/^https?:\/\//, '');
            opt.textContent = `Prometheus: ${displayUrl}${ep.active ? ' (Active)' : ''}`;
            endpointSelect.appendChild(opt);
          });
        }

        // Populate modal list
        if (listContainer) {
          listContainer.innerHTML = '';
          if (data.endpoints.length === 0) {
            listContainer.innerHTML = '<div style="padding:10px; font-size:12px; color:var(--text-secondary);">No Prometheus endpoint configured. Add one above — until then, no metric data is fetched.</div>';
          }
          const readOnly = isReadOnlyUser();
          data.endpoints.forEach(ep => {
            const row = document.createElement('div');
            row.style.cssText = 'display:flex; align-items:center; justify-content:space-between; flex-wrap:wrap; gap:8px; padding:8px 10px; background:var(--surface); border:1px solid var(--border); border-radius:var(--r-sm); font-size:12px; margin-bottom:6px;';
            const statusDot = ep.online ? '<span style="color:#22C55E; margin-right:6px;">● Online</span>' : '<span style="color:#EF4444; margin-right:6px;">● Offline</span>';
            const activeBadge = ep.active ? '<span style="background:var(--accent-bg); color:var(--accent); padding:2px 6px; border-radius:4px; font-size:10px; font-weight:600; margin-left:6px;">ACTIVE</span>' : '';
            const safeUrl = escapeHtml(ep.url);

            row.innerHTML = `
              <div style="display:flex; align-items:center; overflow:hidden; flex:1; min-width:0;">
                ${statusDot}
                <span style="font-family:var(--font-mono); font-weight:500; text-overflow:ellipsis; overflow:hidden; white-space:nowrap; color:var(--text-primary); min-width:0; flex:1;">${safeUrl}</span>
                ${activeBadge}
              </div>
              <div style="display:flex; gap:6px; flex-shrink:0; margin-left:10px; flex-wrap:wrap; justify-content:flex-end;">
                ${!ep.active ? `<button class="btn btn-secondary btn-sm select-ep-btn" data-url="${safeUrl}" style="padding:2px 8px; font-size:11px;" ${readOnly ? `disabled title="${readOnlyTitle}"` : ''}>Select</button>` : ''}
                <button class="btn btn-danger btn-sm del-ep-btn" data-url="${safeUrl}" style="padding:2px 8px; font-size:11px; background:rgba(239,68,68,0.15); color:#EF4444; border:1px solid rgba(239,68,68,0.3);" ${readOnly ? `disabled title="${readOnlyTitle}"` : ''}>Delete</button>
              </div>
            `;
            listContainer.appendChild(row);
          });

          // Bind Select buttons
          listContainer.querySelectorAll('.select-ep-btn').forEach(btn => {
            btn.addEventListener('click', async (e) => {
              const targetUrl = e.currentTarget.dataset.url;
              await selectEndpoint(targetUrl);
            });
          });

          // Bind Delete buttons
          listContainer.querySelectorAll('.del-ep-btn').forEach(btn => {
            btn.addEventListener('click', async (e) => {
              const targetUrl = e.currentTarget.dataset.url;
              const confirmed = await window.showConfirmDialog({
                title: 'Delete Prometheus Endpoint',
                message: `Are you sure you want to delete endpoint "${targetUrl}"?`,
                confirmText: 'Delete Endpoint',
                cancelText: 'Cancel',
                isDanger: true
              });
              if (confirmed) {
                await deleteEndpoint(targetUrl);
              }
            });
          });
        }
      } catch (e) {
        console.warn('[EndpointManager] Failed to load endpoints:', e);
      }
    };
    // Reachable from InstancesPage (this.monitor._syncEndpointsUI) so a poll
    // that detects another client repointed the server endpoint can re-sync
    // the topbar picker + _activeEndpoint.
    this._syncEndpointsUI = fetchEndpoints;

    // Serialises endpoint switches. Two selects in flight at once resolve in
    // arbitrary order, and the loser's fetchEndpoints()/load() repaints the
    // picker and grid for an endpoint that is no longer active.
    let switchInFlight = false;

    const selectEndpoint = async (url) => {
      if (switchInFlight) return;
      switchInFlight = true;
      if (endpointSelect) endpointSelect.disabled = true;
      try {
        const res = await apiFetch('/api/endpoints/select', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url })
        });
        let data = {};
        try { data = await res.json(); } catch (_) { /* non-JSON error body */ }
        if (res.ok && data.ok) {
          // Drop the previous endpoint's client-side state BEFORE the refetch,
          // so nothing from it can survive into the first render of the new one.
          this.instancesPage.resetForEndpointSwitch();
          await fetchEndpoints();
          this.instancesPage.load();
          this.instancesPage.loadAvailability();
        } else {
          // The switch did not happen. The <select> is already showing the URL
          // the user picked, so leaving it there is a lie about which
          // Prometheus is active — put it back to the real one and say why.
          await fetchEndpoints();
          this.instancesPage._triggerEventToast(
            res.status === 401 ? 'Sign in to switch the Prometheus endpoint.'
              : res.status === 403 ? 'Permission denied: cannot switch the Prometheus endpoint.'
                : `Endpoint switch failed: ${data.error || res.statusText || res.status}`
          );
        }
      } catch (e) {
        await fetchEndpoints();
        this.instancesPage._triggerEventToast('Endpoint switch failed — could not reach the server.');
      } finally {
        switchInFlight = false;
        if (endpointSelect) endpointSelect.disabled = false;
      }
    };

    const deleteEndpoint = async (url) => {
      const wasActive = this.instancesPage && this.instancesPage._activeEndpoint === url;
      try {
        const res = await apiFetch('/api/endpoints', {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url })
        });
        const data = await res.json();
        if (data.ok) {
          // Deleting the ACTIVE endpoint promotes another one server-side, so
          // this is an endpoint switch too — it just wasn't treated as one
          // (no job-filter reset, no availability refetch).
          if (wasActive) this.instancesPage.resetForEndpointSwitch();
          await fetchEndpoints();
          this.instancesPage.load();
          if (wasActive) this.instancesPage.loadAvailability();
        } else if (errorEl) {
          errorEl.textContent = data.error || 'Failed to delete endpoint';
          errorEl.classList.remove('hidden');
        }
      } catch (e) { }
    };

    // Event listeners
    if (endpointSelect) {
      endpointSelect.addEventListener('change', (e) => {
        selectEndpoint(e.target.value);
      });
    }

    if (openBtn && modal) {
      openBtn.addEventListener('click', () => {
        modal.classList.remove('hidden');
        if (this._untrapEndpoint) this._untrapEndpoint();
        this._untrapEndpoint = window.trapModalFocus(modal);
        fetchEndpoints();
      });
    }

    if (closeBtn && modal) {
      closeBtn.addEventListener('click', () => {
        if (this._untrapEndpoint) { this._untrapEndpoint(); this._untrapEndpoint = null; }
        modal.classList.add('hidden');
      });
    }

    if (addForm) {
      addForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        if (errorEl) errorEl.classList.add('hidden');
        const url = urlInput.value.trim();
        if (!url) return;

        try {
          const res = await apiFetch('/api/endpoints', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url, set_active: true })
          });
          const data = await res.json();
          if (data.ok) {
            urlInput.value = '';
            if (modal) modal.classList.add('hidden');
            // set_active:true above means this IS an endpoint switch — it just
            // skipped the reset, so the previous endpoint's job filter (and its
            // now-nonexistent job <option>s) carried straight over.
            this.instancesPage.resetForEndpointSwitch();
            await fetchEndpoints();
            this.instancesPage.load();
            this.instancesPage.loadAvailability();
          } else if (errorEl) {
            errorEl.textContent = data.error || 'Failed to add endpoint';
            errorEl.classList.remove('hidden');
          }
        } catch (e) {
          if (errorEl) {
            errorEl.textContent = 'Failed to connect to server';
            errorEl.classList.remove('hidden');
          }
        }
      });
    }

    // Initial load — then one more load() so this endpoint's Default Job is
    // restored on first paint (the load() from onActivate races ahead of
    // _activeEndpoint being known).
    fetchEndpoints().then(() => { if (this.instancesPage) this.instancesPage.load(); });
  }


  /* ── onActivate (dashboard page) ───────────────── */
  onActivate() { /* already polling */ }

  /* ── Sound control ─────────────────────────────── */
  _getAudioContext() {
    if (!this.audioCtx) {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (AudioCtx) this.audioCtx = new AudioCtx();
    }
    if (this.audioCtx && this.audioCtx.state === 'suspended') {
      this.audioCtx.resume().catch(() => { });
    }
    return this.audioCtx;
  }

  toggleSound(enabled) {
    this.isMuted = !enabled;
    const soundOn = document.getElementById('soundIconOn');
    const soundOff = document.getElementById('soundIconOff');
    if (soundOn) soundOn.style.display = enabled ? '' : 'none';
    if (soundOff) soundOff.style.display = enabled ? 'none' : '';
    // Recompute immediately against current truth — no stale "already
    // played" flag to get stuck on, so unmuting mid-outage resumes the siren
    // right away instead of silently staying dead until the next distinct event.
    this._syncAlarmAudio();
  }

  unlockAudio() {
    const ctx = this._getAudioContext();
    if (ctx && ctx.state === 'suspended') {
      ctx.resume().catch(() => { });
    }
    if (this.alarmAudio) {
      this.alarmAudio.muted = false;
      this.alarmAudio.volume = 1.0;
    }
    try { localStorage.setItem('iw-audio-unlocked', 'true'); } catch (e) { }
    console.log('[InfraWatch] Audio context & element unlocked cleanly');
  }

  // ── Alarm lifecycle ───────────────────────────────
  // Phase is a pure function of two server epoch timestamps per target
  // (downSince, acknowledged_at) and the current time — never a client-side
  // counter or "have I already played for this" flag. That is what makes a
  // page refresh, a second tab, or a missed poll tick all agree: they all
  // read the same server truth and run the same formula, so there is nothing
  // to fall out of sync. See ALARM_* constants above the class for the timings.
  //
  //   unacked:  [0, 15s) after downSince            -> silent (debounce — see
  //             below; the status tile is red the whole time, this only
  //             holds back the SIREN, and t.downSince itself is untouched so
  //             SLA/downtime math, which reads that same field, is not
  //             delayed by a single tick)
  //             [15s, 45s)                          -> burst (new-outage alarm)
  //             then every 120s, for 10s            -> burst (unacked reminder)
  //   acked:    [0, 300s) after acknowledged_at      -> silent (cooldown)
  //             then every 300s, for 10s             -> burst (still-down reminder)
  //   up / maintenance / suppressed / not alarmable   -> silent
  _alarmPhaseFor(t, nowMs) {
    if (!t || !t.is_alarmable) return 'silent';
    const downSinceMs = t.downSince > 0 ? t.downSince * 1000 : null;
    if (downSinceMs == null) return 'silent';
    const elapsedS = (nowMs - downSinceMs) / 1000;
    if (elapsedS < 0) return 'silent';

    if (!t.acknowledged) {
      // Debounce: a target that recovers within ALARM_DELAY_S of going down
      // never sounds at all (elapsedS never reaches this branch again once
      // health flips — is_alarmable goes false the very next poll). Sustained
      // outages just start their 30s initial burst ALARM_DELAY_S later than
      // downSince, and every later reminder inherits that same offset.
      const alarmElapsedS = elapsedS - ALARM_DELAY_S;
      if (alarmElapsedS < 0) return 'silent';
      if (alarmElapsedS < ALARM_INITIAL_BURST_S) return 'burst';
      return (alarmElapsedS % ALARM_UNACKED_PERIOD_S) < ALARM_UNACKED_BURST_S ? 'burst' : 'silent';
    }

    const ackedAtMs = t.acknowledged_at > 0 ? t.acknowledged_at * 1000 : nowMs;
    const ackedElapsedS = (nowMs - ackedAtMs) / 1000;
    if (ackedElapsedS < ALARM_ACK_COOLDOWN_S) return 'silent';
    return (ackedElapsedS % ALARM_ACKED_PERIOD_S) < ALARM_ACKED_BURST_S ? 'burst' : 'silent';
  }

  // Single decision point for the shared <audio> element: recomputed from
  // scratch every tick, so play()/pause() calls are idempotent (guarded by
  // .paused) rather than edge-triggered — nothing to double-fire or miss.
  _syncAlarmAudio() {
    if (!this.alarmAudio) return;
    const targets = this.instancesPage?.data || [];
    const now = Date.now();
    const shouldPlay = !this.isMuted && targets.some(t => this._alarmPhaseFor(t, now) === 'burst');

    if (shouldPlay) {
      if (this.alarmAudio.paused) {
        this.alarmAudio.loop = true;
        this.alarmAudio.muted = false;
        // Track the pending promise so a same-tick pause() (below) waits for
        // it to settle instead of firing while play() is still in flight —
        // that race is what throws "AbortError: play() interrupted by
        // pause()" on every burst→silent edge when several targets' alarm
        // windows abut with a <1-tick gap.
        this._alarmPlayPromise = this.alarmAudio.play().catch((e) => this._reportAlarmAudioFailure(e));
      }
    } else if (!this.alarmAudio.paused) {
      Promise.resolve(this._alarmPlayPromise).finally(() => {
        if (!this.alarmAudio.paused) {
          this.alarmAudio.pause();
          this.alarmAudio.currentTime = 0;
        }
      });
    }
  }

  _startAlarmTicker() {
    if (this._alarmTickHandle) return;
    this._alarmTickHandle = setInterval(() => this._syncAlarmAudio(), 1000);
  }

  _stopAlarmTicker() {
    if (this._alarmTickHandle) {
      clearInterval(this._alarmTickHandle);
      this._alarmTickHandle = null;
    }
    if (this.alarmAudio && !this.alarmAudio.paused) {
      this.alarmAudio.pause();
      this.alarmAudio.currentTime = 0;
    }
  }

  _reportAlarmAudioFailure(err) {
    // NotAllowedError here just means the browser's autoplay policy blocked
    // playback because the page hasn't seen a user gesture yet — expected on
    // first load, not a bug, and it resolves itself after any click/keypress
    // (see unlockAudio). AbortError means our own pause() superseded this
    // play() call (see _syncAlarmAudio) — the element is still working,
    // nothing to warn the operator about. Both log at warn, not error, and
    // skip the toast; anything else is a genuine playback failure.
    const isBenign = err && (err.name === 'NotAllowedError' || err.name === 'AbortError');
    const log = isBenign ? console.warn : console.error;
    log('[InfraWatch] Alarm audio failed — no sound will play:', err);
    if (!isBenign) {
      this.instancesPage?._triggerEventToast?.('⚠ Alarm sound failed to play — no sound (check browser autoplay/volume)');
    }
  }

  /* ── Escape HTML ───────────────────────────────── */
  _esc(str) { return escapeHtml(str); }

  /* ── Cleanup ───────────────────────────────────── */
  destroy() {
    this._stopAlarmTicker();
    this.instancesPage.onDeactivate();
  }
}
