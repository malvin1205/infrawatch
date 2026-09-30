/* Guided Tour — step-by-step walkthrough of every screen and control.
 * Started from the user menu ("Guided Tour"). Each step names a context
 * (which modal / drawer / menu must be open) and a target to spotlight; the
 * tour opens and closes the real UI through its own buttons, so it never
 * duplicates app logic. Missing targets (e.g. admin-only controls, an empty
 * grid) fall back to a centered card instead of breaking the flow.
 */
import { isAdminLike } from './auth.js';

const $ = id => document.getElementById(id);
const click = id => $(id)?.click();
const wait = ms => new Promise(r => setTimeout(r, ms));
const isShown = el => !!el && !el.classList.contains('hidden') && el.getClientRects().length > 0;
const admin = () => isAdminLike(window.currentUser);
const up = (sel, n = 1) => () => { let el = document.querySelector(sel); while (el && n--) el = el.parentElement; return el; };
const near = (sel, anc) => () => document.querySelector(sel)?.closest(anc) || null;
const section = sel => near(sel, 'section, .form-group');

// ── Contexts: what has to be on screen for a step ─────────
const modalCtx = (openId, closeId, modalId, guard = () => true) => ({
  open: () => { if (guard() && !isShown($(modalId))) click(openId); },
  close: () => { if (isShown($(modalId))) click(closeId); },
});

const CTX = {
  none: { open() {}, close() {} },
  menu: {
    open: () => { $('userDropdown')?.classList.remove('hidden'); $('userMenuBtn')?.setAttribute('aria-expanded', 'true'); },
    close: () => { $('userDropdown')?.classList.add('hidden'); $('userMenuBtn')?.setAttribute('aria-expanded', 'false'); },
  },
  legend: {
    open: () => { if (!$('brandCluster')?.classList.contains('is-open')) click('brandStatusTrigger'); },
    close: () => { if ($('brandCluster')?.classList.contains('is-open')) click('brandStatusTrigger'); },
  },
  select: {
    open: () => { if (!$('selectModeBtn')?.disabled && $('selectModeBtn')?.getAttribute('aria-pressed') !== 'true') click('selectModeBtn'); },
    close: () => { if ($('selectModeBtn')?.getAttribute('aria-pressed') === 'true') click('cancelSelectBtn'); },
  },
  drawer: {
    open: () => {
      if ($('sideDrawer')?.classList.contains('drawer-open')) return;
      document.querySelector('#instancesBody .host-card')?.click();
    },
    close: () => { if ($('sideDrawer')?.classList.contains('drawer-open')) click('closeDrawerBtn'); },
  },
  logs: modalCtx('openLogsModalBtn', 'closeLogsModal', 'logsModal'),
  avail: modalCtx('availabilityDetailBtn', 'closeAvailabilityBreakdown', 'availabilityBreakdownModal'),
  endpoint: modalCtx('openEndpointModalBtn', 'closeEndpointModalBtn', 'endpointModal'),
  selfHealth: modalCtx('selfHealthBtn', 'closeSelfHealthModal', 'selfHealthModal'),
  addTarget: modalCtx('openAddTargetModalBtn', 'closeAddTargetModal', 'addTargetModal', admin),
  policy: modalCtx('alarmPolicyQuickBtn', 'closeAlarmPolicyModalBtn', 'alarmPolicyModal', admin),
  users: modalCtx('headerManageUsersBtn', 'closeUsersModalBtn', 'usersModal', admin),
  telegram: modalCtx('headerTelegramBtn', 'closeTelegramModalBtn', 'telegramModal', admin),
};

const drawerTab = tab => () => document.querySelector(`#modalTabsNav .modal-nav-tab[data-tab="${tab}"]`)?.click();
const ADMIN_NOTE = 'Admin / Owner only — sign in as an operator to use this.';

