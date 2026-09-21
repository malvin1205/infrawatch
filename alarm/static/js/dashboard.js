/* Instances / host-grid dashboard page — the host grid, summary stats,
 * polling, the target-detail drawer, the availability breakdown, and the
 * response-time / history charts. Still the largest module; a further
 * split into drawer / availability sub-modules is a separate pass.
 */
import { escapeHtml, slowThresholdMs } from './ui/format.js';
import { apiFetch } from './net.js';
import { enhanceAllSelects } from './ui/select-skin.js';
import { installAvailability } from './availability.js';
import { installTargetDrawer } from './target-drawer.js';

const JOB_DEFAULT_LS_KEY = 'infrawatch.defaultJob';

// Default Job is per Prometheus endpoint — switching endpoints must land on
// the NEW endpoint's own saved default (or "All Jobs"), never carry the old
// one over. Stored as { "<endpoint-url>": "<job>" }. A legacy bare-string
// value (the single global default from before this was per-endpoint) is not
// valid JSON, so it reads back as {} and the user re-sets once per endpoint.
function _loadJobDefaults() {
  try {
    const val = JSON.parse(localStorage.getItem(JOB_DEFAULT_LS_KEY) || '{}');
    return (val && typeof val === 'object') ? val : {};
  } catch (e) { return {}; }
}
function getDefaultJob(endpointUrl) {
  return endpointUrl ? (_loadJobDefaults()[endpointUrl] || null) : null;
}
function setDefaultJob(endpointUrl, job) {
  if (!endpointUrl) return;
  const map = _loadJobDefaults();
  if (job && job !== 'all') map[endpointUrl] = job;
  else delete map[endpointUrl];
  try { localStorage.setItem(JOB_DEFAULT_LS_KEY, JSON.stringify(map)); } catch (e) { }
}


/* ════════════════════════════════════════════════════════════════════════════
   INSTANCES PAGE
   ════════════════════════════════════════════════════════════════════════════ */
export class InstancesPage {
  constructor(monitor) {
    this.monitor = monitor;
    this.data = [];
    this.previousStates = {};
    this.downStartTimes = {};
    this.activeStatus = 'all';   // 'all' | 'up' | 'down' | 'slow'
    this.activeSort = 'default';  // 'default' | 'name_asc' | 'name_desc' | 'job_asc' | 'job_desc' | 'latency_desc' | 'latency_asc'
    this.selectedJob = 'all';     // 'all' or specific job string
    this._activeEndpoint = null;  // current Prometheus URL — set by initEndpointManager; keys the per-endpoint Default Job
    this._defaultJobRestored = false; // guards the restore of this endpoint's Default Job; re-armed on every endpoint switch
    this._endpointFailover = false;   // true while /instances is being answered by an endpoint other than the active one
    this.searchQ = '';
    this.selectedTarget = null;
    this.isAcknowledged = false;
    this.acknowledgedDownInstances = new Set();
    this._spotlightedInstances = new Set();
    this._selectMode = false;
    this._selectedInstances = new Set();

    this.table = document.getElementById('instancesBody');
    this.countBadge = document.getElementById('instanceCount');
    this._downCardElements = [];
    this._maintCardElements = [];

    // Pagination (TV wallboard) — pageSize is not a fixed number, it's
    // however many cards actually fit the grid viewport without shrinking
    // below a readable size. See _calculateGridCapacity()/_applyGridCapacity().
    this.pageSize = 40; // safe seed until the first real measurement lands
    this.currentPage = 1;
    this._totalPages = 1;
    this._sortedRows = [];
    this.autoRotate = false;
    this._autoRotateTimer = null;
    this._autoRotateResumeTimer = null;
    this.paginationBar = document.getElementById('hostPagination');
    this.pageInfoEl = document.getElementById('hpInfo');
    this.prevPageBtn = document.getElementById('hpPrevBtn');
    this.nextPageBtn = document.getElementById('hpNextBtn');
    this.pagesEl = document.getElementById('hpPages');
    this.autoRotateBtn = document.getElementById('hpAutoRotateBtn');
    this.errorEl = document.getElementById('instancesError');
    this.errorMsg = document.getElementById('instancesErrorMsg');
    this.searchEl = document.getElementById('instanceSearch');
    this.chipGroup = document.getElementById('statusFilterChips');

    // Summary cards
    this.statTotal = document.getElementById('instTotal');
    this.statUp = document.getElementById('instUp');
    this.statDown = document.getElementById('instDown');
    this.statUptime = document.getElementById('instOverallUptime');
    this.healthBadge = document.getElementById('globalHealthBadge');
    this.lastProbe = document.getElementById('lastProbeTime');

    // Toast
    this.eventBanner = document.getElementById('eventAlertBanner');
    this.eventBannerText = document.getElementById('eventBannerText');
    this.closeEventBannerBtn = document.getElementById('closeEventBanner');

    // Drawer
    this.sideDrawer = document.getElementById('sideDrawer');
    this.sideDrawerOverlay = document.getElementById('sideDrawerOverlay');
    this.closeDrawerBtn = document.getElementById('closeDrawerBtn');

    this.pollInterval = null;
    this.currentInterval = 5000;
    this.pollingEnabled = true;  // false only while the page is deliberately deactivated

    // Historical / period-based availability (drives the summary cards)
    this.periodMinutes = 1440;      // 24h default
    this.periodEnd = null;          // epoch seconds; null = window ends "now"
    this.periodLabel = '24h';
    this.isRealtime = false;        // true => summary cards mirror the live /instances poll instead of a historical aggregate
    this.availabilityMap = {};      // instance -> availability_pct (for drawer)
    this.availabilityBreakdown = null; // last full /api/availability response
    this.availabilityPollInterval = null;

    this.availabilityLabel = document.getElementById('availabilityLabel');
    this.rangeChipsGroup = document.getElementById('rangeFilterChips');
    this.customRangePopover = document.getElementById('customRangePopover');
    this.customRangeFromEl = document.getElementById('customRangeFrom');
    this.customRangeToEl = document.getElementById('customRangeTo');
    this.customRangeErrorEl = document.getElementById('customRangeError');

    this.availabilityDetailBtn = document.getElementById('availabilityDetailBtn');
    this.availabilityBreakdownModal = document.getElementById('availabilityBreakdownModal');
    this._showAllHostsInBreakdown = false;
    this._breakdownSort = 'avail_asc';

    // In-flight request cancellation (AbortController), retry backoff state, and
    // a cheap "did the data actually change" signature to skip unnecessary
    // re-renders — see load()/loadAvailability()/_render().
    this._loadAbortController = null;
    this._availAbortController = null;
    this._instanceFailCount = 0;
    this._availFailCount = 0;
    this._retryTimers = { instances: null, availability: null };
    this._lastDataSignature = null;
    this._searchDebounceTimer = null;

    // Monotonic sequence number for /api/availability requests: guards
    // against a stale/superseded response overwriting newer state even in
    // the edge case where fetch resolves instead of rejecting on an aborted
    // signal (timing is browser-dependent).
    this._availRequestSeq = 0;
    this._availLoading = false;
    this._availCache = new Map(); // cacheKey -> { timestamp, data }
    this._availCacheTTL = 30000;  // 30s client-side cache for instant zero-latency range switching
    this._targetHistorySeq = 0;

    this._bindEvents();
    this._setupGridCapacityObserver();
  }

