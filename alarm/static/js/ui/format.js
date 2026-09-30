/* Small pure formatting / escaping helpers shared across the app. */

/**
 * HTML-escape for innerHTML string building. The one implementation; each
 * page class re-exposes it as this._esc() for call-site brevity.
 * null / undefined collapse to "".
 */
export function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

/**
 * Effective "slow" latency threshold (ms) for a target. The backend sends a
 * per-instance slowThresholdMs on every /instances row (honouring
 * SlowThresholdRepository overrides); fall back to 500 for an older payload.
 * `!= null` not `||` — an override of 0 ("always slow") is valid.
 */
export function slowThresholdMs(t) {
  return (t && t.slowThresholdMs != null) ? t.slowThresholdMs : 500;
}

/**
 * Latency severity for one reading, anchored to the target's own configured
 * threshold rather than a literal. Every "is this slow?" decision in the UI
 * goes through here.
 *
 * Before this, the drawer badge called >200ms "Degraded" while the grid filter
 * called >500ms "Slow", the sparkline tooltip used a third pair of numbers, and
 * the datapoint list used a fourth — so the same 257ms sample was green in one
 * panel and amber in another (audit 2.6 / 3.7). 500ms is canonical and comes
 * from SLOW_RESPONSE_THRESHOLD_MS (config.py), per-target overridable via
 * SlowThresholdRepository, delivered on each /instances row.
 *
 *   ok       < threshold
 *   slow     >= threshold          (the configured line)
 *   critical >= threshold * 2      (a spike well past it)
 */
export const LATENCY_SPIKE_MULTIPLIER = 2;

export function latencySeverity(ms, thresholdMs) {
  const t = (typeof thresholdMs === 'number' && thresholdMs >= 0) ? thresholdMs : 500;
  if (typeof ms !== 'number' || !isFinite(ms)) return 'ok';
  if (ms >= t * LATENCY_SPIKE_MULTIPLIER) return 'critical';
  if (ms >= t) return 'slow';
  return 'ok';
}

/** Hex for a latency severity — for the inline-styled SVG/tooltip call sites. */
export function latencyColor(ms, thresholdMs) {
  return { ok: '#22C55E', slow: '#F59E0B', critical: '#EF4444' }[latencySeverity(ms, thresholdMs)];
}

// One place to change the date/time locale for every chart axis, drawer
// timestamp and log row. 'id-ID' renders 24h "HH.MM" and "DD Mmm"; switch to
// e.g. 'en-GB' for "HH:MM" if the wallboard audience is non-Indonesian.
export const DATE_LOCALE = 'id-ID';

// Alert Log / Incident History timestamps: always WIB (UTC+7), whatever the
// browser's timezone, and always with the date — a bare "00:00:00" read as
// "today" for an event from another day.
const WIB_SEC = 25200;
const pad2 = n => String(n).padStart(2, '0');

export function formatWib(ts, { seconds = false, now = Date.now() } = {}) {
  if (!ts) return '—';
  const d = new Date((ts + WIB_SEC) * 1000);
  const time = `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}${seconds ? `:${pad2(d.getUTCSeconds())}` : ''}`;
  const year = new Date(now + WIB_SEC * 1000).getUTCFullYear() === d.getUTCFullYear() ? '' : `/${d.getUTCFullYear()}`;
  return `${time} · ${pad2(d.getUTCDate())}/${pad2(d.getUTCMonth() + 1)}${year}`;
}

// "2026-09-30 21:59:55 WIB" — unambiguous, sortable (CSV export).
export function isoWib(ts) {
  if (!ts) return '';
  const d = new Date((ts + WIB_SEC) * 1000);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())} ` +
    `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}:${pad2(d.getUTCSeconds())} WIB`;
}

// <input type="datetime-local"> value ("2026-09-30T21:59") read as WIB wall
// clock, whatever the browser's timezone -> epoch seconds, or null.
export function wibInputToEpoch(v) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(v || '');
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]) / 1000 - WIB_SEC : null;
}

// Epoch seconds -> datetime-local value in WIB (inverse of the above).
export function epochToWibInput(ts) {
  return isoWib(ts).slice(0, 16).replace(' ', 'T');
}

export function getDurationFormatPreference() {
  try {
    if (typeof localStorage !== 'undefined') {
      return localStorage.getItem('infrawatch_duration_format') || 'days';
    }
  } catch {}
  return 'days';
}

export function setDurationFormatPreference(format) {
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem('infrawatch_duration_format', format);
    }
  } catch {}
  if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
    window.dispatchEvent(new CustomEvent('iw:duration-format-changed', { detail: { format } }));
  }
}

/**
 * Universal duration formatter respecting operator's 'days' vs 'hours' preference.
 * - When pref is 'days' and sec >= 86400 (24+ hours):
 *     compact: `${d}d ${h}h` (e.g. "31d 23h")
 *     full: `${d}d ${h}h ${m}m` (or `${d}d ${h}h` if m === 0)
 * - When pref is 'hours' or sec < 86400:
 *     sec < 60: `${sec}s`
 *     sec < 3600: `${m}m ${s}s`
 *     sec >= 3600: `${totalH}h ${remM}m`
 */
export function formatDuration(ms, { compact = false, mode = null } = {}) {
  if (ms == null || isNaN(ms) || ms <= 0) return '0s';
  const pref = mode || getDurationFormatPreference();
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) {
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return `${m}m ${s}s`;
  }
  const totalH = Math.floor(sec / 3600);
  const remM = Math.floor((sec % 3600) / 60);

  if (pref === 'hours' || totalH < 24) {
    return `${totalH}h ${remM}m`;
  }

  // Days format (totalH >= 24)
  const d = Math.floor(totalH / 24);
  const h = totalH % 24;
  if (compact) {
    return `${d}d ${h}h`;
  }
  return remM > 0 ? `${d}d ${h}h ${remM}m` : `${d}d ${h}h`;
}