// ── Steps ─────────────────────────────────────────────────
// ctx: context key · sel: CSS selector or () => Element · before: runs after ctx opens
const STEPS = [
  // Welcome
  { ch: 'Welcome', ctx: 'none', title: 'Welcome to InfraWatch',
    body: 'This tour walks through every part of the dashboard: the top bar, summary cards, host grid, host details, logs, availability/SLA reports and every settings panel. Use <kbd>→</kbd> / <kbd>←</kbd> to move, <kbd>Esc</kbd> to exit, or jump to any chapter from the dropdown below.' },

  // Top bar
  { ch: 'Top bar', ctx: 'none', sel: '#brandStatusTrigger', title: 'InfraWatch logo & colour key',
    body: 'Click the logo any time to show the status colour key — the legend for every colour used on host cards.' },
  { ch: 'Top bar', ctx: 'legend', sel: '#brandStatusLegend', title: 'Status colour key',
    body: '<b>Online</b> probe OK · <b>Slow</b> response over 500 ms · <b>Down — needs acknowledging</b> an outage nobody has claimed yet · <b>Down — acknowledged ✓</b> an operator is on it · <b>Down — caused by parent</b> suppressed because an upstream host is down · <b>Maintenance</b> scheduled window, alarms suppressed · <b>No probe data</b> Prometheus has no metrics for it.' },
  { ch: 'Top bar', ctx: 'none', sel: '#globalHealthBadge', title: 'Global health badge',
    body: 'The loudest element on screen: overall fleet state (Healthy, Warning, Critical) and how many outages are still unacknowledged. If this is green, nobody needs to move.' },
  { ch: 'Top bar', ctx: 'none', sel: '#ackAlarmBtn', title: 'Acknowledge Alarm',
    body: 'Appears only while an outage is unclaimed. One click acknowledges every open outage and silences the siren. What happens afterwards (silence or reminders) is set in the Alarm Policy.' },
  { ch: 'Top bar', ctx: 'none', sel: '#alarmStatusBar', title: 'Alarm status',
    body: 'What the siren is doing right now across the whole fleet — idle, ringing, waiting for its trigger delay, or when it rings next.' },
  { ch: 'Top bar', ctx: 'none', sel: '#openLogsModalBtn', title: 'Alert logs & incident history',
    body: 'Opens the live alert stream, the full incident history and the maintenance manager. The badge counts new alerts. We will look inside later in this tour.' },
  { ch: 'Top bar', ctx: 'none', sel: '#statusMeta', title: 'Data freshness',
    body: 'Time since the last successful refresh. It turns amber, then red, if data stops arriving — a stale wallboard is as dangerous as a down host.' },
  { ch: 'Top bar', ctx: 'none', sel: near('#endpointSelect', '.dd'), title: 'Prometheus endpoint',
    body: 'Switch which Prometheus server the dashboard reads from. With several endpoints configured, InfraWatch fails over automatically if the active one stops responding.' },
  { ch: 'Top bar', ctx: 'none', sel: '#openEndpointModalBtn', title: 'Settings & endpoints',
    body: 'Add or remove Prometheus endpoints and set display preferences. Covered in the Settings chapter.' },
  { ch: 'Top bar', ctx: 'none', sel: near('#scrapeIntervalSelect', '.dd'), title: 'Auto-refresh interval',
    body: 'How often the dashboard pulls fresh data: 2 s, 5 s, 10 s or 30 s.' },
  { ch: 'Top bar', ctx: 'none', sel: '#refreshInstances', title: 'Refresh now',
    body: 'Forces an immediate refresh without waiting for the next interval.' },
  { ch: 'Top bar', ctx: 'none', sel: '#soundToggleBtn', title: 'Alarm sound',
    body: 'Mutes or arms the siren in this browser. Filled speaker = armed, crossed-out = muted. Muting here does not acknowledge anything.' },
  { ch: 'Top bar', ctx: 'none', sel: '#alarmPolicyQuickBtn', title: 'Alarm Policy shortcut',
    body: 'Quick access to the Alarm Policy: when the siren starts, how long it rings, and what happens after acknowledgment.' },
  { ch: 'Top bar', ctx: 'none', sel: '#selfHealthBtn', title: 'InfraWatch self-status',
    body: 'A dot showing whether InfraWatch itself is healthy — its background poller, aggregator and Prometheus connection. Click it for details.' },
  { ch: 'Top bar', ctx: 'selfHealth', sel: '#selfHealthList', title: 'Self-status details',
    body: 'Each internal component with its current state and last heartbeat. Check here first if the dashboard looks frozen.' },
  { ch: 'Top bar', ctx: 'none', sel: '#userMenuBtn', title: 'Your account',
    body: 'Shows who is signed in and their role: <b>Owner</b> (founding account), <b>Admin</b>, or <b>Viewer</b> (read-only). Guests see the dashboard read-only.' },
  { ch: 'Top bar', ctx: 'menu', sel: '#userDropdown', title: 'Account menu',
    body: 'Alarm Policy, Manage Users and Telegram Alerts (admins only), this Guided Tour, and Log In / Log Out.' },
  { ch: 'Top bar', ctx: 'none', sel: '#themeToggleBtn', title: 'Light / dark theme',
    body: 'Switches between dark (best for wallboards) and light theme. Remembered in this browser.' },

  // Summary
  { ch: 'Summary cards', ctx: 'none', sel: '.summary-row', title: 'Summary cards',
    body: 'Fleet at a glance: <b>Total Hosts</b>, <b>Online</b>, <b>Warning</b> (slow), and <b>Offline</b>. The small line under Offline says how many outages are already acknowledged. Hosts in maintenance or suppressed by a parent are not counted as offline.' },
  { ch: 'Summary cards', ctx: 'none', sel: '.sc-availability', title: 'Availability card',
    body: 'Fleet availability over the selected time range, compared to your SLA target. Click <b>Detail</b> for the full availability report.' },

  // Host grid toolbar
  { ch: 'Host grid', ctx: 'none', sel: '#rangeFilterChips', title: 'Time range',
    body: 'Sets the period for availability figures: Realtime, 24h, 7d, 30d, Month to date (from 00:00 WIB on the 1st), or a Custom Range with your own From/To.' },
  { ch: 'Host grid', ctx: 'none', sel: near('#sortSelect', '.filter-select-wrap'), title: 'Sort',
    body: 'Priority puts down hosts first (default). Also sort by host name, job, or latency.' },
  { ch: 'Host grid', ctx: 'none', sel: '#jobDdTrigger', title: 'Job filter',
    body: 'Show only hosts from one Prometheus job (e.g. a site, network or service group).' },
  { ch: 'Host grid', ctx: 'none', sel: '#jobDefaultSettingsBtn', title: 'Default job',
    body: 'Make the current job your default so the dashboard opens filtered to it, or reset back to “All Jobs”. Stored per endpoint, in this browser only.' },
  { ch: 'Host grid', ctx: 'none', sel: '.search-wrap', title: 'Search',
    body: 'Filter by IP, hostname or job name as you type. The × clears it.' },
  { ch: 'Host grid', ctx: 'none', sel: '#statusFilterChips', title: 'Status filters',
    body: 'All · Online · Offline · <b>Unacknowledged</b> (outages nobody has claimed) · Maintenance · Slow (&gt;500 ms).' },
  { ch: 'Host grid', ctx: 'none', sel: '#openAddTargetModalBtn', title: 'Add target', note: ADMIN_NOTE,
    body: 'Restore a target that was removed from the dashboard. Targets come from Prometheus automatically — there is nothing to configure by hand.' },
  { ch: 'Host grid', ctx: 'addTarget', sel: '#addTargetForm', title: 'Add Monitoring Target', note: ADMIN_NOTE,
    body: 'Pick a hidden target from the list Prometheus is scraping and click Add. It reappears on the wallboard with its history intact.' },
  { ch: 'Host grid', ctx: 'none', sel: '#selectModeBtn', title: 'Select mode', note: ADMIN_NOTE,
    body: 'Turns the grid into checkboxes so you can act on many hosts at once.' },
  { ch: 'Host grid', ctx: 'select', sel: '#selectionBar', title: 'Bulk actions', note: ADMIN_NOTE,
    body: 'Tick hosts (or <b>Select all</b>), then <b>Maintenance</b> to schedule a window for all of them, <b>Parent host</b> to link them all to one upstream host (or remove their parent), or <b>Remove selected</b> to hide them. <b>Cancel</b> leaves select mode.' },
  { ch: 'Host grid', ctx: 'none', sel: '#instanceCount', title: 'Host count',
    body: 'How many hosts match the current filters.' },
  { ch: 'Host grid', ctx: 'none', sel: '#instancesBody .host-card', title: 'Host card',
    body: 'One card per target: colour = status (see the colour key), live latency, HTTP response code and job. Click a card to open its detail drawer.' },
  { ch: 'Host grid', ctx: 'none', sel: '#hostPagination', title: 'Pages & auto-rotate',
    body: 'When hosts do not fit on one screen, they are split into pages sized to your display. <b>Auto Rotate</b> cycles pages automatically — ideal for a TV wallboard.' },

  // Drawer
  { ch: 'Host details', ctx: 'drawer', sel: '#sideDrawer .drawer-title-group', title: 'Host detail drawer',
    body: 'Host name, job, current status and alarm state.' },
  { ch: 'Host details', ctx: 'drawer', sel: '#drawerAckBtn', title: 'Acknowledge this host',
    body: 'Claims just this outage (the top-bar button claims all of them). Next to it: refresh this host and close the drawer.' },
  { ch: 'Host details', ctx: 'drawer', sel: '#modalTabsNav', title: 'Drawer tabs',
    body: 'Overview · History · Events · Maintenance · Settings. Let’s go through each one.' },
  { ch: 'Host details', ctx: 'drawer', before: drawerTab('overview'), sel: '#tabPaneOverview .drawer-metrics-grid', title: 'Overview — status',
    body: 'Current status, last check time, latency, HTTP code, probe state and uptime streak.' },
  { ch: 'Host details', ctx: 'drawer', before: drawerTab('overview'), sel: '#spRangeGroup', title: 'Response-time trend',
    body: 'Latency chart for ranges from 5 minutes to 30 days, month-to-date (MTD) or a custom range, with Now / Avg / P95 / Max stats. Drag on the chart to zoom; <b>Reset zoom</b> undoes it.' },
  { ch: 'Host details', ctx: 'drawer', before: drawerTab('overview'), sel: '#drawerAvailabilityBars', title: 'Availability bars',
    body: 'Hour-by-hour availability for the last 24 hours. Red slices are outages.' },
  { ch: 'Host details', ctx: 'drawer', before: drawerTab('overview'), sel: near('#drawerInfoIp', '.drawer-section-card'), title: 'Target info',
    body: 'IP, job, protocol, Blackbox probe module, target URL, and last / next scrape time.' },
  { ch: 'Host details', ctx: 'drawer', before: drawerTab('overview'), sel: near('#drawerRecentEventsList', '.drawer-section-card'), title: 'Recent events & probe summary',
    body: 'Latest state changes for this host (<b>View all</b> jumps to the Events tab), followed by a probe summary: total/failed probes, SLA badge, MTTR, longest and last outage.' },
  { ch: 'Host details', ctx: 'drawer', before: drawerTab('history'), sel: '#tabPaneHistory', title: 'History tab',
    body: 'Detailed response-time history with min / avg / P95 / max and the raw datapoints.' },
  { ch: 'Host details', ctx: 'drawer', before: drawerTab('events'), sel: '#tabPaneEvents', title: 'Events tab',
    body: 'Every firing / resolved event for this host.' },
  { ch: 'Host details', ctx: 'drawer', before: drawerTab('maintenance'), sel: '#drawerMaintenanceSection', title: 'Maintenance tab', note: ADMIN_NOTE,
    body: 'Start a maintenance window (30 min – 24 h, optional reason) to suppress alarms while you work on this host. An active window shows a countdown and an <b>End Early</b> button.' },
  { ch: 'Host details', ctx: 'drawer', before: drawerTab('raw'), sel: '#drawerDependencySection', title: 'Settings tab — parent host', note: ADMIN_NOTE,
    body: 'Link this host to a parent (e.g. its gateway or switch). When the parent is down, this host’s outage is marked “caused by parent” and does not trigger its own alarm.' },

  // Logs
  { ch: 'Logs & history', ctx: 'logs', before: () => click('logsTabBtn'), sel: '#logsTabPanel', title: 'Live Alert Log',
    body: 'Real-time stream of FIRING and RESOLVED alerts. Search, filter by All / Firing / Resolved, pause the live stream, or <b>Hide older</b> (this browser only — nothing is deleted on the server).' },
  { ch: 'Logs & history', ctx: 'logs', before: () => click('historyTabBtn'), sel: '#historyTabPanel', title: 'Incident History',
    body: 'Every past incident with totals, this-month, critical and warning counts. Filter by severity, ongoing/resolved, job and range; sort; <b>Export CSV</b> for reports; <b>Show more</b> pages further back.' },
  { ch: 'Logs & history', ctx: 'logs', before: () => click('maintenanceTabBtn'), sel: '#maintenanceTabPanel', title: 'Maintenance manager',
    body: 'All active and scheduled maintenance windows across the fleet in one list.' },

  // Availability
  { ch: 'Availability & SLA', ctx: 'avail', before: () => click('btnSubnavRanking'), sel: near('#modalRangeSelect', '.dd'), title: 'Availability report',
    body: 'Deep availability for the fleet. Pick the range here (1 hour to 90 days); the rest of the report follows it.' },
  { ch: 'Availability & SLA', ctx: 'avail', sel: '#availSettingsBtn', title: 'Availability settings',
    body: 'Set the fleet-wide SLA target (%) and choose whether node-exporter data is used in the calculation.' },
  { ch: 'Availability & SLA', ctx: 'avail', before: () => click('btnSubnavRanking'), sel: '.avail-hero-grid', title: 'Fleet overview',
    body: '<b>Fleet Availability</b> — observed uptime across all monitored hosts. <b>Healthy Hosts</b> — how many never went down in this range, with the uptime/downtime split. A “Limited data” warning appears when only part of the window has telemetry; <b>View telemetry audit</b> explains the gap.' },
  { ch: 'Availability & SLA', ctx: 'avail', before: () => click('btnSubnavRanking'), sel: near('#avbTrendPlot', '.avb-trend-card'), title: 'Availability trend',
    body: 'Availability over time. Drag to zoom, click a point for event detail, <b>Today</b> jumps to the current day.' },
  { ch: 'Availability & SLA', ctx: 'avail', before: () => click('btnSubnavRanking'), sel: near('#avbCalendarGrid', '.avb-trend-card'), title: 'Downtime calendar',
    body: 'One cell per day, coloured by downtime. Click a day for details; <b>Highlight 3 worst days</b> finds problem days fast.' },
  { ch: 'Availability & SLA', ctx: 'avail', before: () => click('btnSubnavRanking'), sel: '#hostsRequiringAttentionList', title: 'Hosts requiring attention',
    body: 'Hosts ranked by availability and impact. Sort by name, availability or impact; click a host to open its drawer; <b>View all</b> shows every host.' },
  { ch: 'Availability & SLA', ctx: 'avail', before: () => click('btnSubnavRanking'), sel: '#btnLearnCalculations', title: 'How it is calculated',
    body: '<b>Learn more about calculations</b> opens a plain-language explanation of every number above, so an SLA figure can always be defended.' },
  { ch: 'Availability & SLA', ctx: 'avail', before: () => click('btnSubnavAudit'), sel: '#auditSlaCard', title: 'SLA audit',
    body: 'Measured SLA against target, with maintenance time accounted for.' },
  { ch: 'Availability & SLA', ctx: 'avail', before: () => click('btnSubnavAudit'), sel: '#auditBudgetCard', title: 'Error budget',
    body: 'How much allowed downtime is used, and a projection of whether you will stay within target by the end of the period.' },
  { ch: 'Availability & SLA', ctx: 'avail', before: () => click('btnSubnavAudit'), sel: '#auditStatus', title: 'Data source status',
    body: 'Where the numbers came from (Prometheus TSDB and/or stored hourly buckets) and whether they are complete.' },

  // Settings
  { ch: 'Settings', ctx: 'endpoint', sel: '#addEndpointForm', title: 'Prometheus endpoints', note: ADMIN_NOTE,
    body: 'Add another Prometheus URL. Multiple endpoints give you automatic failover.' },
  { ch: 'Settings', ctx: 'endpoint', sel: '#endpointListContainer', title: 'Endpoint list',
    body: 'All configured endpoints: activate, remove, and see which one is live.' },
  { ch: 'Settings', ctx: 'endpoint', sel: up('#durationPrefDays', 3), title: 'Duration display',
    body: 'How durations over 24 h are written on cards, the drawer and logs — e.g. <b>31d 23h</b> versus <b>767h</b>.' },

  { ch: 'Alarm Policy', ctx: 'policy', sel: section('#apPresetTitle'), title: 'Presets', note: ADMIN_NOTE,
    body: 'Start from a preset: <b>Immediate</b>, <b>Short transient</b> (ignore brief blips), <b>Standard</b>, or <b>Custom</b>. The summary line describes the behaviour in plain words.' },
  { ch: 'Alarm Policy', ctx: 'policy', sel: section('#apTimingTitle'), title: 'Timing', note: ADMIN_NOTE,
    body: '<b>Trigger delay</b> — how long a host must be down before the siren starts. <b>Ring duration</b>, optional <b>repeat</b> interval and a <b>Stop after</b> limit. Also: whether a new outage re-rings immediately or waits.' },
  { ch: 'Alarm Policy', ctx: 'policy', sel: section('#apAckTitle'), title: 'After acknowledgment', note: ADMIN_NOTE,
    body: 'Either stay silent once acknowledged, or remind: quiet period, reminder interval and reminder ring length.' },
  { ch: 'Alarm Policy', ctx: 'policy', sel: section('#apSoundTitle'), title: 'Siren sound', note: ADMIN_NOTE,
    body: 'Choose, preview or delete sounds; upload your own file or import from YouTube; trim a clip with the start/end sliders. <b>Save policy</b> applies it for everyone.' },

  { ch: 'Users', ctx: 'users', sel: '#usersListContainer', title: 'Manage users', note: ADMIN_NOTE,
    body: 'Everyone who can sign in. Change roles (Admin / Viewer) or deactivate accounts. The Owner account is protected, and the last active admin cannot be disabled.' },
  { ch: 'Users', ctx: 'users', sel: '#createUserForm', title: 'Add a user', note: ADMIN_NOTE,
    body: 'Username, display name, password (12+ characters) and role. Use <b>Viewer</b> for wallboard TVs.' },

  { ch: 'Telegram', ctx: 'telegram', sel: '#telegramSettingsForm', title: 'Telegram alerts', note: ADMIN_NOTE,
    body: 'Enable notifications, enter the <b>Bot Token</b> and <b>Chat ID</b>, choose the minimum severity and whether to send FIRING and/or RESOLVED messages. <b>Test</b> sends a sample message before you save.' },

  // Finish
  { ch: 'Finish', ctx: 'none', title: 'You’re all set',
    body: 'Tips: <kbd>Esc</kbd> (or a TV remote’s Back) closes any open panel. Click <b>Masuk &amp; Aktifkan Audio Alarm</b> on the splash screen so the browser allows the siren. Re-run this tour any time from the account menu.' },
];