  _bindEvents() {
    // Refresh button
    const refreshBtn = document.getElementById('refreshInstances');
    if (refreshBtn) {
      refreshBtn.addEventListener('click', () => {
        refreshBtn.classList.add('spinning');
        this.load().finally(() => refreshBtn.classList.remove('spinning'));
      });
    }

    // Interactive Summary Card Filtering (Rec #3)
    const summaryCards = document.querySelectorAll('.summary-card');
    if (summaryCards && summaryCards.length >= 4) {
      const statusMap = ['all', 'up', 'slow', 'down'];
      summaryCards.forEach((card, idx) => {
        if (idx < 4) {
          card.addEventListener('click', () => {
            this.activeStatus = statusMap[idx];
            if (this.chipGroup) {
              this.chipGroup.querySelectorAll('.chip').forEach(b => {
                b.classList.toggle('chip-active', b.dataset.status === this.activeStatus);
              });
            }
            this._lastDataSignature = null;
            this._render();
          });
        }
      });
    }

    // Search
    const clearSearchBtn = document.getElementById('clearSearchBtn');
    if (this.searchEl) {
      this.searchEl.addEventListener('input', () => {
        if (clearSearchBtn) {
          clearSearchBtn.classList.toggle('hidden', !this.searchEl.value.trim());
        }
        if (this._searchDebounceTimer) clearTimeout(this._searchDebounceTimer);
        this._searchDebounceTimer = setTimeout(() => {
          this._searchDebounceTimer = null;
          this.searchQ = this.searchEl.value.toLowerCase().trim();
          this._lastDataSignature = null;
          this._render();
        }, 180);
      });
    }

    if (clearSearchBtn && this.searchEl) {
      clearSearchBtn.addEventListener('click', () => {
        this.searchEl.value = '';
        this.searchQ = '';
        clearSearchBtn.classList.add('hidden');
        this._lastDataSignature = null;
        this._render();
        this.searchEl.focus();
      });
    }

    document.addEventListener('keydown', e => {
      if (e.key === 'Escape' && document.activeElement === this.searchEl) {
        this.searchEl.value = '';
        this.searchQ = '';
        if (clearSearchBtn) clearSearchBtn.classList.add('hidden');
        this._lastDataSignature = null;
        this._render();
        this.searchEl.blur();
      }
    });

    // Status filter chips
    if (this.chipGroup) {
      this.chipGroup.addEventListener('click', e => {
        const btn = e.target.closest('[data-status]');
        if (!btn) return;
        this.activeStatus = btn.dataset.status;
        this.chipGroup.querySelectorAll('.chip').forEach(b => {
          b.classList.toggle('chip-active', b.dataset.status === this.activeStatus);
        });
        this._lastDataSignature = null;
        this._render();
      });
    }

    // Modal & Target management
    const openBtn = document.getElementById('openAddTargetModalBtn');
    if (openBtn) openBtn.addEventListener('click', () => this._openModal());

    const closeBtn = document.getElementById('closeAddTargetModal');
    if (closeBtn) closeBtn.addEventListener('click', () => this._closeModal());

    const cancelBtn = document.getElementById('cancelAddTargetBtn');
    if (cancelBtn) cancelBtn.addEventListener('click', () => this._closeModal());

    const form = document.getElementById('addTargetForm');
    if (form) form.addEventListener('submit', (e) => this._submitAddTarget(e));

    // Maintenance Mode (Phase 9)
    const maintForm = document.getElementById('drawerMaintenanceForm');
    if (maintForm) {
      maintForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        if (!this.selectedTarget) return;
        const minutes = parseInt(document.getElementById('drawerMaintDuration')?.value, 10) || 60;
        const reason = document.getElementById('drawerMaintReasonInput')?.value.trim() || '';
        await this._startMaintenance(this.selectedTarget.instance, minutes, reason);
      });
    }
    const maintEndBtn = document.getElementById('drawerMaintEndBtn');
    if (maintEndBtn) {
      maintEndBtn.addEventListener('click', async () => {
        if (!this.selectedTarget) return;
        await this._endMaintenance(this.selectedTarget.maintenanceId, this.selectedTarget.instance);
      });
    }

    // Alert Correlation / Dependency (Phase 12)
    const depForm = document.getElementById('drawerDependencyForm');
    if (depForm) {
      depForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        if (!this.selectedTarget) return;
        const parent = document.getElementById('drawerDependencyParentSelect')?.value;
        if (!parent) return;
        await this._setDependency(this.selectedTarget.instance, parent);
      });
    }
    const depRemoveBtn = document.getElementById('drawerDependencyRemoveBtn');
    if (depRemoveBtn) {
      depRemoveBtn.addEventListener('click', async () => {
        if (!this.selectedTarget) return;
        await this._removeDependency(this.selectedTarget.dependencyId, this.selectedTarget.instance);
      });
    }

    // Acknowledge Alarm button (Server-Side Global Incident State)
    const ackBtn = document.getElementById('ackAlarmBtn');
    if (ackBtn) {
      ackBtn.addEventListener('click', async () => {
        // Nothing left unacknowledged: in that state the button is a STATUS
        // ("✓ Acknowledged"), not an action. It stayed clickable and each
        // click fired a real POST that acked nothing, and the handler below
        // reported the empty result as "Alarm acknowledged by <user>" — the
        // UI claiming an ack that never happened. Repeat it a dozen times
        // (an impatient operator does) and it also burns the 30/60s rate
        // limit on /api/alerts/ack and locks acking out for a minute.
        if (this.isAcknowledged) return;

        // One ack at a time, and no re-arm until the button has actually
        // repainted from server truth. The in-flight flag alone was not
        // enough: the round trip is ~10ms, so five clicks 45ms apart sailed
        // straight through it as five separate acks, five audit rows, five
        // toasts and five full grid reloads. Measured: 5 clicks -> 5 POSTs.
        if (this._ackInFlight) return;
        this._ackInFlight = true;
        ackBtn.disabled = true;
        ackBtn.setAttribute('aria-busy', 'true');
        try {
          const res = await apiFetch('/api/alerts/ack', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({})
          });
          let data = {};
          try { data = await res.json(); } catch (_) { /* non-JSON error body */ }
          if (res.ok && data.ok) {
            const n = Array.isArray(data.acknowledged) ? data.acknowledged.length : 0;
            if (n > 0) {
              this.isAcknowledged = true;
              const ackUser = window.currentUser ? window.currentUser.username : 'operator';
              this._triggerEventToast(
                `${n} outage${n === 1 ? '' : 's'} acknowledged by ${ackUser}`);
            } else {
              // ok:true with an empty list means the server found nothing to
              // ack (it raced with a recovery, or another operator got there
              // first). Saying "acknowledged" here was a lie.
              this._triggerEventToast('Nothing to acknowledge — already claimed or recovered.');
            }
            await this.load();
            // Re-sync the siren against the freshly-loaded acknowledged_at
            // right away — otherwise it stays audible until the next 1s tick.
            this.monitor?._syncAlarmAudio?.();
          } else if (res.status === 401) {
            // Session expired / never signed in. This used to fall through
            // every branch: no toast, no error, button unchanged — a dead
            // click that looked exactly like a successful no-op.
            this._triggerEventToast('Sign in to acknowledge alerts.');
          } else if (res.status === 403) {
            this._triggerEventToast('Permission denied: Viewer cannot acknowledge alerts.');
          } else if (res.status === 429) {
            this._triggerEventToast('Too many acknowledgments — wait a moment and retry.');
          } else {
            this._triggerEventToast(`Acknowledge failed: ${data.error || res.statusText || res.status}`);
          }
        } catch (err) {
          console.error('Failed to acknowledge alerts', err);
          this._triggerEventToast('Acknowledge failed — could not reach the server.');
        } finally {
          this._ackInFlight = false;
          // Restore from state, don't force-enable: the await above already
          // re-rendered, and in the all-acked state the button is a status
          // label that must stay non-interactive. A flat `= false` here put
          // it straight back into "clickable no-op" every time.
          ackBtn.disabled = !!this.isAcknowledged;
          ackBtn.removeAttribute('aria-busy');
        }
      });
    }

    // Interval select
    const intervalSelect = document.getElementById('scrapeIntervalSelect');
    if (intervalSelect) {
      intervalSelect.addEventListener('change', e => {
        this.currentInterval = parseInt(e.target.value, 10) || 5000;
        this.startPolling(this.currentInterval);
        this.load();
      });
    }

    // Sort select filter
    const sortSelect = document.getElementById('sortSelect');
    if (sortSelect) {
      sortSelect.addEventListener('change', e => {
        this.activeSort = e.target.value;
        this._lastDataSignature = null;
        this._render();
      });
    }

    // Job select filter
    const jobSelect = document.getElementById('jobSelect');
    if (jobSelect) {
      jobSelect.addEventListener('change', async e => {
        this.selectedJob = e.target.value;
        this._lastDataSignature = null;
        this.load();
        this.loadAvailability(true);
        this._updateJobDefaultUI();
      });
    }

    // Job custom dropdown + Default Job gear/popover (UI layer only; reuses
    // the jobSelect 'change' listener above for any actual filter change,
    // no separate filter logic).
    this._initJobFilterUI();

    // Skin every other native <select> in the app with the same dropdown.
    enhanceAllSelects();

    // Period / time-range chips (24h / 7d / 30d / Custom Range)
    if (this.rangeChipsGroup) {
      this.rangeChipsGroup.addEventListener('click', async e => {
        const btn = e.target.closest('[data-range]');
        if (!btn) return;
        const range = btn.dataset.range;

        if (range === 'custom') {
          this._toggleCustomRangePopover();
          return;
        }

        this._closeCustomRangePopover();
        this._setActiveRangeChip(range);

        if (range === 'mtd') {
          this.isRealtime = false;
          if (this.availabilityDetailBtn) this.availabilityDetailBtn.style.display = '';
          this.periodEnd = null;
          this.periodLabel = range;
          this.periodMinutes = this._monthToDateMinutes();
          const modalRangeSelectEl = document.getElementById('modalRangeSelect');
          if (modalRangeSelectEl) modalRangeSelectEl.value = range;
          this.loadAvailability(true);
          if (this.selectedTarget) this.loadTargetHistory(this.selectedTarget.instance);
          return;
        }

        if (range === 'realtime') {
          this.isRealtime = true;
          this.periodLabel = 'realtime';
          this.periodEnd = null;
          if (this.availabilityLabel) this.availabilityLabel.textContent = 'Availability (Realtime)';
          const drawerUptimeLabel = document.getElementById('drawerUptimeLabel');
          if (drawerUptimeLabel) drawerUptimeLabel.textContent = 'Uptime (Realtime)';
          const drawerSparklineRangeEl = document.getElementById('drawerSparklineRange');
          if (drawerSparklineRangeEl) drawerSparklineRangeEl.textContent = '(Realtime)';
          // Fleet-aggregate/lowest-availability breakdown is inherently a
          // time-weighted historical metric — doesn't apply to an instant
          // snapshot, so hide the Detail button rather than show stale data.
          if (this.availabilityDetailBtn) this.availabilityDetailBtn.style.display = 'none';
          // Reflect whatever the last live poll already fetched immediately,
          // instead of waiting for the next 5s/10s/30s tick.
          this._updateStats();
          if (this.selectedTarget) {
            this.loadTargetHistory(this.selectedTarget.instance);
          }
          return;
        }

        this.isRealtime = false;
        if (this.availabilityDetailBtn) this.availabilityDetailBtn.style.display = '';
        const presets = { '24h': 1440, '7d': 10080, '30d': 43200 };
        this.periodMinutes = presets[range] || 1440;
        this.periodEnd = null;
        this.periodLabel = range;

        const modalRangeSelect = document.getElementById('modalRangeSelect');
        if (modalRangeSelect) {
          const curMins = Math.round(this.periodMinutes);
          const opt = Array.from(modalRangeSelect.options).find(o => Math.round(parseFloat(o.value)) === curMins);
          if (opt) modalRangeSelect.value = opt.value;
        }

        this.loadAvailability(false);
        if (this.selectedTarget) {
          this.loadTargetHistory(this.selectedTarget.instance);
        }
      });
    }

    const customApplyBtn = document.getElementById('customRangeApplyBtn');
    if (customApplyBtn) {
      customApplyBtn.addEventListener('click', () => this._applyCustomRange());
    }
    const customCancelBtn = document.getElementById('customRangeCancelBtn');
    if (customCancelBtn) {
      customCancelBtn.addEventListener('click', () => this._closeCustomRangePopover());
    }

    // Close custom-range popover when clicking outside it
    document.addEventListener('click', e => {
      if (!this.customRangePopover || this.customRangePopover.classList.contains('hidden')) return;
      const wrap = e.target.closest('.range-select-wrap');
      if (!wrap) this._closeCustomRangePopover();
    });

    // Availability breakdown modal (Detail button on the Availability card)
    if (this.availabilityDetailBtn) {
      this.availabilityDetailBtn.addEventListener('click', () => this._openAvailabilityBreakdown());
    }
    const closeBreakdownBtn = document.getElementById('closeAvailabilityBreakdown');
    if (closeBreakdownBtn) {
      closeBreakdownBtn.addEventListener('click', () => this._closeAvailabilityBreakdown());
    }
    if (this.availabilityBreakdownModal) {
      this.availabilityBreakdownModal.addEventListener('click', e => {
        if (e.target === this.availabilityBreakdownModal) this._closeAvailabilityBreakdown();
      });
    }

    const modalRangeSelect = document.getElementById('modalRangeSelect');
    if (modalRangeSelect) {
      modalRangeSelect.addEventListener('change', async e => {
        if (e.target.value === 'mtd') {
          this.isRealtime = false;
          this.periodEnd = null;
          this.periodLabel = 'mtd';
          this.periodMinutes = this._monthToDateMinutes();
          this._setActiveRangeChip('mtd');
          this.loadAvailability(true);
          return;
        }
        const mins = parseFloat(e.target.value);
        if (!isNaN(mins) && mins > 0) {
          this.periodMinutes = mins;
          this.isRealtime = false;
          this.periodEnd = null;
          let label = '24h';
          if (mins === 10080) label = '7d';
          else if (mins === 43200) label = '30d';
          this.periodLabel = label;
          this._setActiveRangeChip(label);
          this.loadAvailability(false);
        }
      });
    }


    // Availability Breakdown modal: Overview<->Audit sub-nav, the gear-icon
    // Node Exporter correlation settings popover, and the per-host audit
    // table's filter chips/search — all previously present in the markup
    // with zero JS behind them.
    this._initAvailSubnav();
    this._initAvailSettingsPopover();
    this._initAuditFilters();

    // Custom Dropdown for Sorting Hosts in Availability Breakdown Modal
    const availSortTrigger = document.getElementById('availSortTrigger');
    const availSortMenu = document.getElementById('availSortMenu');
    
    if (availSortTrigger && availSortMenu) {
      const toggleSortMenu = (open) => {
        const isHidden = typeof open === 'boolean' ? !open : !availSortMenu.classList.contains('hidden');
        availSortMenu.classList.toggle('hidden', isHidden);
        availSortTrigger.setAttribute('aria-expanded', String(!isHidden));
        if (!isHidden) {
          const activeItem = availSortMenu.querySelector('.avail-sort-item.is-active') || availSortMenu.firstElementChild;
          activeItem?.focus();
        }
      };

      availSortTrigger.addEventListener('click', (e) => {
        e.stopPropagation();
        toggleSortMenu();
      });

      availSortTrigger.addEventListener('keydown', (e) => {
        if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          toggleSortMenu(true);
        }
      });

      availSortMenu.addEventListener('click', (e) => {
        const item = e.target.closest('.avail-sort-item');
        if (!item) return;
        const val = item.dataset.value;
        if (val) {
          this._breakdownSort = val;
          toggleSortMenu(false);
          availSortTrigger.focus();
          this._renderAvailabilityBreakdown('sortMenu:click');
        }
      });

      availSortMenu.addEventListener('keydown', (e) => {
        const items = Array.from(availSortMenu.querySelectorAll('.avail-sort-item'));
        const currentIndex = items.indexOf(document.activeElement);

        if (e.key === 'ArrowDown') {
          e.preventDefault();
          const nextIndex = (currentIndex + 1) % items.length;
          items[nextIndex]?.focus();
        } else if (e.key === 'ArrowUp') {
          e.preventDefault();
          const prevIndex = (currentIndex - 1 + items.length) % items.length;
          items[prevIndex]?.focus();
        } else if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          const active = document.activeElement?.closest('.avail-sort-item');
          if (active && active.dataset.value) {
            this._breakdownSort = active.dataset.value;
            toggleSortMenu(false);
            availSortTrigger.focus();
            this._renderAvailabilityBreakdown('sortMenu:enter');
          }
        } else if (e.key === 'Escape' || e.key === 'Tab') {
          // Close only this dropdown — don't let the keystroke bubble to the
          // window-level BACK/Escape interceptor, which would then also close
          // the whole Availability Breakdown modal.
          if (e.key === 'Escape') e.stopPropagation();
          toggleSortMenu(false);
          availSortTrigger.focus();
        }
      });

      document.addEventListener('click', (e) => {
        if (!availSortMenu.classList.contains('hidden') && !e.target.closest('#availSortContainer')) {
          toggleSortMenu(false);
        }
      });
    }

    const tableHeaderEl = document.querySelector('.avail-table-header');
    if (tableHeaderEl) {
      tableHeaderEl.addEventListener('click', e => {
        const btn = e.target.closest('.ath-sort-btn');
        if (!btn) return;
        const key = btn.dataset.sortKey;
        if (key === 'name') {
          this._breakdownSort = this._breakdownSort === 'name_asc' ? 'name_desc' : 'name_asc';
        } else if (key === 'avail') {
          this._breakdownSort = this._breakdownSort === 'avail_asc' ? 'avail_desc' : 'avail_asc';
        } else if (key === 'impact') {
          this._breakdownSort = this._breakdownSort === 'incidents_desc' ? 'downtime_desc' : 'incidents_desc';
        }
        this._renderAvailabilityBreakdown('tableHeader:sort');
      });
    }

    const btnViewAllHosts = document.getElementById('btnViewAllHosts');
    if (btnViewAllHosts) {
      btnViewAllHosts.addEventListener('click', () => {
        this._showAllHostsInBreakdown = !this._showAllHostsInBreakdown;
        this._renderAvailabilityBreakdown('btnViewAllHosts:toggle');
      });
    }

    // Delegated event handling for host rows in breakdown table
    const attentionListEl = document.getElementById('hostsRequiringAttentionList');
    if (attentionListEl) {
      const handleRowSelect = (el) => {
        const row = el.closest('.ara-row');
        if (row) this._openHostFromInstance(row.dataset.instance);
      };
      attentionListEl.addEventListener('click', e => handleRowSelect(e.target));
      attentionListEl.addEventListener('keydown', e => {
        if (e.key === 'Enter' || e.key === ' ') {
          const row = e.target.closest('.ara-row');
          if (row) {
            e.preventDefault();
            handleRowSelect(row);
          }
        }
      });
    }

    // Calendar's only job now: pick a date, which retargets the Trend chart's
    // zoom window (_toggleCalendarDay). No inline detail panel anymore.
    const calendarGridEl = document.getElementById('avbCalendarGrid');
    if (calendarGridEl) {
      calendarGridEl.addEventListener('click', e => {
        const cell = e.target.closest('.avb-calendar-cell');
        if (cell && cell.dataset.date) this._toggleCalendarDay(cell.dataset.date);
      });
    }
    const calendarWorstToggleBtn = document.getElementById('avbCalendarWorstToggle');
    if (calendarWorstToggleBtn) {
      calendarWorstToggleBtn.addEventListener('click', () => this._toggleCalendarWorst());
    }

    const btnLearnCalculations = document.getElementById('btnLearnCalculations');
    if (btnLearnCalculations) {
      btnLearnCalculations.addEventListener('click', () => {
        const panel = document.getElementById('calcExplanationPanel');
        if (panel) {
          const isHidden = panel.classList.toggle('hidden');
          btnLearnCalculations.setAttribute('aria-expanded', !isHidden);
        }
      });
    }

    // Toast dismiss
    if (this.closeEventBannerBtn) {
      this.closeEventBannerBtn.addEventListener('click', () =>
        this.eventBanner?.classList.add('hidden')
      );
    }

    // Drawer close
    if (this.closeDrawerBtn) {
      this.closeDrawerBtn.addEventListener('click', () => this._closeDrawer());
    }
    if (this.sideDrawerOverlay) {
      this.sideDrawerOverlay.addEventListener('click', () => this._closeDrawer());
    }

    // Semi-Fullscreen Modal Tabs & Control Listeners
    const tabsNav = document.getElementById('modalTabsNav');
    if (tabsNav) {
      tabsNav.addEventListener('click', e => {
        const btn = e.target.closest('[data-tab]');
        if (!btn) return;
        this._switchModalTab(btn.dataset.tab);
      });
    }

    const drawerRefreshBtn = document.getElementById('drawerRefreshBtn');
    if (drawerRefreshBtn) {
      drawerRefreshBtn.addEventListener('click', () => {
        if (this.selectedTarget) {
          this._openDrawer(this.selectedTarget);
          this.loadAvailability();
        }
      });
    }

    const modalCloseBottomBtn = document.getElementById('modalCloseBottomBtn');
    if (modalCloseBottomBtn) {
      modalCloseBottomBtn.addEventListener('click', () => this._closeDrawer());
    }

    // Sparkline Time Range selector buttons (5m, 15m, 1h, 6h, 24h, 7d)
    const spRangeGroup = document.getElementById('spRangeGroup');
    if (spRangeGroup) {
      spRangeGroup.addEventListener('click', e => {
        const btn = e.target.closest('[data-range]');
        if (!btn) return;
        const range = btn.dataset.range;
        const presets = { '5m': 5, '15m': 15, '1h': 60, '6h': 360, '24h': 1440, '7d': 10080 };
        this.periodMinutes = presets[range] || 1440;
        this.periodLabel = range;
        this.periodEnd = null;
        this._sparklineZoomRange = null;
        
        spRangeGroup.querySelectorAll('.sp-range-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');

        const resetBtn = document.getElementById('sparklineResetZoomBtn');
        if (resetBtn) resetBtn.style.display = 'none';

        if (this.selectedTarget) {
          this.loadTargetHistory(this.selectedTarget.instance);
        }
      });
    }

    // Sparkline Reset Zoom button
    const spResetBtn = document.getElementById('sparklineResetZoomBtn');
    if (spResetBtn) {
      spResetBtn.addEventListener('click', () => {
        this._sparklineZoomRange = null;
        spResetBtn.style.display = 'none';
        if (Array.isArray(this._rawSparklinePoints)) {
          this._renderSparkline(this._rawSparklinePoints, true);
        }
      });
    }

    const btnViewAllEvents = document.getElementById('btnViewAllEvents');
    if (btnViewAllEvents) {
      btnViewAllEvents.addEventListener('click', () => this._switchModalTab('events'));
    }

    // Card click => open drawer; delegated keydown => D-pad nav + Enter/Space to open
    // (Escape/Back is handled globally — see the window-level BACK interceptor below.)
    if (this.table) {
      this.table.addEventListener('click', e => {
        const card = e.target.closest('.host-card');
        if (!card) return;
        const inst = card.dataset.instance;
        if (this._selectMode) {
          this._toggleSelected(inst);
          return;
        }
        const target = this.data.find(t => t.instance === inst);
        if (target) this._openDrawer(target);
      });
      this.table.addEventListener('keydown', e => this._onHostGridKeydown(e));
    }
    this._bindSelectMode();

    // Pagination controls
    if (this.prevPageBtn) {
      this.prevPageBtn.addEventListener('click', () => this._goToPage(this.currentPage - 1, true));
    }
    if (this.nextPageBtn) {
      this.nextPageBtn.addEventListener('click', () => this._goToPage(this.currentPage + 1, true));
    }
    if (this.pagesEl) {
      this.pagesEl.addEventListener('click', e => {
        const btn = e.target.closest('[data-page]');
        if (!btn) return;
        this._goToPage(parseInt(btn.dataset.page, 10), true);
      });
    }
    if (this.autoRotateBtn) {
      this.autoRotateBtn.addEventListener('click', () => {
        this.autoRotate = !this.autoRotate;
        this.autoRotateBtn.textContent = `Auto Rotate: ${this.autoRotate ? 'ON' : 'OFF'}`;
        this.autoRotateBtn.classList.toggle('hp-autorotate-on', this.autoRotate);
        this.autoRotateBtn.setAttribute('aria-pressed', String(this.autoRotate));
        if (this.autoRotate) this._startAutoRotate();
        else this._stopAutoRotate();
      });
    }
  }

  onActivate() {
    this.load();
    this.loadAvailability();
    this.startPolling(this.currentInterval);
    this.startAvailabilityPolling();
    this.startDownCounterTicker();
    if (this.autoRotate) this._startAutoRotate();
  }

  onDeactivate() {
    this.stopPolling();
    this.stopAvailabilityPolling();
    this.stopDownCounterTicker();
    this._stopAutoRotate();
  }

  /* ── Pagination (TV wallboard: adaptive cards/page, see _calculateGridCapacity) ── */
  _goToPage(page, manual) {
    const target = Math.max(1, Math.min(this._totalPages, page));
    if (manual) this._registerPageInteraction();
    if (target === this.currentPage) return;
    this.currentPage = target;
    this._renderPageWithTransition();
  }

  _renderPageWithTransition() {
    const rows = this._sortedRows || [];
    const startIdx = (this.currentPage - 1) * this.pageSize;
    const pageRows = rows.slice(startIdx, startIdx + this.pageSize);
    this._updatePaginationUI(rows.length, startIdx, pageRows.length);
    if (!this.table) return;
    // Fade transition (200-300ms) between pages — full DOM rebuild is expected
    // here since the card set genuinely changes, unlike the poll-time diff in _renderCards().
    this.table.classList.add('hg-fade-out');
    setTimeout(() => {
      this._renderCards(pageRows);
      this.table.classList.remove('hg-fade-out');
    }, 220);
  }

  _updatePaginationUI(total, startIdx, pageCount) {
    if (this.pageInfoEl) {
      this.pageInfoEl.textContent = total === 0
        ? 'Showing 0 of 0 hosts'
        : `Showing ${startIdx + 1}–${startIdx + pageCount} of ${total} hosts`;
    }
    if (this.paginationBar) this.paginationBar.classList.toggle('hidden', this._totalPages <= 1);
    if (this.prevPageBtn) this.prevPageBtn.disabled = this.currentPage <= 1;
    if (this.nextPageBtn) this.nextPageBtn.disabled = this.currentPage >= this._totalPages;
    if (this.pagesEl) {
      this.pagesEl.innerHTML = this._buildPageList(this._totalPages, this.currentPage).map(p =>
        p === '…'
          ? `<span class="hp-ellipsis">…</span>`
          : `<button class="hp-page-btn${p === this.currentPage ? ' hp-page-active' : ''}" data-page="${p}" type="button">${p}</button>`
      ).join('');
    }
  }

  _buildPageList(total, current) {
    const keep = new Set([1, total, current, current - 1, current + 1].filter(p => p >= 1 && p <= total));
    const sorted = Array.from(keep).sort((a, b) => a - b);
    const pages = [];
    let prev = 0;
    sorted.forEach(p => {
      if (prev && p - prev > 1) pages.push('…');
      pages.push(p);
      prev = p;
    });
    return pages;
  }

  /* ── Adaptive Grid Capacity ──────────────────────────────────────────
     pageSize is derived from the grid's actual laid-out size, not a
     hardcoded count. Column count comes straight from the browser's own
     resolved `grid-template-columns` (auto-fill pre-creates every column
     that fits, even with fewer cards than columns, so this is authoritative
     regardless of how many hosts are on the current page). Row count is
     the same available-height-over-min-card-height math the CSS itself
     uses for `grid-auto-rows: minmax(--hc-min-h, 1fr)`, so JS and CSS never
     disagree about how many rows actually fit. ── */
  _calculateGridCapacity() {
    const grid = this.table;
    const fallback = { columns: 1, rows: 1, pageSize: this.pageSize || 40 };
    if (!grid) return fallback;

    const width = grid.clientWidth;
    const height = grid.clientHeight;
    if (!width || !height) return fallback; // not laid out yet — keep prior value rather than guess

    const cs = getComputedStyle(grid);
    const columns = cs.gridTemplateColumns.split(' ').filter(Boolean).length || 1;

    const minCardH = parseFloat(cs.getPropertyValue('--hc-min-h')) || 56;
    const rowGap = parseFloat(cs.rowGap) || 0;
    const availHeight = height - (parseFloat(cs.paddingTop) || 0) - (parseFloat(cs.paddingBottom) || 0);
    const rows = Math.max(1, Math.floor((availHeight + rowGap) / (minCardH + rowGap)));

    return { columns, rows, pageSize: Math.max(1, columns * rows) };
  }

  // Re-measures grid capacity; if it actually changed (resize, zoom, DPI),
  // reflows pagination without losing hosts or stranding the user on an
  // empty page — keeps whichever host was first-visible in view instead of
  // jumping back to page 1.
  _applyGridCapacity() {
    const cap = this._calculateGridCapacity();
    if (cap.pageSize === this.pageSize) return;
    const firstVisibleIdx = (this.currentPage - 1) * this.pageSize;
    this.pageSize = cap.pageSize;
    this.currentPage = Math.floor(firstVisibleIdx / this.pageSize) + 1;
    // No data yet (first measurement lands before load() resolves) — the
    // updated pageSize is already in place for load()'s own _render() call,
    // don't churn the still-showing skeleton loader in the meantime.
    if (this.data && this.data.length) this._render();
  }

  _setupGridCapacityObserver() {
    if (!this.table || typeof ResizeObserver === 'undefined') return;
    let debounceTimer = null;
    this._gridResizeObserver = new ResizeObserver(() => {
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => this._applyGridCapacity(), 120);
    });
    this._gridResizeObserver.observe(this.table);
  }

  /* ── Auto Rotate (TV mode) ── */
  _startAutoRotate() {
    this._clearAutoRotateTimers();
    this._autoRotateTimer = setInterval(() => {
      this.currentPage = this.currentPage >= this._totalPages ? 1 : this.currentPage + 1;
      this._renderPageWithTransition();
    }, 8000);
  }

  _stopAutoRotate() {
    this._clearAutoRotateTimers();
  }

  _clearAutoRotateTimers() {
    if (this._autoRotateTimer) { clearInterval(this._autoRotateTimer); this._autoRotateTimer = null; }
    if (this._autoRotateResumeTimer) { clearTimeout(this._autoRotateResumeTimer); this._autoRotateResumeTimer = null; }
  }

  // Manual page change pauses rotation, resumes after 30s of no interaction.
  _registerPageInteraction() {
    if (!this.autoRotate) return;
    if (this._autoRotateTimer) { clearInterval(this._autoRotateTimer); this._autoRotateTimer = null; }
    if (this._autoRotateResumeTimer) clearTimeout(this._autoRotateResumeTimer);
    this._autoRotateResumeTimer = setTimeout(() => {
      this._autoRotateResumeTimer = null;
      if (this.autoRotate) this._startAutoRotate();
    }, 30000);
  }

  startDownCounterTicker() {
    this.stopDownCounterTicker();
    this.downCounterInterval = setInterval(() => this._tickDownCounters(), 1000);
  }

  stopDownCounterTicker() {
    if (this.downCounterInterval) {
      clearInterval(this.downCounterInterval);
      this.downCounterInterval = null;
    }
  }

  _tickDownCounters() {
    // Freshness ages every second regardless of whether any data arrived —
    // that is the whole point of it, so it runs before the early return.
    this._renderFreshness();
    if (!this.data || this.data.length === 0) return;
    const now = Date.now();

    if (this.table) {
      if (this._downCardElements && this._downCardElements.length > 0) {
        this._downCardElements.forEach(({ inst, latEl }) => {
          const target = this.data.find(t => t.instance === inst);
          if (!target) return;

          if (latEl) {
            latEl.textContent = this._downLabel(target, this._downAgingFor(target, now));
          }
        });
      }

      if (this._maintCardElements && this._maintCardElements.length > 0) {
        this._maintCardElements.forEach(({ inst, latEl }) => {
          const target = this.data.find(t => t.instance === inst);
          if (!target || !target.maintenanceUntil) return;
          const remainMs = Math.max(0, target.maintenanceUntil * 1000 - now);
          if (latEl) latEl.textContent = `Maint ${this._fmtDownAging(remainMs)} left`;
        });
      }
    }

    if (this.selectedTarget && this.selectedTarget.health !== 'up') {
      const drawerLatEl = document.getElementById('drawerLatency');
      if (drawerLatEl) {
        // Same resolver as the tile — the drawer used to run its own copy of
        // the session-timer fallback, which is how one host could read
        // "Down 27m 15s" here and "96h 57m" in its own Events tab (audit 5.6).
        const aging = this._downAgingFor(this.selectedTarget, now);
        drawerLatEl.textContent = aging === null ? 'Down · start unknown' : `Down ${aging}`;
      }

      const ongoingLogEl = document.querySelector('#drawerLogsList .ongoing-duration-val[data-ongoing="true"]');
      if (ongoingLogEl) {
        const startTs = parseInt(ongoingLogEl.dataset.startTs, 10);
        if (startTs && !isNaN(startTs)) {
          const durationMs = Math.max(0, now - (startTs * 1000));
          ongoingLogEl.textContent = this._fmtDownAging(durationMs);
        }
      }
    }

    if (this.selectedTarget && this.selectedTarget.maintenance) {
      this._renderDrawerMaintenance(this.selectedTarget);
    }
  }

  /* ── Historical availability (past N days) ─────── */


  /* ── Period / range selector (toolbar) ─────────── */

  startPolling(ms) {
    // Only clear the previous timer here — not the full stopPolling(), which
    // also cancels any in-flight fetch. onActivate() calls load() and then
    // startPolling() in the same tick, so aborting here would kill the
    // request it just kicked off, leaving the grid on its skeleton loader
    // until the next tick instead of showing data as soon as it arrives.
    if (this.pollInterval) clearInterval(this.pollInterval);
    // Remembered so the freshness line can say when the data has fallen behind
    // the configured cadence rather than guessing a fixed 5s (audit 4.9).
    this.refreshIntervalMs = ms;
    this.pollingEnabled = true;
    this.pollInterval = setInterval(() => this.load(), ms);
  }

  stopPolling() {
    // Deliberate stop (page deactivated) — keep _clearRetry from re-arming.
    this.pollingEnabled = false;
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
    this._clearRetry('instances');
    if (this._loadAbortController) {
      this._loadAbortController.abort();
      this._loadAbortController = null;
    }
  }

  /* ── Retry backoff helpers (shared by load()/loadAvailability()) ── */
  // _scheduleRetry() STOPS the poll interval on failure and makes its own
  // timer solely responsible for restarting it. So any success that arrives
  // before that timer fires — the ack handler's direct load(), a manual
  // refresh, a filter change — cancels the retry and leaves nothing running:
  // the dashboard silently stops refreshing until a page reload. Re-arming
  // here (rather than at each of the ~6 call sites) is the whole fix.
  _clearRetry(kind) {
    if (kind === 'instances' && !this.pollInterval && this.pollingEnabled !== false) {
      this.startPolling(this.currentInterval);
    } else if (kind === 'availability' && !this.availabilityPollInterval && this.pollingEnabled !== false) {
      this.startAvailabilityPolling();
    }
    if (this._retryTimers[kind]) {
      clearTimeout(this._retryTimers[kind]);
      this._retryTimers[kind] = null;
    }
  }

  _scheduleRetry(kind) {
    if (this._retryTimers[kind]) return; // a retry is already queued
    if (kind === 'instances' && this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    } else if (kind === 'availability' && this.availabilityPollInterval) {
      clearInterval(this.availabilityPollInterval);
      this.availabilityPollInterval = null;
    }
    const failCount = kind === 'instances' ? this._instanceFailCount : this._availFailCount;
    const delay = Math.min(1000 * (2 ** Math.max(0, failCount - 1)), 30000);
    this._retryTimers[kind] = setTimeout(() => {
      this._retryTimers[kind] = null;
      if (kind === 'instances') {
        this.load();
        this.startPolling(this.currentInterval);
      } else {
        this.loadAvailability();
        this.startAvailabilityPolling();
      }
    }, delay);
  }

  _computeDataSignature(targets, summary) {
    // Acknowledgment is NOT derivable from probe health, so it has to be in
    // the signature explicitly. It wasn't: an ack or unack changes only
    // `acknowledged`/`_by`/`_at` per target and the summary's ack counters,
    // leaving this signature byte-identical — so load() skipped _render() and
    // the Acknowledge button, the health badge, the "N not yet acknowledged"
    // sub-line and the ✓ marks on the tiles all froze at their previous
    // values. Indefinitely: nothing re-rendered them until some unrelated
    // health or latency change happened to perturb the signature. On a
    // flapping fleet that masked the bug (latency jitters every poll); on a
    // quiet wallboard — the normal case — the operator acked and the UI
    // simply did not move, or showed "✓ Acknowledged" over outages nobody
    // had claimed.
    const s = summary || {};
    let sig = `${this.activeSort || 'default'}|${this.selectedJob || 'all'}|${this.activeStatus || 'all'}|${this.searchQ || ''}`
      + `|${s.is_acknowledged}|${s.unacknowledged_down}|${s.acknowledged_down}|${s.has_alarm}|${s.system_status};`;
    for (let i = 0; i < targets.length; i++) {
      const t = targets[i];
      // is_alarmable/effective_status/active_alerts are backend-derived from
      // Alertmanager alerts, not just probe health — an alert can fire/clear
      // (e.g. a warning-severity CPU alert) with health/downSince/etc all
      // unchanged, which used to leave the signature identical and skip
      // _render(), so the top-level alarm banner could flip while every
      // per-target card silently stayed stale.
      const alertsSig = Array.isArray(t.active_alerts)
        ? t.active_alerts.map(a => `${a.name}:${a.severity}`).join(',')
        : '';
      sig += t.instance + '|' + t.job + '|' + t.health + '|' + t.responseTimeMs + '|' + t.downSince + '|' + t.maintenance + '|' + t.suppressedBy + '|' + t.failureCategory + '|' + t.is_alarmable + '|' + t.effective_status + '|' + alertsSig + '|' + t.acknowledged + '|' + t.acknowledged_by + '|' + t.acknowledged_at + ';';
    }
    return sig;
  }

  async load() {
    // Cancel any still-in-flight /instances request (overlapping poll tick,
    // rapid filter change, endpoint switch, manual refresh) instead of letting
    // stale responses race with fresh ones.
    if (this._loadAbortController) this._loadAbortController.abort();
    const controller = new AbortController();
    this._loadAbortController = controller;

    try {
      let url = '/instances';
      if (this.selectedJob && this.selectedJob !== 'all') {
        url += `?job=${encodeURIComponent(this.selectedJob)}`;
      }
      const res = await fetch(url, { signal: controller.signal });
      const data = await res.json();

      if (!data.ok) {
        this._showError(data.error || 'Cannot reach Prometheus engine');
        this._instanceFailCount = Math.min(this._instanceFailCount + 1, 6);
        this._scheduleRetry('instances');
        return;
      }
      if (this.errorEl) this.errorEl.classList.add('hidden');
      this._instanceFailCount = 0;
      this._clearRetry('instances');

      // Another client (another device/tab) may have repointed the server's
      // GLOBAL active Prometheus endpoint out from under us — the job filter
      // and topbar picker here are now stale, and a job absent on the new
      // endpoint renders an empty "no hosts match" grid. The poll response
      // names the URL actually served; if that isn't the one we think is
      // active, re-check the registry — then, only if the *registered*
      // active really moved (a transient fetch fallback to a secondary
      // endpoint also lands here and must NOT count), do locally what a
      // manual endpoint switch does and re-fetch against the new endpoint.
      if (data.prometheus_url && this._activeEndpoint && data.prometheus_url !== this._activeEndpoint) {
        const known = this._activeEndpoint;
        if (this.monitor && typeof this.monitor._syncEndpointsUI === 'function') {
          await this.monitor._syncEndpointsUI(); // refreshes this._activeEndpoint from /api/endpoints
        }
        if (this._activeEndpoint && this._activeEndpoint !== known) {
          this.resetForEndpointSwitch();
          this._triggerEventToast('Active Prometheus endpoint changed elsewhere — view reset.');
          this.loadAvailability(); // 24h % / trend are per endpoint+job too
          return this.load();
        }
      }

      this._markEndpointFailover(data.prometheus_url);

      // Update available jobs in dropdown if present
      if (Array.isArray(data.available_jobs) && document.getElementById('jobSelect')) {
        const jobSelect = document.getElementById('jobSelect');
        const existingOptions = Array.from(jobSelect.options).map(o => o.value);
        data.available_jobs.forEach(j => {
          if (!existingOptions.includes(j)) {
            const opt = document.createElement('option');
            opt.value = j;
            opt.textContent = `Job: ${j}`;
            jobSelect.appendChild(opt);
          }
        });

        this._syncJobDropdownOptions();
        this._restoreDefaultJob(jobSelect);
      }

      const newTargets = data.targets || [];
      this.serverPayload = data;
      this._checkStateTransitions(newTargets);
      this.data = newTargets;
      this._updateStats();

      // Skip the (relatively) expensive filter/sort/DOM-diff pass when the
      // fleet's health/latency data is byte-identical to the last render —
      // common at steady state, and the main win at thousands of targets.
      const sig = this._computeDataSignature(newTargets, data.summary);
      if (sig !== this._lastDataSignature) {
        this._lastDataSignature = sig;
        this._render();
      }
    } catch (e) {
      if (e.name === 'AbortError') return;
      this._showError(e.message);
      this._instanceFailCount = Math.min(this._instanceFailCount + 1, 6);
      this._scheduleRetry('instances');
    } finally {
      if (this._loadAbortController === controller) this._loadAbortController = null;
    }
  }

  // Job Filter custom dropdown + Default Job gear/popover — one controller,
  // since both float off the same wrap and share outside-click/Escape
  // handling. #jobSelect (native, hidden via CSS) stays the single state
  // holder: every existing load()/loadAvailability()/_restoreDefaultJob
  // codepath keeps reading jobSelect.value/.options and listening for
  // 'change' on it unmodified — this controller only ever drives that same
  // element and never re-implements filtering.
  _initJobFilterUI() {
    const wrap = document.getElementById('jobSelectWrap');
    const jobSelect = document.getElementById('jobSelect');
    const ddTrigger = document.getElementById('jobDdTrigger');
    const ddMenu = document.getElementById('jobDdMenu');
    const ddLabel = document.getElementById('jobDdLabel');
    const gearBtn = document.getElementById('jobDefaultSettingsBtn');
    const popover = document.getElementById('jobDefaultPopover');
    const setRow = document.getElementById('jdpSetRow');
    const setCheckbox = document.getElementById('jdpSetCheckbox');
    const resetBtn = document.getElementById('jdpResetBtn');
    const badge = document.getElementById('jobDefaultBadge');
    if (!wrap || !jobSelect || !ddTrigger || !ddMenu || !gearBtn || !popover) return;

    this._jobFilterEls = { wrap, jobSelect, ddTrigger, ddMenu, ddLabel, gearBtn, popover, setRow, setCheckbox, resetBtn, badge };

    // ── Custom dropdown (UI layer only — see _selectJobDdOption) ──
    ddTrigger.addEventListener('click', e => {
      e.stopPropagation();
      if (ddMenu.classList.contains('hidden')) this._openJobDropdown();
      else this._closeJobDropdown();
    });
    ddTrigger.addEventListener('keydown', e => {
      if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        this._openJobDropdown();
      }
    });
    ddMenu.addEventListener('click', e => {
      const li = e.target.closest('.job-dd-option');
      if (li) this._selectJobDdOption(li);
    });
    ddMenu.addEventListener('keydown', e => this._onJobDdMenuKeydown(e));

    // ── Default Job gear + popover ──
    gearBtn.addEventListener('click', e => {
      e.stopPropagation();
      if (popover.classList.contains('hidden')) this._openJobDefaultPopover();
      else this._closeJobDefaultPopover();
    });

    if (setCheckbox) {
      setCheckbox.addEventListener('change', () => {
        if (!setCheckbox.checked) return; // clearing the default only happens via Reset
        setDefaultJob(this._activeEndpoint, this.selectedJob);
        this._triggerEventToast('Default Job saved.');
        this._updateJobDefaultUI();
        this._closeJobDefaultPopover();
      });
    }

    if (resetBtn) {
      resetBtn.addEventListener('click', () => {
        setDefaultJob(this._activeEndpoint, null);
        if (jobSelect.value !== 'all') {
          jobSelect.value = 'all';
          jobSelect.dispatchEvent(new Event('change')); // reuses the one filter code path
        } else {
          this._updateJobDefaultUI();
        }
        this._triggerEventToast('Default Job cleared.');
        this._closeJobDefaultPopover();
      });
    }

    // Click outside / Escape closes whichever of the two floats is open —
    // neither is a modal, both stay lightweight popovers.
    document.addEventListener('click', e => {
      if (wrap.contains(e.target)) return;
      this._closeJobDropdown();
      this._closeJobDefaultPopover();
    });
    document.addEventListener('keydown', e => {
      if (e.key !== 'Escape') return;
      if (!ddMenu.classList.contains('hidden')) { this._closeJobDropdown(); ddTrigger.focus(); }
      if (!popover.classList.contains('hidden')) this._closeJobDefaultPopover();
    });

    this._syncJobDropdownSelection();
    this._updateJobDefaultUI();
  }

  /* ── Custom Job dropdown — pure UI, drives #jobSelect + its 'change' ── */
  _openJobDropdown() {
    const els = this._jobFilterEls;
    if (!els) return;
    this._closeJobDefaultPopover();
    els.ddMenu.classList.remove('hidden');
    els.ddTrigger.setAttribute('aria-expanded', 'true');
    const current = els.ddMenu.querySelector('[aria-selected="true"]') || els.ddMenu.firstElementChild;
    this._setActiveJobDdOption(current);
    els.ddMenu.focus();
  }

  _closeJobDropdown() {
    const els = this._jobFilterEls;
    if (!els || els.ddMenu.classList.contains('hidden')) return;
    els.ddMenu.classList.add('hidden');
    els.ddTrigger.setAttribute('aria-expanded', 'false');
  }

  _setActiveJobDdOption(li) {
    const els = this._jobFilterEls;
    if (!els || !li) return;
    els.ddMenu.querySelectorAll('.job-dd-option-active').forEach(el => el.classList.remove('job-dd-option-active'));
    li.classList.add('job-dd-option-active');
    li.scrollIntoView({ block: 'nearest' });
  }

  _onJobDdMenuKeydown(e) {
    const els = this._jobFilterEls;
    if (!els) return;
    const options = Array.from(els.ddMenu.children);
    if (!options.length) return;
    const activeIdx = Math.max(0, options.findIndex(li => li.classList.contains('job-dd-option-active')));

    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        this._setActiveJobDdOption(options[Math.min(options.length - 1, activeIdx + 1)]);
        break;
      case 'ArrowUp':
        e.preventDefault();
        this._setActiveJobDdOption(options[Math.max(0, activeIdx - 1)]);
        break;
      case 'Home':
        e.preventDefault();
        this._setActiveJobDdOption(options[0]);
        break;
      case 'End':
        e.preventDefault();
        this._setActiveJobDdOption(options[options.length - 1]);
        break;
      case 'Enter':
      case ' ':
        e.preventDefault();
        this._selectJobDdOption(options[activeIdx]);
        break;
      case 'Escape':
        e.preventDefault();
        this._closeJobDropdown();
        els.ddTrigger.focus();
        break;
      case 'Tab':
        this._closeJobDropdown();
        break;
    }
  }

  // The only place a dropdown click/keypress turns into a filter change —
  // sets the hidden native select's value and dispatches 'change' on it,
  // which the existing jobSelect listener in _bindEvents picks up exactly
  // as it did when that select was visible. No parallel filtering logic.
  _selectJobDdOption(li) {
    const els = this._jobFilterEls;
    if (!els || !li) return;
    if (els.jobSelect.value !== li.dataset.value) {
      els.jobSelect.value = li.dataset.value;
      els.jobSelect.dispatchEvent(new Event('change'));
    }
    this._closeJobDropdown();
    els.ddTrigger.focus();
  }

  // Rebuilds the <li> option list from the hidden <select>'s <option>s
  // (itself populated by load()'s available_jobs merge) — never a second
  // source of truth for what jobs exist.
  _syncJobDropdownOptions() {
    const els = this._jobFilterEls;
    if (!els) return;
    const existing = new Set(Array.from(els.ddMenu.children).map(li => li.dataset.value));
    Array.from(els.jobSelect.options).forEach(opt => {
      if (existing.has(opt.value)) return;
      const li = document.createElement('li');
      li.setAttribute('role', 'option');
      li.className = 'job-dd-option';
      li.dataset.value = opt.value;
      li.textContent = opt.textContent;
      els.ddMenu.appendChild(li);
    });
    this._syncJobDropdownSelection();
  }

  // Reflects #jobSelect's current value into the trigger label and the
  // menu's aria-selected state.
  _syncJobDropdownSelection() {
    const els = this._jobFilterEls;
    if (!els) return;
    const selectedOpt = els.jobSelect.options[els.jobSelect.selectedIndex];
    if (els.ddLabel) els.ddLabel.textContent = selectedOpt ? selectedOpt.textContent : 'Semua Job';
    Array.from(els.ddMenu.children).forEach(li => {
      li.setAttribute('aria-selected', String(li.dataset.value === els.jobSelect.value));
    });
  }

  // Skins a native <select> with the same custom dropdown as the Job filter
  // (.job-dd-* : pill trigger, chevron, panel with blue hover). The <select>
  // stays in the DOM as the single source of truth — every existing reader/
  // writer of .value and every 'change' listener keeps working; picking here
  // sets .value and dispatches 'change' exactly as the native control would.
  // UI only, no business logic.

  /* ── Default Job gear popover ── */
  _openJobDefaultPopover() {
    const els = this._jobFilterEls;
    if (!els) return;
    this._closeJobDropdown();
    this._updateJobDefaultUI();
    els.popover.classList.remove('hidden');
    els.gearBtn.setAttribute('aria-expanded', 'true');
  }

  _closeJobDefaultPopover() {
    const els = this._jobFilterEls;
    if (!els || els.popover.classList.contains('hidden')) return;
    els.popover.classList.add('hidden');
    els.gearBtn.setAttribute('aria-expanded', 'false');
  }

  // Reflects whether the currently selected Job is the saved default:
  // toggles the trigger's "Default" badge and shows/hides the "Set as
  // Default" row in the popover (hidden when already default, per spec).
  // Also keeps the dropdown label/selection in sync, since both change
  // together whenever selectedJob changes.
  _updateJobDefaultUI() {
    const els = this._jobFilterEls;
    if (!els) return;
    this._syncJobDropdownSelection();

    const stored = getDefaultJob(this._activeEndpoint);
    const isDefault = !!stored && stored === this.selectedJob;

    if (els.badge) els.badge.classList.toggle('hidden', !isDefault);
    if (els.setRow) els.setRow.classList.toggle('hidden', isDefault);
    if (els.setCheckbox) els.setCheckbox.checked = isDefault;
  }

  // Startup restore of a saved default Job — runs once, first successful
  // load() only (jobSelect must already be populated). Fires the same
  // 'change' event the manual dropdown handler listens on (see _bindEvents)
  // instead of duplicating the load()/loadAvailability() filter logic.
  _restoreDefaultJob(jobSelect) {
    if (this._defaultJobRestored) return;
    // Endpoint list not loaded yet (first paint race) — leave the guard
    // un-armed so a later load() retries once _activeEndpoint is known.
    if (!this._activeEndpoint) return;
    this._defaultJobRestored = true;

    const stored = getDefaultJob(this._activeEndpoint);
    if (!stored) return;

    // This endpoint's saved default names a job it doesn't currently expose —
    // stay on "All Jobs"; the saved default is kept for when it reappears.
    const exists = Array.from(jobSelect.options).some(o => o.value === stored);
    if (!exists) return;

    if (jobSelect.value !== stored) {
      jobSelect.value = stored;
      jobSelect.dispatchEvent(new Event('change')); // also triggers _updateJobDefaultUI via the change listener
    } else {
      this._updateJobDefaultUI();
    }
  }

  // Endpoint switch: the previous endpoint's job list and any active job
  // filter mean nothing against a different Prometheus (filtering on a job
  // the new endpoint has never scraped yields an empty grid that looks
  // stuck). Drop to "All Jobs", prune the stale <option>s / <li>s, and
  // re-arm the restore so the next load() applies the NEW endpoint's own
  // Default Job (getDefaultJob(this._activeEndpoint)) if it has one.
  _resetJobFilter() {
    this.selectedJob = 'all';
    this._defaultJobRestored = false;
    this._lastDataSignature = null;

    const jobSelect = document.getElementById('jobSelect');
    if (jobSelect) {
      Array.from(jobSelect.options).forEach(o => { if (o.value !== 'all') o.remove(); });
      jobSelect.value = 'all';
    }
    const els = this._jobFilterEls;
    if (els && els.ddMenu) {
      Array.from(els.ddMenu.children).forEach(li => { if (li.dataset.value !== 'all') li.remove(); });
    }
    this._updateJobDefaultUI();
  }

  // The selected endpoint can be unreachable while the server still answers:
  // fetch_prometheus_json fails over to another registered endpoint and
  // returns ITS fleet (core/monitoring/client.py). Nothing said so — the
  // picker went on naming the endpoint the operator selected while every
  // host, count and percentage on screen came from a different Prometheus,
  // which is what "switching endpoints leaves stale data" actually looks
  // like. Name it: on the picker, and once per transition in a toast.
  _markEndpointFailover(servedUrl) {
    const on = !!(servedUrl && this._activeEndpoint && servedUrl !== this._activeEndpoint);

    const sel = document.getElementById('endpointSelect');
    const opt = sel && sel.options[sel.selectedIndex];
    if (opt) {
      // The skinned dropdown mirrors option text through a MutationObserver
      // (ui/select-skin.js), so editing it here repaints the visible trigger.
      const base = opt.dataset.baseLabel || (opt.dataset.baseLabel = opt.textContent);
      const want = on ? `⚠ ${base} — serving ${servedUrl.replace(/^https?:\/\//, '')}` : base;
      if (opt.textContent !== want) opt.textContent = want;
      sel.title = on
        ? `${this._activeEndpoint} is unreachable — this data comes from ${servedUrl}`
        : 'Active Prometheus endpoint';
    }

    if (on === this._endpointFailover) return;
    this._endpointFailover = on;
    this._triggerEventToast(on
      ? `${this._activeEndpoint} unreachable — showing data from ${servedUrl}`
      : 'Back on the selected Prometheus endpoint');
  }

  // The ONE thing every "active Prometheus endpoint changed" path calls —
  // the topbar picker, the modal's Select, Add-with-set_active, deleting the
  // active endpoint, and load()'s detection of another client switching it.
  // Each of those used to reset a different subset (the picker reset the job
  // filter, Add reset nothing, Delete didn't even refresh availability), and
  // none of them dropped the per-host state carried in this object — so the
  // new endpoint's fleet rendered on top of the old one's:
  //   • previousStates: same-named host with a different health on the new
  //     endpoint fires a phantom "went offline"/"back online" toast.
  //   • downStartTimes / _spotlightedInstances: old hosts' outage timers and
  //     spotlight suppression leak onto the new fleet.
  //   • acknowledgedDownInstances / isAcknowledged: the old endpoint's acks
  //     paint ✓ marks on new-endpoint tiles until the next poll.
  //   • availabilityMap / availabilityBreakdown: the 24h % and the breakdown
  //     modal keep showing the previous endpoint's numbers.
  resetForEndpointSwitch() {
    this._resetJobFilter();

    this.data = [];
    this.previousStates = {};
    this.downStartTimes = {};
    this._spotlightedInstances.clear();
    this.acknowledgedDownInstances.clear();
    this.isAcknowledged = false;
    this.availabilityMap = {};
    this.availabilityBreakdown = null;
    this.serverPayload = null;
    this.currentPage = 1;

    // A drawer left open is pinned to a host that may not exist here at all.
    if (this.selectedTarget) this._closeDrawer();
  }

  _checkStateTransitions(newTargets) {
    newTargets.forEach(t => {
      const prev = this.previousStates[t.instance];
      const curr = t.health || 'unknown';
      // Only a real 'down' ages a down-counter. 'unknown' = no Prometheus
      // sample — stamping now here is what produced the phantom "Down 57s"
      // ticker on every startup.
      if (curr === 'down') {
        // Only mirror a server-known outage start. Stamping Date.now() for a
        // host with no known start is what made every long-down host count up
        // from page load (audit 1.1); _outageStartMs() now reads downSince
        // directly and renders "start unknown" instead of inventing one.
        if (t.downSince && t.downSince > 0) {
          this.downStartTimes[t.instance] = t.downSince * 1000;
        }
      } else {
        delete this.downStartTimes[t.instance];
      }

      if (prev && prev !== curr) {
        const label = curr === 'up' ? 'back online' : (curr === 'down' ? 'went offline' : 'reporting no data');
        this._triggerEventToast(`${t.instance} ${label}`);
      }
      this.previousStates[t.instance] = curr;
    });
  }

  _fmtDownAging(ms) {
    if (!ms || ms <= 0) return '0s';
    const sec = Math.floor(ms / 1000);
    if (sec < 60) return `${sec}s`;
    if (sec < 3600) {
      const m = Math.floor(sec / 60);
      const s = sec % 60;
      return `${m}m ${s}s`;
    }
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    return `${h}h ${m}m`;
  }

  // The ONE place an outage's start is resolved, for the tile ticker, the tile
  // render and the drawer alike — so the same host can never report two
  // different durations on two screens (audit 5.6).
  //
  // Returns epoch ms, or null when the backend has no start for this outage.
  // null is a real answer, not a miss: fetch_down_since_prom_map() is bounded
  // by a [1d:1m] subquery (queries.py) and _earliest_outage_start() only
  // improves on it when a firing incident row exists, so an outage older than
  // a day with no incident row genuinely has no known start. A freshly-down
  // host always has one (its last-up sample is still inside the lookback).
  _outageStartMs(t) {
    return (t && t.downSince && t.downSince > 0) ? t.downSince * 1000 : null;
  }

  // Single place the wallboard card's down-state text is composed — reused by
  // _tickDownCounters() (per-second update) and both _renderCards() branches,
  // so the classifier's category (from /instances' failureCategory, backed by
  // classify_scrape_failure() in app.py) never has to be re-derived client-side.
  //
  // agingStr is null when the outage start is unknown — say so rather than
  // counting up from when this browser tab happened to load. The old fallback
  // stamped Date.now() per instance, so every long-dead host read the same
  // "11m 12s" and the whole wallboard looked like it had just collapsed
  // (audit 1.1).
  _downLabel(t, agingStr) {
    if (t.suppressedBy) return `↳ via ${t.suppressedBy}`;
    const cat = t.failureCategory;
    const known = agingStr !== null && agingStr !== undefined;
    // Unknown age renders as the app's existing "no value" em-dash rather than
    // a word — spelled out it wrapped every tile to two lines and made the grid
    // ragged. The tile tooltip carries the full explanation.
    const age = known ? agingStr : '—';
    return (cat && cat !== 'Unknown') ? `${cat} · ${age}` : `Down ${age}`;
  }

  // Down-aging string for a target, or null when the start is unknown.
  _downAgingFor(t, now = Date.now()) {
    const startMs = this._outageStartMs(t);
    return startMs === null ? null : this._fmtDownAging(Math.max(0, now - startMs));
  }

  // "Updated 3s ago", ageing to a warning tint when the data stops arriving.
  // Called on every poll and once a second by the ticker so a stall becomes
  // visible on its own, without waiting for a refresh that may never land.
  _renderFreshness() {
    const meta = document.getElementById('statusMeta');
    if (!meta || !this._lastDataAt) return;
    const ageSec = Math.max(0, Math.round((Date.now() - this._lastDataAt) / 1000));
    const ageTxt = ageSec < 60
      ? `${ageSec}s ago`
      : (ageSec < 3600 ? `${Math.floor(ageSec / 60)}m ago` : `${Math.floor(ageSec / 3600)}h ago`);
    meta.textContent = `Updated ${ageTxt}`;
    const intervalSec = Math.max(1, Math.round((this.refreshIntervalMs || 5000) / 1000));
    meta.classList.toggle('is-stale', ageSec > intervalSec * 3);
    meta.classList.toggle('is-very-stale', ageSec > intervalSec * 10);
    meta.setAttribute('title', `Data last received at ${new Date(this._lastDataAt).toLocaleTimeString()}`);
  }

  // ── Bulk selection (Select + Remove) ──────────────────────────────────
  // Replaces the old click-tile → drawer → Raw Metrics → Target Management
  // → Remove Target path with direct controls on the dashboard: toggle
  // Select, click hosts to mark them, Remove selected with one confirm for
  // the whole batch.
  _selectBoxHtml() {
    return '<span class="hc-select-box" aria-hidden="true">'
      + '<svg viewBox="0 0 24 24"><polyline points="4 12 8.5 16.5 20 5"/></svg></span>';
  }

  _bindSelectMode() {
    const btn = document.getElementById('selectModeBtn');
    const selectAllBtn = document.getElementById('selectAllBtn');
    const removeBtn = document.getElementById('removeSelectedBtn');
    const cancelBtn = document.getElementById('cancelSelectBtn');
    const bulkMaintBtn = document.getElementById('bulkMaintenanceBtn');
    if (btn) btn.addEventListener('click', () => this._setSelectMode(!this._selectMode));
    if (selectAllBtn) selectAllBtn.addEventListener('click', () => this._selectAllVisible());
    if (removeBtn) removeBtn.addEventListener('click', () => this._removeSelectedTargets());
    if (cancelBtn) cancelBtn.addEventListener('click', () => this._setSelectMode(false));
    if (bulkMaintBtn) bulkMaintBtn.addEventListener('click', () => this._openBulkMaintenanceModal());
    this._bindBulkMaintenanceModal();
  }

  _setSelectMode(on) {
    this._selectMode = on;
    this._selectedInstances.clear();
    const btn = document.getElementById('selectModeBtn');
    const bar = document.getElementById('selectionBar');
    if (btn) {
      btn.classList.toggle('is-active', on);
      btn.setAttribute('aria-pressed', String(on));
      const label = btn.querySelector('span');
      if (label) label.textContent = on ? 'Cancel select' : 'Select';
    }
    if (bar) bar.classList.toggle('hidden', !on);
    if (this.table) this.table.classList.toggle('select-mode', on);
    this._updateSelectionBar();
    this._render();
  }

  _toggleSelected(inst) {
    if (this._selectedInstances.has(inst)) this._selectedInstances.delete(inst);
    else this._selectedInstances.add(inst);
    const card = this.table && this.table.querySelector(`.host-card[data-instance="${CSS.escape(inst)}"]`);
    if (card) card.classList.toggle('hc-selected', this._selectedInstances.has(inst));
    this._updateSelectionBar();
  }

  _selectAllVisible() {
    if (!this.table) return;
    Array.from(this.table.querySelectorAll('.host-card')).forEach(card => {
      this._selectedInstances.add(card.dataset.instance);
      card.classList.add('hc-selected');
    });
    this._updateSelectionBar();
  }

  _updateSelectionBar() {
    const count = this._selectedInstances.size;
    const countEl = document.getElementById('selectionCount');
    if (countEl) countEl.textContent = `${count} selected`;
    const removeBtn = document.getElementById('removeSelectedBtn');
    if (removeBtn) removeBtn.disabled = count === 0;
    const bulkMaintBtn = document.getElementById('bulkMaintenanceBtn');
    if (bulkMaintBtn) bulkMaintBtn.disabled = count === 0;
  }

  async _removeSelectedTargets() {
    const instances = Array.from(this._selectedInstances);
    if (instances.length === 0) return;

    const preview = instances.slice(0, 4).join(', ') + (instances.length > 4 ? `, +${instances.length - 4} more` : '');
    const single = instances.length === 1;
    const confirmed = await window.showConfirmDialog({
      title: single ? 'Remove Target' : `Remove ${instances.length} Targets`,
      message: single
        ? `Remove "${instances[0]}" from monitoring? This stops probing it and hides it from the dashboard. Re-add anytime to restore — its history is kept.`
        : `Remove ${instances.length} targets from monitoring (${preview})? This stops probing them and hides them from the dashboard. Re-add any of them anytime to restore — history is kept.`,
      confirmText: single ? 'Remove Target' : `Remove ${instances.length} Targets`,
      cancelText: 'Cancel',
      isDanger: true
    });
    if (!confirmed) return;

    const removeBtn = document.getElementById('removeSelectedBtn');
    if (removeBtn) { removeBtn.disabled = true; removeBtn.setAttribute('aria-busy', 'true'); }

    const failures = [];
    for (const inst of instances) {
      const result = await this._deleteTarget(inst);
      if (result !== true) failures.push(typeof result === 'string' ? result : `${inst}: failed`);
    }

    const removedCount = instances.length - failures.length;
    if (removedCount > 0) {
      this._triggerEventToast(`Removed ${removedCount} target${removedCount === 1 ? '' : 's'} from monitoring.`);
    }
    if (failures.length > 0) {
      this._triggerEventToast(
        `Failed to remove ${failures.length}: ${failures.slice(0, 2).join('; ')}${failures.length > 2 ? '…' : ''}`);
    }

    this._setSelectMode(false);
    await this.load();
  }

  // Bulk Maintenance (dashboard multi-select → one confirm for the whole
  // batch) — same /api/maintenance/bulk endpoint, same duration presets and
  // SLA-exclusion behavior as the per-target drawer form (_startMaintenance
  // in target-drawer.js). Hosts already in maintenance are skipped client
  // side so re-running this on a mixed selection never double-books a host.
  _bindBulkMaintenanceModal() {
    const modal = document.getElementById('bulkMaintenanceModal');
    const closeBtn = document.getElementById('closeBulkMaintenanceModal');
    const form = document.getElementById('bulkMaintenanceForm');
    if (!modal || this._bulkMaintBound) return;
    this._bulkMaintBound = true;

    const close = () => modal.classList.add('hidden');
    if (closeBtn) closeBtn.addEventListener('click', close);
    modal.addEventListener('click', e => { if (e.target === modal) close(); });

    if (form) {
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const minutes = parseInt(document.getElementById('bulkMaintDuration')?.value, 10) || 60;
        const reason = document.getElementById('bulkMaintReasonInput')?.value.trim() || '';
        await this._startBulkMaintenance(Array.from(this._selectedInstances), minutes, reason);
      });
    }
  }

  _openBulkMaintenanceModal() {
    const modal = document.getElementById('bulkMaintenanceModal');
    const previewEl = document.getElementById('bulkMaintPreview');
    const errorEl = document.getElementById('bulkMaintError');
    if (!modal) return;
    const instances = Array.from(this._selectedInstances);
    if (instances.length === 0) return;

    if (errorEl) errorEl.classList.add('hidden');
    if (previewEl) {
      const alreadyIn = instances.filter(inst => this.data.find(t => t.instance === inst)?.maintenance);
      const eligible = instances.length - alreadyIn.length;
      const preview = instances.slice(0, 4).map(i => this._esc(i)).join(', ')
        + (instances.length > 4 ? `, +${instances.length - 4} more` : '');
      let html = `Scheduling maintenance for ${eligible} of ${instances.length} selected host${instances.length === 1 ? '' : 's'}: ${preview}`;
      if (alreadyIn.length > 0) {
        html += `<br><span style="color:var(--text-muted);">${alreadyIn.length} already in maintenance — left untouched.</span>`;
      }
      previewEl.innerHTML = html;
    }
    modal.classList.remove('hidden');
  }

  async _startBulkMaintenance(instances, minutes, reason) {
    const eligible = instances.filter(inst => !this.data.find(t => t.instance === inst)?.maintenance);
    const modal = document.getElementById('bulkMaintenanceModal');
    const errorEl = document.getElementById('bulkMaintError');
    const submitBtn = document.getElementById('bulkMaintSubmitBtn');

    if (eligible.length === 0) {
      if (errorEl) { errorEl.textContent = 'All selected hosts are already in maintenance.'; errorEl.classList.remove('hidden'); }
      return;
    }

    if (submitBtn) { submitBtn.disabled = true; submitBtn.setAttribute('aria-busy', 'true'); }
    const now = Math.floor(Date.now() / 1000);
    try {
      const res = await apiFetch('/api/maintenance/bulk', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ targets: eligible, reason, start: now, end: now + minutes * 60 })
      });
      let data = {};
      try { data = await res.json(); } catch (_) { /* non-JSON error body */ }

      if (res.ok && data.ok) {
        // Patch known results directly (same reasoning as _startMaintenance:
        // load() can be aborted mid-flight by the periodic poll, so don't
        // rely on a reload alone to reflect the new state immediately).
        (data.windows || []).forEach(mw => {
          const target = this.data.find(t => t.instance === mw.target);
          if (target) Object.assign(target, { maintenance: true, maintenanceId: mw.id, maintenanceUntil: mw.end, maintenanceReason: mw.reason });
        });
        this._triggerEventToast(`Scheduled maintenance for ${data.windows.length} host${data.windows.length === 1 ? '' : 's'}.`);
        if (modal) modal.classList.add('hidden');
        this._lastDataSignature = null;
        this._setSelectMode(false);
        this.load();
      } else if (errorEl) {
        errorEl.textContent = res.status === 403
          ? 'Permission denied: read-only accounts cannot schedule maintenance.'
          : (data.error || 'Failed to schedule maintenance');
        errorEl.classList.remove('hidden');
      }
    } finally {
      if (submitBtn) { submitBtn.disabled = false; submitBtn.removeAttribute('aria-busy'); }
    }
  }

  // Tile hover text. The hover is the operator's fastest lookup, so it carries
  // the facts they'd otherwise open the drawer for — job, outage start, failure
  // reason, who acknowledged it — instead of the old "Click to view details or
  // delete target" UI instruction (audit 4.5). acknowledged_by/_at already ship
  // on every /instances row (monitoring/engine.py), so this needs no new API.
  _cardTooltip(t, isAcked) {
    const bits = [t.instance];
    if (t.job) bits.push(`job ${t.job}`);

    if (t.maintenance) {
      bits.push('under maintenance — alerts suppressed');
    } else if (t.health === 'down') {
      const startMs = this._outageStartMs(t);
      bits.push(startMs === null
        ? 'down, outage start unknown (older than the 1-day lookback)'
        : `down since ${new Date(startMs).toLocaleString()}`);
      if (t.failureCategory && t.failureCategory !== 'Unknown') bits.push(t.failureCategory);
      if (t.suppressedBy) bits.push(`caused by ${t.suppressedBy}`);
      if (isAcked) {
        const who = t.acknowledged_by || 'operator';
        const when = t.acknowledged_at ? new Date(t.acknowledged_at * 1000).toLocaleString() : '';
        bits.push(when ? `acknowledged by ${who} ${when}` : `acknowledged by ${who}`);
      } else {
        bits.push('NOT yet acknowledged');
      }
    } else if (t.health === 'up') {
      bits.push(t.responseTimeMs != null ? `up, ${t.responseTimeMs} ms` : 'up');
    } else {
      bits.push('no probe data');
    }
    return bits.join(' · ');
  }

  _triggerEventToast(msg) {
    if (!this.eventBanner || !this.eventBannerText) return;
    this.eventBannerText.textContent = msg;
    this.eventBanner.classList.remove('hidden');
    // One timer, not one per call. Each call used to schedule its own 6s
    // hide, so in a burst (an ack fires a toast, and the same poll fires a
    // transition toast per host that moved) the FIRST timer hid a toast that
    // had only just appeared — messages flashed and vanished early.
    if (this._toastTimer) clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => {
      this._toastTimer = null;
      this.eventBanner?.classList.add('hidden');
    }, 6000);
  }

  _showError(msg) {
    if (this.errorEl) this.errorEl.classList.remove('hidden');
    if (this.errorMsg) this.errorMsg.textContent = msg || 'Prometheus engine is unreachable';
    // Preserve existing table layout and host cards so previously loaded data remains visible!
    if (this.table && (!this.data || this.data.length === 0)) {
      this._downCardElements = [];
      this._maintCardElements = [];
      this.table.innerHTML = `
        <div class="empty-state">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
          <span>Waiting for Prometheus data — ${this._esc(msg)}</span>
        </div>`;
    }
  }

  _updateStats() {
    // NOTE: total/up/down/slow here are the LIVE snapshot from /instances,
    // used to drive the alarm/ack/health-badge logic below (which must
    // always react to what's happening right now, regardless of the
    // selected history period). Normally the Total/Online/Warning/Offline/
    // Availability numbers on the summary cards are owned exclusively by
    // loadAvailability() and reflect the historical period selected in the
    // toolbar range chips — except in Realtime mode, where this same live
    // snapshot also drives those cards directly (see block below).
    const total = this.data.length;
    const up = this.data.filter(t => t.health === 'up').length;
    const down = this.data.filter(t => t.health === 'down').length;
    const slow = this.data.filter(t => t.health === 'up' && t.responseTimeMs > slowThresholdMs(t)).length;

    // Backend authoritative state (Phase 2 canonical monitoring model)
    const serverSummary = this.serverPayload ? this.serverPayload.summary : null;
    const serverStatus = this.serverPayload ? this.serverPayload.system_status : null;

    // Alarm-eligible downs — respect backend's authoritative is_alarmable flag if available,
    // otherwise fallback to non-maintenance, non-suppressed down targets.
    const alarmableDown = this.data.filter(t => t.is_alarmable !== undefined ? (t.is_alarmable && t.health !== 'up') : (t.health !== 'up' && !t.maintenance && !t.suppressedBy));
    const hasAlarm = serverSummary ? serverSummary.has_alarm : (alarmableDown.length > 0 || this.data.some(t => t.is_alarmable));

    // Unacked/acked split comes straight from the server summary
    // (FleetSummary.unacknowledged_down / acknowledged_down) — it already
    // excludes maintenance and dependency-suppressed hosts via is_alarmable,
    // so the dashboard never has to re-derive the definition. Computed here
    // because both the Offline card and the ack controls below need it.
    const unackedCount = serverSummary && typeof serverSummary.unacknowledged_down === 'number'
      ? serverSummary.unacknowledged_down
      : alarmableDown.filter(t => !t.acknowledged).length;
    const ackedCount = serverSummary && typeof serverSummary.acknowledged_down === 'number'
      ? serverSummary.acknowledged_down
      : alarmableDown.filter(t => t.acknowledged).length;

    // Live snapshot summary cards: Total Hosts, Online, Warning, Offline
    const onlineHealthy = Math.max(0, up - slow);
    if (this.statTotal) this.statTotal.textContent = total;
    if (this.statUp) this.statUp.textContent = onlineHealthy;
    const statSlow = document.getElementById('instSlow');
    if (statSlow) statSlow.textContent = slow;
    if (this.statDown) this.statDown.textContent = down;

    const downSub = document.getElementById('instDownSub');
    if (downSub) {
      if (down === 0) {
        downSub.textContent = '';
      } else if (unackedCount === 0) {
        downSub.textContent = `all ${ackedCount} acknowledged`;
      } else {
        downSub.textContent = `${unackedCount} not yet acknowledged · ${ackedCount} acknowledged`;
      }
      downSub.classList.toggle('is-urgent', unackedCount > 0);
    }

    // Only realtime mode owns Card 5 here — historical mode leaves it to
    // loadAvailability()'s /api/availability response. Previously this also
    // fired on a bare '—' placeholder (first paint / preset switch), which
    // raced that response and made the card flicker between the live
    // snapshot % and the historical %.
    if (this.isRealtime) {
      const pct = total > 0 ? (up / total) * 100 : 0;
      this.statUptime.textContent = `${pct.toFixed(2)}%`;
      // Realtime is a live snapshot, never a windowed aggregate — drop any
      // "limited data" marker left over from a historical range.
      this.statUptime.classList.remove('is-limited-data');
      this.statUptime.removeAttribute('title');
    }
    // Keep an open drawer's uptime figure live too.
    if (this.selectedTarget) {
      const fresh = this.data.find(t => t.instance === this.selectedTarget.instance) || this.selectedTarget;
      this._updateDrawerUptime(fresh);
    }

    // Last probe time
    if (this.lastProbe) {
      this.lastProbe.textContent = `Updated ${new Date().toLocaleTimeString()}`;
    }

    // Acknowledge Button & Global health badge (Server-Side Global Incident State)
    const ackBtn = document.getElementById('ackAlarmBtn');
    const ackLabel = document.getElementById('ackBtnLabel');

    // Global Server-Side Acknowledgment check
    const isGloballyAcked = serverSummary ? !!serverSummary.is_acknowledged : (alarmableDown.length > 0 && alarmableDown.every(t => t.acknowledged));
    this.isAcknowledged = isGloballyAcked;

    // Track acknowledged down instances from server payload
    const currentDownList = alarmableDown.map(t => t.instance);
    this.acknowledgedDownInstances = new Set(this.data.filter(t => t.acknowledged).map(t => t.instance));

    // Wallboard "critical spotlight" (Phase 14) — jump to a newly-down host
    // once, the moment it appears, instead of re-jumping every poll tick.
    if (this.monitor && typeof this.monitor.spotlightHost === 'function') {
      const freshlyDown = currentDownList.filter(inst => !this._spotlightedInstances.has(inst));
      currentDownList.forEach(inst => this._spotlightedInstances.add(inst));
      if (freshlyDown.length > 0) this.monitor.spotlightHost(freshlyDown[0]);
    }
    if (currentDownList.length === 0) this._spotlightedInstances.clear();

    if (hasAlarm || alarmableDown.length > 0 || slow > 0) {
      if (ackBtn) {
        ackBtn.classList.remove('hidden');
        if (this.isAcknowledged) {
          ackBtn.className = 'ack-alarm-btn ack-done is-acked';
          // Status, not an action — nothing left to ack, so no click should
          // reach the server. (className is reassigned wholesale here, which
          // is why `disabled` has to be set as a property either way.)
          ackBtn.disabled = true;
          // Single checkmark: SVG icon is already rendered in button markup,
          // so text should just be 'Acknowledged'.
          if (ackLabel) ackLabel.textContent = 'Acknowledged';
        } else {
          ackBtn.className = 'ack-alarm-btn ack-alert';
          // A read-only viewer can never ack (server 403s it — see
          // applyRolePermissions in auth.js) — this poll-driven re-render
          // must not undo that disabled/is-readonly state every tick just
          // because the className above got reassigned wholesale.
          const isReadOnlyUser = !window.currentUser
            || (window.currentUser.role !== 'admin' && window.currentUser.role !== 'owner');
          if (isReadOnlyUser) {
            ackBtn.classList.add('is-readonly');
            ackBtn.disabled = true;
            ackBtn.setAttribute('title', 'Read-only account — sign in as an operator to change this');
          } else if (!this._ackInFlight) {
            // Never leave it disabled here: a fresh unacknowledged outage after
            // an acked one must be clickable again.
            ackBtn.disabled = false;
          }
          // The button acks EVERY unacknowledged outage at once (app.py's
          // /api/alerts/ack with an empty body). Saying so on the button is
          // the difference between "I've seen this one" and silently claiming
          // the whole fleet (audit 4.2).
          if (ackLabel) {
            ackLabel.textContent = unackedCount === 1
              ? 'Acknowledge 1 outage'
              : `Acknowledge all ${unackedCount} outages`;
          }
        }
      }
    } else {
      // All clear => Hide acknowledge button and reset ack state
      this.isAcknowledged = false;
      this.acknowledgedDownInstances.clear();
      if (ackBtn) ackBtn.classList.add('hidden');
    }

    // Authoritative Global health badge & Alarm Trigger
    const isCritical = serverStatus === 'CRITICAL' || alarmableDown.length > 0;
    const isDegraded = serverStatus === 'WARNING' || slow > 0;

    if (isCritical) {
      if (this.healthBadge) {
        // In the unified Dynamic Island, when the acknowledge button is present,
        // the left side carries the severity ("Critical") while the button carries
        // the unacked/acked action or status. Avoid repeating the count/unacked text twice.
        const showAckBtn = ackBtn && !ackBtn.classList.contains('hidden');
        const badgeText = showAckBtn
          ? 'Critical'
          : (unackedCount > 0 ? `Critical · ${unackedCount} unacknowledged` : 'Critical · acknowledged');
        this.healthBadge.className = 'status-pill pill-critical';
        this.healthBadge.innerHTML = `<span class="pill-dot"></span><span class="pill-label">${this._esc(badgeText)}</span>`;
        this.healthBadge.setAttribute('title', `${alarmableDown.length} host(s) down · ${unackedCount} not yet acknowledged`);
      }
      // Siren playback itself is owned entirely by ServerMonitor's 1s alarm
      // ticker (_syncAlarmAudio), computed fresh from each target's
      // downSince/acknowledged/acknowledged_at — not driven from render.
    } else {
      if (this.healthBadge) {
        if (isDegraded) {
          this.healthBadge.className = 'status-pill pill-degraded';
          this.healthBadge.innerHTML = '<span class="pill-dot"></span><span class="pill-label">Degraded</span>';
        } else {
          this.healthBadge.className = 'status-pill pill-healthy';
          this.healthBadge.innerHTML = '<span class="pill-dot"></span><span class="pill-label">Healthy</span>';
        }
      }
    }

    // Live indicator
    const liveDot = document.getElementById('liveDot');
    if (liveDot) liveDot.style.background = isCritical ? 'var(--critical)' : (isDegraded ? 'var(--warning, #f59e0b)' : 'var(--success)');

    // statusMeta (topnav) — this is DATA FRESHNESS, not a wall clock. Rendered
    // bare it read as the current time, so a stalled backend still looked like
    // a ticking clock (audit 4.9). Relative + labelled, and it ages into a
    // warning colour once it falls behind several refresh intervals.
    this._lastDataAt = Date.now();
    this._renderFreshness();

    // Maintenance nav badge — derived from the /instances payload already
    // fetched above, no extra request.
    const maintBadge = document.getElementById('maintenanceNavBadge');
    if (maintBadge) {
      const activeCount = this.data.filter(t => t.maintenance).length;
      maintBadge.textContent = activeCount;
      maintBadge.classList.toggle('hidden', activeCount === 0);
    }
  }

  _render() {
    let rows = this.data;

    // Status filter (Warning threshold = 500ms)
    if (this.activeStatus === 'up') {
      rows = rows.filter(t => t.health === 'up' && !(t.responseTimeMs > slowThresholdMs(t)));
    } else if (this.activeStatus === 'down') {
      rows = rows.filter(t => t.health !== 'up');
    } else if (this.activeStatus === 'slow') {
      rows = rows.filter(t => t.health === 'up' && t.responseTimeMs > slowThresholdMs(t));
    }

    // Search filter
    if (this.searchQ) {
      rows = rows.filter(t => t.instance.toLowerCase().includes(this.searchQ));
    }

    if (this.countBadge) this.countBadge.textContent = rows.length;
    if (!this.table) return;

    if (rows.length === 0) {
      this._downCardElements = [];
      this._maintCardElements = [];
      this.table.innerHTML = `
        <div class="empty-state">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35"/></svg>
          <span>No hosts match the current filter</span>
        </div>`;
      return;
    }

    // Sort options: default (Prioritas: Down Pertama), name_asc, name_desc, job_asc, job_desc, latency_desc, latency_asc
    rows = [...rows].sort((a, b) => {
      // Down hosts are always pinned first, regardless of sort mode, so an
      // outage never scrolls off-screen on a filtered/sorted wallboard view.
      // Maintenance-down is expected, not an outage, so it doesn't jump the queue.
      const aDown = (a.health !== 'up' && !a.maintenance) ? 1 : 0;
      const bDown = (b.health !== 'up' && !b.maintenance) ? 1 : 0;
      if (aDown !== bDown) return bDown - aDown;

      const sortMode = this.activeSort || 'default';
      if (sortMode === 'name_asc') {
        return a.instance.localeCompare(b.instance, undefined, { numeric: true, sensitivity: 'base' });
      } else if (sortMode === 'name_desc') {
        return b.instance.localeCompare(a.instance, undefined, { numeric: true, sensitivity: 'base' });
      } else if (sortMode === 'job_asc') {
        const cmp = (a.job || '').localeCompare(b.job || '', undefined, { numeric: true, sensitivity: 'base' });
        if (cmp !== 0) return cmp;
        return a.instance.localeCompare(b.instance, undefined, { numeric: true, sensitivity: 'base' });
      } else if (sortMode === 'job_desc') {
        const cmp = (b.job || '').localeCompare(a.job || '', undefined, { numeric: true, sensitivity: 'base' });
        if (cmp !== 0) return cmp;
        return a.instance.localeCompare(b.instance, undefined, { numeric: true, sensitivity: 'base' });
      } else if (sortMode === 'latency_desc') {
        const al = a.health !== 'up' ? 999999 : (a.responseTimeMs || 0);
        const bl = b.health !== 'up' ? 999999 : (b.responseTimeMs || 0);
        if (al !== bl) return bl - al;
        return a.instance.localeCompare(b.instance, undefined, { numeric: true, sensitivity: 'base' });
      } else if (sortMode === 'latency_asc') {
        const al = a.health !== 'up' ? 999999 : (a.responseTimeMs || 0);
        const bl = b.health !== 'up' ? 999999 : (b.responseTimeMs || 0);
        if (al !== bl) return al - bl;
        return a.instance.localeCompare(b.instance, undefined, { numeric: true, sensitivity: 'base' });
      } else {
        // default: Prioritas (Down Pertama, lalu slow >500ms, lalu online)
        const ao = a.health !== 'up' ? 2 : (a.responseTimeMs > slowThresholdMs(a) ? 1 : 0);
        const bo = b.health !== 'up' ? 2 : (b.responseTimeMs > slowThresholdMs(b) ? 1 : 0);
        if (ao !== bo) return bo - ao;
        return a.instance.localeCompare(b.instance, undefined, { numeric: true, sensitivity: 'base' });
      }
    });

    this._sortedRows = rows;

    // Paginate — pageSize is adaptive (see _calculateGridCapacity), not a
    // fixed count. Clamp instead of resetting to page 1 so polling/live
    // updates never yank the operator off the page they're viewing.
    this._totalPages = Math.max(1, Math.ceil(rows.length / this.pageSize));
    this.currentPage = Math.min(Math.max(1, this.currentPage), this._totalPages);
    const startIdx = (this.currentPage - 1) * this.pageSize;
    const pageRows = rows.slice(startIdx, startIdx + this.pageSize);
    this._updatePaginationUI(rows.length, startIdx, pageRows.length);

    this._renderCards(pageRows);
  }

  // Renders exactly the given (already paginated) rows into the grid, with
  // an in-place DOM diff to avoid flicker on same-page poll refreshes.
  _renderCards(rows) {
    const now = Date.now();
    const existingDomCards = Array.from(this.table.querySelectorAll('.host-card'));
    const existingInstances = existingDomCards.map(c => c.dataset.instance);
    const newInstances = rows.map(r => r.instance);

    // Smart In-Place Update to completely eliminate refresh flicker!
    const structureMatches = existingDomCards.length === rows.length &&
      existingInstances.every((inst, idx) => inst === newInstances[idx]);

    if (structureMatches) {
      rows.forEach((t, i) => {
        const card = existingDomCards[i];
        const isUp = t.health === 'up';
        const isDown = t.health === 'down';
        const isNoData = !isUp && !isDown;   // 'unknown' — Prometheus has no probe sample; not an outage
        const isSlow = isUp && t.responseTimeMs > slowThresholdMs(t);

        const stateClass = t.maintenance ? 'hc-maintenance' : (isDown ? 'hc-down' : (isNoData ? 'hc-nodata' : (isSlow ? 'hc-slow' : 'hc-up')));
        const isAcked = isDown && !t.maintenance && this.acknowledgedDownInstances.has(t.instance);
        const isSelected = this._selectMode && this._selectedInstances.has(t.instance);
        const fullClass = `host-card ${stateClass}${t.suppressedBy ? ' hc-suppressed' : ''}${isAcked ? ' hc-acked' : ''}${isSelected ? ' hc-selected' : ''}`;
        if (card.className !== fullClass) {
          card.className = fullClass;
        }

        // The ✓ marker has to track ack state on the in-place path too, or a
        // host acknowledged between polls keeps the unacked look until the grid
        // next rebuilds its structure.
        const existingMark = card.querySelector('.hc-ack-mark');
        if (isAcked && !existingMark) {
          const mark = document.createElement('span');
          mark.className = 'hc-ack-mark';
          mark.setAttribute('aria-hidden', 'true');
          mark.textContent = '✓';
          card.appendChild(mark);
        } else if (!isAcked && existingMark) {
          existingMark.remove();
        }

        // Same in-place tracking for the select-mode checkbox overlay.
        const existingBox = card.querySelector('.hc-select-box');
        if (this._selectMode && !existingBox) {
          card.insertAdjacentHTML('afterbegin', this._selectBoxHtml());
        } else if (!this._selectMode && existingBox) {
          existingBox.remove();
        }

        let latencyText = '';
        if (t.maintenance) {
          const remainMs = t.maintenanceUntil ? Math.max(0, t.maintenanceUntil * 1000 - now) : 0;
          latencyText = `Maint ${this._fmtDownAging(remainMs)} left`;
        } else if (isNoData) {
          latencyText = 'No data';
        } else if (isDown) {
          latencyText = this._downLabel(t, this._downAgingFor(t, now));
        } else {
          latencyText = (t.responseTimeMs != null) ? `${t.responseTimeMs} ms` : '—';
        }

        const ipEl = card.querySelector('.hc-ip') || card.children[0];
        if (ipEl && ipEl.textContent !== t.instance) ipEl.textContent = t.instance;

        const latEl = card.querySelector('.hc-latency') || card.children[1];
        if (latEl && latEl.textContent !== latencyText) latEl.textContent = latencyText;

        const cardTitle = this._cardTooltip(t, isAcked);
        if (card.getAttribute('title') !== cardTitle) card.setAttribute('title', cardTitle);
      });
    } else {
      if (rows.length === 0) {
        let msg = 'No monitored hosts found.';
        if (this.searchQ) {
          msg = `No hosts matching "${this._esc(this.searchQ)}".`;
        } else if (this.activeStatus && this.activeStatus !== 'all') {
          msg = `No hosts currently with status "${this._esc(this.activeStatus)}".`;
        }
        this.table.innerHTML = `<div class="empty-state" style="grid-column: 1 / -1; padding: 40px 20px; text-align: center; color: var(--text-secondary);">
          <div style="font-size: 14px; font-weight: 500;">${msg}</div>
        </div>`;
        this._downCardElements = [];
        this._maintCardElements = [];
        return;
      }

      const focusedCard = document.activeElement ? document.activeElement.closest('.host-card') : null;
      const focusedInst = focusedCard ? focusedCard.dataset.instance : null;

      // Re-render only when structure/filter changes
      this.table.innerHTML = rows.map((t, i) => {
        const isUp = t.health === 'up';
        const isDown = t.health === 'down';
        const isNoData = !isUp && !isDown;   // 'unknown' — Prometheus has no probe sample; not an outage
        const isSlow = isUp && t.responseTimeMs > slowThresholdMs(t);

        const stateClass = t.maintenance ? 'hc-maintenance' : (isDown ? 'hc-down' : (isNoData ? 'hc-nodata' : (isSlow ? 'hc-slow' : 'hc-up')));
        const isAcked = isDown && !t.maintenance && this.acknowledgedDownInstances.has(t.instance);
        const isSelected = this._selectMode && this._selectedInstances.has(t.instance);
        const fullClass = `host-card ${stateClass}${t.suppressedBy ? ' hc-suppressed' : ''}${isAcked ? ' hc-acked' : ''}${isSelected ? ' hc-selected' : ''}`;
        let latencyText = '';
        if (t.maintenance) {
          const remainMs = t.maintenanceUntil ? Math.max(0, t.maintenanceUntil * 1000 - now) : 0;
          latencyText = `Maint ${this._fmtDownAging(remainMs)} left`;
        } else if (isNoData) {
          latencyText = 'No data';
        } else if (isDown) {
          latencyText = this._downLabel(t, this._downAgingFor(t, now));
        } else {
          latencyText = (t.responseTimeMs != null) ? `${t.responseTimeMs} ms` : '—';
        }

        return `<div class="${fullClass}"
                     data-instance="${this._esc(t.instance)}"
                     role="listitem"
                     tabindex="0"
                     aria-label="${this._esc(t.instance)} — ${t.maintenance ? 'Under maintenance' : (isDown ? (t.suppressedBy ? `Offline, correlated with ${this._esc(t.suppressedBy)}` : (isAcked ? 'Offline, acknowledged' : 'Offline, not yet acknowledged')) : (isSlow ? 'Slow' : 'Online'))}"
                     title="${this._esc(this._cardTooltip(t, isAcked))}">
          ${this._selectMode ? this._selectBoxHtml() : ''}
          <div class="hc-ip">${this._esc(t.instance)}</div>
          <div class="hc-latency">${this._esc(latencyText)}</div>
          ${isAcked ? '<span class="hc-ack-mark" aria-hidden="true">✓</span>' : ''}
        </div>`;
      }).join('');

      if (focusedInst) {
        const newFocusedCard = Array.from(this.table.querySelectorAll('.host-card')).find(c => c.dataset.instance === focusedInst);
        if (newFocusedCard) newFocusedCard.focus();
      }
    }

    // Cache down and maintenance card DOM references to avoid periodic querySelectorAll in _tickDownCounters
    this._downCardElements = Array.from(this.table.querySelectorAll('.host-card.hc-down')).map(card => ({
      inst: card.dataset.instance,
      latEl: card.querySelector('.hc-latency')
    }));
    this._maintCardElements = Array.from(this.table.querySelectorAll('.host-card.hc-maintenance')).map(card => ({
      inst: card.dataset.instance,
      latEl: card.querySelector('.hc-latency')
    }));
  }

  // Delegated D-pad/keyboard navigation for host cards — bound once on
  // #instancesBody instead of per-card, so it survives re-renders and
  // doesn't accumulate a listener per host.
  _onHostGridKeydown(e) {
    const card = e.target.closest('.host-card');
    if (!card || !this.table.contains(card)) return;

    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      const inst = card.dataset.instance;
      if (this._selectMode) {
        this._toggleSelected(inst);
        return;
      }
      const target = this.data.find(t => t.instance === inst);
      if (target) this._openDrawer(target);
      return;
    }

    const arrowKeys = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'];
    if (!arrowKeys.includes(e.key)) return;
    e.preventDefault();

    const allCards = Array.from(this.table.children).filter(el => el.classList.contains('host-card'));
    const idx = allCards.indexOf(card);
    if (idx === -1) return;

    // Resolved column count from the CSS grid (auto-fit), so this stays
    // correct across breakpoints without hardcoding a column number.
    const cols = getComputedStyle(this.table).gridTemplateColumns.split(' ').length || 1;
    let nextIdx = idx;
    if (e.key === 'ArrowRight') nextIdx = idx + 1;
    else if (e.key === 'ArrowLeft') nextIdx = idx - 1;
    else if (e.key === 'ArrowDown') nextIdx = idx + cols;
    else if (e.key === 'ArrowUp') nextIdx = idx - cols;

    nextIdx = Math.max(0, Math.min(allCards.length - 1, nextIdx));
    allCards[nextIdx]?.focus();
  }


  _relTime(iso) {
    if (!iso || iso === '—' || iso === 'null' || iso === 'undefined') return '—';
    try {
      const parsed = new Date(iso);
      if (isNaN(parsed.getTime())) return '—';
      const diff = Math.floor((Date.now() - parsed.getTime()) / 1000);
      if (diff < 0) return 'Just now';
      if (diff < 5) return 'Just now';
      if (diff < 60) return `${diff}s ago`;
      if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
      if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
      return `${Math.floor(diff / 86400)}d ago`;
    } catch { return '—'; }
  }

  _esc(s) { return escapeHtml(s); }
}

installAvailability(InstancesPage);
installTargetDrawer(InstancesPage);