// ── Engine ────────────────────────────────────────────────
let idx = 0, ctx = 'none', root, spot, card, token = 0;

function pickTarget(step) {
  if (!step.sel) return null;
  const el = typeof step.sel === 'function' ? step.sel() : document.querySelector(step.sel);
  return el && el.getClientRects().length && el.offsetWidth + el.offsetHeight > 0 ? el : null;
}

function build() {
  root = document.createElement('div');
  root.className = 'tour-root';
  root.innerHTML = `
    <div class="tour-blocker"></div>
    <div class="tour-spot hidden"></div>
    <div class="tour-card" role="dialog" aria-modal="true" aria-labelledby="tourTitle">
      <div class="tour-progress"><span class="tour-progress-fill"></span></div>
      <div class="tour-head">
        <select class="tour-chapter" aria-label="Jump to chapter"></select>
        <span class="tour-count"></span>
      </div>
      <h3 class="tour-title" id="tourTitle"></h3>
      <div class="tour-body"></div>
      <div class="tour-note hidden"></div>
      <div class="tour-actions">
        <button type="button" class="btn btn-secondary btn-sm tour-skip">Exit tour</button>
        <span class="tour-spacer"></span>
        <button type="button" class="btn btn-secondary btn-sm tour-prev">Back</button>
        <button type="button" class="btn btn-primary btn-sm tour-next">Next</button>
      </div>
    </div>`;
  // Keep tour clicks away from the app's outside-click handlers (they would
  // close the very menu / popover a step just opened).
  root.addEventListener('click', e => e.stopPropagation());
  document.body.appendChild(root);
  spot = root.querySelector('.tour-spot');
  card = root.querySelector('.tour-card');

  const chapters = [...new Set(STEPS.map(s => s.ch))];
  const sel = root.querySelector('.tour-chapter');
  sel.innerHTML = chapters.map(c => `<option>${c}</option>`).join('');
  sel.addEventListener('change', () => go(STEPS.findIndex(s => s.ch === sel.value)));
  root.querySelector('.tour-skip').addEventListener('click', end);
  root.querySelector('.tour-prev').addEventListener('click', () => go(idx - 1));
  root.querySelector('.tour-next').addEventListener('click', () => (idx === STEPS.length - 1 ? end() : go(idx + 1)));
  window.addEventListener('keydown', onKey, true);
  window.addEventListener('resize', place);
  window.addEventListener('scroll', place, true);
}

function onKey(e) {
  if (e.target.closest?.('.tour-card select')) return;
  if (['Escape', 'GoBack', 'Backspace'].includes(e.key)) { e.preventDefault(); e.stopImmediatePropagation(); end(); }
  else if (e.key === 'ArrowRight') { e.preventDefault(); e.stopImmediatePropagation(); if (idx < STEPS.length - 1) go(idx + 1); }
  else if (e.key === 'ArrowLeft') { e.preventDefault(); e.stopImmediatePropagation(); if (idx > 0) go(idx - 1); }
}

async function go(i) {
  if (i < 0 || i >= STEPS.length) return;
  const my = ++token;
  idx = i;
  const step = STEPS[i];
  if (step.ctx !== ctx) {
    CTX[ctx].close();
    ctx = step.ctx;
    CTX[ctx].open();
    await wait(380);
  }
  if (my !== token) return;
  if (step.before) { step.before(); await wait(200); }
  if (my !== token) return;
  render(step);
}

function render(step) {
  const target = pickTarget(step);
  card.querySelector('.tour-title').textContent = step.title;
  card.querySelector('.tour-body').innerHTML = step.body;
  const noteEl = card.querySelector('.tour-note');
  const note = step.note && !admin() ? step.note
    : step.sel && !target ? 'This element isn’t visible right now (it appears only when relevant, or there is no data yet).'
    : '';
  noteEl.textContent = note;
  noteEl.classList.toggle('hidden', !note);
  card.querySelector('.tour-count').textContent = `${idx + 1} / ${STEPS.length}`;
  card.querySelector('.tour-chapter').value = step.ch;
  card.querySelector('.tour-progress-fill').style.width = `${((idx + 1) / STEPS.length) * 100}%`;
  card.querySelector('.tour-prev').disabled = idx === 0;
  card.querySelector('.tour-next').textContent = idx === STEPS.length - 1 ? 'Finish' : 'Next';
  root._target = target;
  target?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  place();
  card.querySelector('.tour-next').focus({ preventScroll: true });
}

function place() {
  if (!root) return;
  const t = root._target;
  const vw = window.innerWidth, vh = window.innerHeight, pad = 6, gap = 12, m = 12;
  const cw = card.offsetWidth, chh = card.offsetHeight;
  if (!t || !t.isConnected) {
    spot.classList.add('hidden');
    root.classList.add('tour-dim');
    card.style.left = `${Math.max(m, (vw - cw) / 2)}px`;
    card.style.top = `${Math.max(m, (vh - chh) / 2)}px`;
    return;
  }
  root.classList.remove('tour-dim');
  // Snap to device pixels: at fractional zoom (e.g. 125%) an unsnapped ring
  // renders crisp on one side and blurred on the other.
  const dpr = window.devicePixelRatio || 1, snap = v => Math.round(v * dpr) / dpr;
  const r = t.getBoundingClientRect();
  const x = snap(Math.max(2, r.left - pad)), y = snap(Math.max(2, r.top - pad));
  const w = snap(Math.min(vw - 2, r.right + pad)) - x, h = snap(Math.min(vh - 2, r.bottom + pad)) - y;
  // Concentric corners: target radius + padding, so the gap reads even all round.
  const tr = parseFloat(getComputedStyle(t).borderTopLeftRadius) || 0;
  const radius = Math.min(tr ? tr + pad : 8, h / 2, w / 2);
  Object.assign(spot.style, { left: `${x}px`, top: `${y}px`, width: `${w}px`, height: `${h}px`, borderRadius: `${radius}px` });
  spot.classList.remove('hidden');

  let top = y + h + gap;                                   // below
  if (top + chh > vh - m) top = y - chh - gap;             // above
  let left = x + w / 2 - cw / 2;
  if (top < m) {                                           // tall target: beside it
    top = Math.min(Math.max(m, y), vh - chh - m);
    left = x + w + gap + cw <= vw - m ? x + w + gap : x - cw - gap;
  }
  card.style.left = `${Math.min(Math.max(m, left), vw - cw - m)}px`;
  card.style.top = `${Math.min(Math.max(m, top), vh - chh - m)}px`;
}

function end() {
  if (!root) return;
  token++;
  CTX[ctx].close();
  ctx = 'none';
  window.removeEventListener('keydown', onKey, true);
  window.removeEventListener('resize', place);
  window.removeEventListener('scroll', place, true);
  root.remove();
  root = null;
  $('headerTourBtn')?.focus();
}

export function startTour() {
  if (root) return;
  $('userDropdown')?.classList.add('hidden');
  build();
  ctx = 'none';
  go(0);
}

export function initTour() {
  $('headerTourBtn')?.addEventListener('click', startTour);
}
