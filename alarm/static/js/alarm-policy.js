/* ════════════════════════════════════════════════════════════════════════════
   ALARM POLICY & STATE MACHINE ENGINE
   ════════════════════════════════════════════════════════════════════════════
   Decouples the audible alarm lifecycle from underlying monitoring/SLA data.
   Evaluates an explicit, deterministic state machine per target:
     NORMAL -> PENDING_ALARM -> ALARMING -> COOLDOWN -> ALARMING -> ... -> ACK -> RECOVERED

   Pure evaluation formula:
     f(target, nowMs, policy) -> { state, isAudible, label, remainingInStateS }
   No volatile or scattered setTimeout() handles. Every tick recomputes state
   fresh from authoritative server timestamps, guaranteeing seamless sync across
   tab refreshes and multi-tab sessions.
   ════════════════════════════════════════════════════════════════════════════ */

import { apiFetch } from './net.js';

export const AlarmState = Object.freeze({
  NORMAL: 'NORMAL',
  PENDING_ALARM: 'PENDING_ALARM',
  ALARMING: 'ALARMING',
  COOLDOWN: 'COOLDOWN',
  SILENT_NO_REPEAT: 'SILENT_NO_REPEAT',
  ACKNOWLEDGED: 'ACKNOWLEDGED',
  ACK_COOLDOWN: 'ACK_COOLDOWN',
  RECOVERED: 'RECOVERED'
});

export const DEFAULT_ALARM_POLICY = Object.freeze({
  initial_delay_s: 15,              // 0s = alarm immediately
  ring_duration_s: 10,              // siren duration in seconds
  repeat_interval_s: 120,           // wait time between rings (2m)
  repeat_enabled: true,             // whether repeat alarming is active
  ack_behavior: 'remind',           // 'silence' | 'remind'
  ack_reminder_interval_s: 300,     // wait time after ACK before reminder (5m)
  ack_reminder_ring_duration_s: 10, // reminder siren duration
  ack_quiet_s: 300,                 // silence right after an ACK, before the first reminder
  repeat_limit: 0,                  // stop after N repeats (0 = until acknowledged)
  new_outage_mode: 'ring',          // 'ring': a new outage rings at once, even mid-cooldown | 'wait'
  sound_id: 'alarm-default',        // active alarm sound identifier
  sound_start_s: null,              // clip start within the sound (null = whole file)
  sound_end_s: null                 // clip end within the sound
});

export const ALARM_PRESETS = Object.freeze({
  immediate: {
    initial_delay_s: 0,
    ring_duration_s: 10,
    repeat_interval_s: 60,
    repeat_enabled: true,
    ack_behavior: 'remind',
    ack_reminder_interval_s: 300,
    ack_reminder_ring_duration_s: 10,
    ack_quiet_s: 300,
    repeat_limit: 0,
    new_outage_mode: 'ring',
    sound_id: 'alarm-default',
    sound_start_s: null,
    sound_end_s: null
  },
  short_transient: {
    initial_delay_s: 15,
    ring_duration_s: 10,
    repeat_interval_s: 120,
    repeat_enabled: true,
    ack_behavior: 'remind',
    ack_reminder_interval_s: 300,
    ack_reminder_ring_duration_s: 10,
    ack_quiet_s: 300,
    repeat_limit: 0,
    new_outage_mode: 'ring',
    sound_id: 'alarm-default',
    sound_start_s: null,
    sound_end_s: null
  },
  standard: {
    initial_delay_s: 30,
    ring_duration_s: 15,
    repeat_interval_s: 180,
    repeat_enabled: true,
    ack_behavior: 'silence',
    ack_reminder_interval_s: 300,
    ack_reminder_ring_duration_s: 10,
    ack_quiet_s: 300,
    repeat_limit: 0,
    new_outage_mode: 'ring',
    sound_id: 'alarm-default',
    sound_start_s: null,
    sound_end_s: null
  }
});

/**
 * Format seconds into concise human-readable duration (e.g. 12s, 1m 45s, 12m).
 */
export function formatDurationSeconds(sec) {
  if (sec == null || isNaN(sec) || sec < 0) return '0s';
  const total = Math.round(sec);
  if (total < 60) return `${total}s`;
  const m = Math.floor(total / 60);
  const s = total % 60;
  return s > 0 ? `${m}m ${s}s` : `${m}m`;
}

// Clip bounds, same as the server's (alarm_policy.CLIP_MIN_S / CLIP_MAX_S).
export const CLIP_MIN_S = 1;
export const CLIP_MAX_S = 300;

/**
 * "80", "80.5", "1:20", "1:20.5", "0:01:20" -> seconds; NaN when unreadable.
 */
export function parseClock(str) {
  const t = String(str ?? '').trim();
  if (!/^\d+(\.\d+)?$|^\d+(:[0-5]?\d){1,2}(\.\d+)?$/.test(t)) return NaN;
  return t.split(':').reduce((acc, part) => acc * 60 + parseFloat(part), 0);
}

/** Seconds -> "1:20" / "1:20.5" / "1:02:03". */
export function formatClock(sec) {
  if (sec == null || !isFinite(sec) || sec < 0) return '0:00';
  const tenths = Math.round(sec * 10);
  const whole = Math.floor(tenths / 10);
  const frac = tenths % 10 ? `.${tenths % 10}` : '';
  const h = Math.floor(whole / 3600), m = Math.floor((whole % 3600) / 60), s = whole % 60;
  const ss = String(s).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}${frac}` : `${m}:${ss}${frac}`;
}

/**
 * Why a clip [start, end] can't be saved, or null when it can. `duration` is
 * the file's real length (from the browser's metadata) when known.
 */
export function validateClip(start, end, duration) {
  if (!isFinite(start) || !isFinite(end)) return 'Use seconds (80) or minutes:seconds (1:20).';
  if (start < 0) return 'Start cannot be negative.';
  if (end <= start) return 'End must be after start.';
  if (duration && end > duration + 0.05) return `End is past the end of the file (${formatClock(duration)}).`;
  const len = end - start;
  if (len < CLIP_MIN_S) return `Clip must be at least ${CLIP_MIN_S}s long.`;
  if (len > CLIP_MAX_S) return `Clip can be at most ${formatClock(CLIP_MAX_S)} long.`;
  return null;
}

/** The policy's clip as {start, end}, or null for the whole file. */
export function clipOf(policy) {
  const s = policy && policy.sound_start_s, e = policy && policy.sound_end_s;
  return (typeof s === 'number' && typeof e === 'number' && e > s) ? { start: s, end: e } : null;
}

/**
 * Keeps a playing <audio> inside `getClip()`'s [start, end]: seeks to the
 * start when playback begins outside it and jumps back at the end (or calls
 * `onEnd` instead, for a play-once preview). Polls every 50ms while playing
 * (timeupdate alone fires only ~4x/s: a 15s clip overran by 250ms), and also
 * checks on every timeupdate, because a hidden tab throttles that poll to
 * once a minute while media events keep arriving (live audit: a background
 * wallboard played 1:20-1:35 on to 1:59). A clip
 * that starts past the loaded file's end (e.g. the custom sound failed and
 * the built-in 3s one is playing) is ignored. Returns a detach function.
 */
export function attachClip(audio, getClip, onEnd = null) {
  let timer = null;
  const check = () => {
    const c = getClip();
    if (!c) return;
    const end = isFinite(audio.duration) && audio.duration > 0 ? Math.min(c.end, audio.duration) : c.end;
    if (c.start >= end) return;
    const t = audio.currentTime;
    if (t >= end - 0.03) {
      if (onEnd) { onEnd(); return; }
      audio.currentTime = c.start;
    } else if (t < c.start - 0.3) {
      audio.currentTime = c.start;
    }
  };
  const stop = () => { clearInterval(timer); timer = null; };
  const start = () => { check(); stop(); timer = setInterval(check, 50); };
  audio.addEventListener('play', start);
  audio.addEventListener('pause', stop);
  audio.addEventListener('ended', stop);
  audio.addEventListener('timeupdate', check);
  return () => {
    stop();
    audio.removeEventListener('timeupdate', check);
    audio.removeEventListener('play', start);
    audio.removeEventListener('pause', stop);
    audio.removeEventListener('ended', stop);
  };
}

/**
 * The siren for the whole fleet, and each host's part in it.
 *
 * One schedule, not one per host: with per-host cycles, 13 hosts that went
 * down at different moments kept the siren ringing almost non-stop and a
 * "cooldown" never silenced anything. Now:
 *   - Unacknowledged outages share one ring/cooldown cycle. Its anchor is the
 *     first ring of the newest outage (new_outage_mode 'ring': a new outage
 *     rings at once and restarts the cycle, even mid-cooldown) or of the
 *     oldest one ('wait': a new outage joins the next scheduled ring).
 *     repeat_limit stops the repeats; a new outage ('ring') starts over.
 *   - Acknowledged outages (ack_behavior 'remind') share another: silent for
 *     ack_quiet_s after the latest ACK, then a reminder ring every
 *     ack_reminder_interval_s.
 * `memory` (kept by the caller between ticks) holds the anchors, so a host
 * recovering never moves the schedule and rings the siren by surprise, and
 * the local time of an optimistic ACK the server hasn't confirmed yet (it
 * used to restart on every tick, so no reminder ever came).
 *
 * Returns { isAudible, byInstance: Map(instance -> per-host result shaped
 * like evaluateAlarmState's), summary } where summary is null when nothing
 * is in an alarm lifecycle, else
 *   { state: 'ringing'|'pending'|'cooldown'|'acked'|'silenced'|'repeat_off',
 *     reason ('once'|'limit' for repeat_off), nextRingS, ringLeftS, counts }.
 */
export function evaluateFleetAlarm(targets, nowMs, policy = DEFAULT_ALARM_POLICY, memory = {}) {
  const now = nowMs / 1000;
  const num = (v, d, min) => Math.max(min, Number.isFinite(Number(v)) && v !== null ? Number(v) : d);
  const D = num(policy.initial_delay_s, 15, 0);
  const R = num(policy.ring_duration_s, 10, 1);
  const I = num(policy.repeat_interval_s, 120, 5);
  const repeat = Boolean(policy.repeat_enabled);
  const limit = Math.floor(num(policy.repeat_limit, 0, 0));
  const mode = policy.new_outage_mode === 'wait' ? 'wait' : 'ring';
  const remind = policy.ack_behavior !== 'silence';
  const Q = num(policy.ack_quiet_s ?? policy.ack_reminder_interval_s, 300, 0);
  const AI = num(policy.ack_reminder_interval_s, 300, 5);
  const AR = num(policy.ack_reminder_ring_duration_s, 10, 1);
  if (!memory.localAckAt) memory.localAckAt = new Map();

  const unacked = [];
  const acked = [];
  const present = new Set();
  for (const t of targets || []) {
    if (!t) continue;
    const alarmable = t.is_alarmable !== undefined
      ? Boolean(t.is_alarmable)
      : (t.health !== 'up' && !t.maintenance && !t.suppressedBy);
    if (!alarmable || t.health === 'up') continue;
    present.add(t.instance);
    // No start from the server (e.g. the first poll after a restart): count
    // from when this tab first saw it down. Falling back to "now" on every
    // tick kept such a host pending forever, so it never rang.
    if (!memory.firstSeenDown) memory.firstSeenDown = new Map();
    if (!memory.firstSeenDown.has(t.instance)) memory.firstSeenDown.set(t.instance, now);
    const downSince = t.downSince > 0 ? t.downSince
      : (t.downStartTime ? t.downStartTime / 1000 : (t.downSinceMs ? t.downSinceMs / 1000 : memory.firstSeenDown.get(t.instance)));
    if (t.acknowledged || t.isAcked) {
      let at = t.acknowledged_at > 0 ? t.acknowledged_at : null;
      if (at) {
        memory.localAckAt.delete(t.instance);
      } else {
        if (!memory.localAckAt.has(t.instance)) memory.localAckAt.set(t.instance, now);
        at = memory.localAckAt.get(t.instance);
      }
      acked.push({ t, at });
    } else {
      memory.localAckAt.delete(t.instance);
      unacked.push({ t, first: downSince + D });
    }
  }
  for (const k of [...memory.localAckAt.keys()]) if (!present.has(k)) memory.localAckAt.delete(k);
  if (memory.firstSeenDown) for (const k of [...memory.firstSeenDown.keys()]) if (!present.has(k)) memory.firstSeenDown.delete(k);

  // ── Unacknowledged cycle ──
  const active = unacked.filter(x => x.first <= now);
  const pending = unacked.filter(x => x.first > now);
  let u = null;   // { ringing, left, next, done: null | 'once' | 'limit' }
  if (active.length) {
    const firsts = active.map(x => x.first);
    const newest = Math.max(...firsts);
    let A = memory.unackAnchor;
    if (A == null) A = mode === 'wait' ? Math.min(...firsts) : newest;
    else if (mode === 'ring' && newest > A) A = newest;
    memory.unackAnchor = A;
    const e = now - A;
    if (!repeat) {
      u = e < R ? { ringing: true, left: R - e, next: null, done: null } : { ringing: false, next: null, done: 'once' };
    } else {
      const cyc = R + I;
      const k = Math.floor(e / cyc);
      const pos = e - k * cyc;
      const last = limit > 0 && k >= limit;   // ring #k (0 = first) is the final one
      if (limit > 0 && k > limit) u = { ringing: false, next: null, done: 'limit' };
      else if (pos < R) u = { ringing: true, left: R - pos, next: last ? null : cyc - pos, done: null };
      else u = last ? { ringing: false, next: null, done: 'limit' } : { ringing: false, next: cyc - pos, done: null };
    }
  } else {
    memory.unackAnchor = null;
  }

  // ── Acknowledged reminders ──
  let a = null;   // { ringing, left, next, quiet }
  if (acked.length && remind) {
    const latest = Math.max(...acked.map(x => x.at));
    const B = memory.ackAnchor == null ? latest : Math.max(memory.ackAnchor, latest);
    memory.ackAnchor = B;
    const e = now - B;
    if (e < Q) {
      a = { ringing: false, next: Q - e, quiet: true };
    } else {
      const cyc = AR + AI;
      const pos = (e - Q) % cyc;
      a = pos < AR ? { ringing: true, left: AR - pos, next: cyc - pos } : { ringing: false, next: cyc - pos };
    }
  } else if (!acked.length) {
    memory.ackAnchor = null;
  }

  // ── Per host ──
  const fmt = formatDurationSeconds;
  const byInstance = new Map();
  const put = (t, state, isAudible, label, description, remaining) =>
    byInstance.set(t.instance, { state, isAudible, label, description, remainingInStateS: remaining, elapsedInStateS: 0 });
  for (const p of pending) {
    const r = p.first - now;
    put(p.t, AlarmState.PENDING_ALARM, false, `Pending (${fmt(r)})`, `Holding the alarm for the trigger delay (${fmt(r)} left)`, r);
  }
  for (const x of active) {
    if (u.ringing) put(x.t, AlarmState.ALARMING, true, `Alarming (${fmt(u.left)})`, `Alarm sounding (${fmt(u.left)} left)`, u.left);
    else if (u.done) put(x.t, AlarmState.SILENT_NO_REPEAT, false,
      u.done === 'once' ? 'Outage (Repeat Off)' : 'Outage (Repeat limit reached)',
      u.done === 'once' ? 'Rang once; repeating is off' : 'Repeat limit reached; silent until acknowledged or a new outage', null);
    else put(x.t, AlarmState.COOLDOWN, false, `Cooldown (${fmt(u.next)})`, `Alarm cooldown (${fmt(u.next)} until the next ring)`, u.next);
  }
  for (const x of acked) {
    if (!remind) put(x.t, AlarmState.ACKNOWLEDGED, false, 'Acknowledged', 'Acknowledged — silenced until recovery', null);
    else if (a.ringing) put(x.t, AlarmState.ALARMING, true, `ACK Reminder (${fmt(a.left)})`, `Reminder sounding (${fmt(a.left)} left)`, a.left);
    else put(x.t, AlarmState.ACK_COOLDOWN, false, `Acked (Remind in ${fmt(a.next)})`,
      a.quiet ? `Acknowledged — quiet for ${fmt(a.next)}, then reminders while still down` : `Acknowledged — next reminder in ${fmt(a.next)}`, a.next);
  }

  // ── Summary ──
  const counts = { ringing: 0, pending: 0, cooldown: 0, acked: 0, silenced: 0, repeat_off: 0 };
  const key = {
    ALARMING: 'ringing', PENDING_ALARM: 'pending', COOLDOWN: 'cooldown',
    ACK_COOLDOWN: 'acked', ACKNOWLEDGED: 'silenced', SILENT_NO_REPEAT: 'repeat_off',
  };
  byInstance.forEach(r => { counts[key[r.state]]++; });
  const isAudible = Boolean((u && u.ringing) || (a && a.ringing));
  const nexts = [
    ...pending.map(p => p.first - now),
    u && !u.ringing ? u.next : null,
    a && !a.ringing ? a.next : null,
  ].filter(v => typeof v === 'number');
  const lefts = [u && u.ringing ? u.left : null, a && a.ringing ? a.left : null].filter(v => typeof v === 'number');
  const state = ['ringing', 'pending', 'cooldown', 'acked', 'silenced', 'repeat_off'].find(k => counts[k] > 0);
  const summary = state ? {
    state,
    reason: u && u.done ? u.done : null,
    nextRingS: nexts.length ? Math.min(...nexts) : null,
    ringLeftS: lefts.length ? Math.max(...lefts) : null,
    counts,
  } : null;
  return { isAudible, byInstance, summary };
}

/**
 * Pure evaluation function for target alarm lifecycle state.
 *
 * @param {Object} target - Target host record from /instances
 * @param {number} [nowMs=Date.now()] - Current epoch millisecond
 * @param {Object} [policy=DEFAULT_ALARM_POLICY] - Configured policy
 * @returns {Object} { state, isAudible, label, description, remainingInStateS, elapsedInStateS }
 */
export function evaluateAlarmState(target, nowMs = Date.now(), policy = DEFAULT_ALARM_POLICY) {
  if (!target) {
    return {
      state: AlarmState.NORMAL,
      isAudible: false,
      label: 'Normal',
      description: 'No target provided',
      remainingInStateS: null,
      elapsedInStateS: 0
    };
  }

  // Derive alarmability: use backend is_alarmable flag if present, else fallback
  const isAlarmable = target.is_alarmable !== undefined
    ? Boolean(target.is_alarmable)
    : (target.health !== 'up' && !target.maintenance && !target.suppressedBy);

  if (!isAlarmable || target.health === 'up') {
    return {
      state: AlarmState.NORMAL,
      isAudible: false,
      label: 'Normal',
      description: 'Host is online or alarm suppressed',
      remainingInStateS: null,
      elapsedInStateS: 0
    };
  }

  const downSinceMs = (target.downSince && target.downSince > 0)
    ? target.downSince * 1000
    : (target.downStartTime || target.downSinceMs || nowMs);

  const isAcked = Boolean(target.acknowledged || target.isAcked);

  const elapsedS = Math.max(0, (nowMs - downSinceMs) / 1000);
  const delayS = Math.max(0, Number(policy.initial_delay_s) || 0);
  const ringS = Math.max(1, Number(policy.ring_duration_s) || 10);
  const repeatIntervalS = Math.max(5, Number(policy.repeat_interval_s) || 120);
  const repeatEnabled = Boolean(policy.repeat_enabled);
  const ackBehavior = policy.ack_behavior === 'silence' ? 'silence' : 'remind';
  const ackRemindIntervalS = Math.max(5, Number(policy.ack_reminder_interval_s) || 300);
  const ackRemindRingS = Math.max(1, Number(policy.ack_reminder_ring_duration_s) || 10);

  // ── 1. Unacknowledged Outage Lifecycle ──────────────────────────────────────
  if (!isAcked) {
    // Phase 1.1: Initial delay (debounce / transient protection)
    if (elapsedS < delayS) {
      const remaining = delayS - elapsedS;
      return {
        state: AlarmState.PENDING_ALARM,
        isAudible: false,
        label: `Pending (${formatDurationSeconds(remaining)})`,
        description: `Holding alarm for initial delay (${formatDurationSeconds(remaining)} left)`,
        remainingInStateS: remaining,
        elapsedInStateS: elapsedS
      };
    }

    const activeS = elapsedS - delayS;

    // Phase 1.2: Initial Ring Burst
    if (activeS < ringS) {
      const remaining = ringS - activeS;
      return {
        state: AlarmState.ALARMING,
        isAudible: true,
        label: `Alarming (${formatDurationSeconds(remaining)})`,
        description: `Audible alarm sounding (${formatDurationSeconds(remaining)} remaining)`,
        remainingInStateS: remaining,
        elapsedInStateS: activeS
      };
    }

    // Phase 1.3: Beyond Initial Ring
    if (!repeatEnabled) {
      return {
        state: AlarmState.SILENT_NO_REPEAT,
        isAudible: false,
        label: 'Outage (Repeat Off)',
        description: 'Initial alarm finished; repeating alerts disabled',
        remainingInStateS: null,
        elapsedInStateS: activeS - ringS
      };
    }

    // Phase 1.4: Repeat Cycle (Ring -> Cooldown -> Ring -> Cooldown)
    const cyclePeriod = ringS + repeatIntervalS;
    const cyclePos = activeS % cyclePeriod;

    if (cyclePos < ringS) {
      const remaining = ringS - cyclePos;
      return {
        state: AlarmState.ALARMING,
        isAudible: true,
        label: `Repeat Alarm (${formatDurationSeconds(remaining)})`,
        description: `Repeat alarm sounding (${formatDurationSeconds(remaining)} remaining)`,
        remainingInStateS: remaining,
        elapsedInStateS: cyclePos
      };
    } else {
      const remaining = cyclePeriod - cyclePos;
      return {
        state: AlarmState.COOLDOWN,
        isAudible: false,
        label: `Cooldown (${formatDurationSeconds(remaining)})`,
        description: `Alarm cooldown (${formatDurationSeconds(remaining)} until next alert)`,
        remainingInStateS: remaining,
        elapsedInStateS: cyclePos - ringS
      };
    }
  }

  // ── 2. Acknowledged Outage Lifecycle ────────────────────────────────────────
  if (ackBehavior === 'silence') {
    return {
      state: AlarmState.ACKNOWLEDGED,
      isAudible: false,
      label: 'Acknowledged',
      description: 'Acknowledged by operator — silenced until recovery',
      remainingInStateS: null,
      elapsedInStateS: target.acknowledged_at > 0 ? (nowMs - target.acknowledged_at * 1000) / 1000 : 0
    };
  }

  // ACK Re-alert / Reminder Cycle
  if (!target.acknowledged_at && !target._ackedAtMs) {
    target._ackedAtMs = nowMs;
  }
  const ackedAtMs = target.acknowledged_at > 0 ? target.acknowledged_at * 1000 : (target._ackedAtMs || nowMs);
  const ackElapsedS = Math.max(0, (nowMs - ackedAtMs) / 1000);

  // Initial ACK cooldown before first reminder
  if (ackElapsedS < ackRemindIntervalS) {
    const remaining = ackRemindIntervalS - ackElapsedS;
    return {
      state: AlarmState.ACK_COOLDOWN,
      isAudible: false,
      label: `Acked (Remind in ${formatDurationSeconds(remaining)})`,
      description: `Acknowledged — re-alert in ${formatDurationSeconds(remaining)} if still down`,
      remainingInStateS: remaining,
      elapsedInStateS: ackElapsedS
    };
  }

  // Subsequent reminder cycle (Reminder Ring -> Reminder Interval -> ...)
  const remindCycle = ackRemindRingS + ackRemindIntervalS;
  const remindOffset = ackElapsedS - ackRemindIntervalS;
  const remindPos = remindOffset % remindCycle;

  if (remindPos < ackRemindRingS) {
    const remaining = ackRemindRingS - remindPos;
    return {
      state: AlarmState.ALARMING,
      isAudible: true,
      label: `ACK Reminder (${formatDurationSeconds(remaining)})`,
      description: `Unresolved outage reminder sounding (${formatDurationSeconds(remaining)} left)`,
      remainingInStateS: remaining,
      elapsedInStateS: remindPos
    };
  } else {
    const remaining = remindCycle - remindPos;
    return {
      state: AlarmState.ACK_COOLDOWN,
      isAudible: false,
      label: `Acked (Remind in ${formatDurationSeconds(remaining)})`,
      description: `Acknowledged cooldown (${formatDurationSeconds(remaining)} until next reminder)`,
      remainingInStateS: remaining,
      elapsedInStateS: remindPos - ackRemindRingS
    };
  }
}

/**
 * Cross-tab audio coordinator to prevent multi-tab audio echo.
 */
class TabAudioCoordinator {
  constructor() {
    this.tabId = 'tab_' + Math.random().toString(36).slice(2, 9);
    this.isLeader = true;
    this.channel = null;
    this.lastLeaderHeartbeat = Date.now();

    if (typeof window !== 'undefined' && 'BroadcastChannel' in window) {
      try {
        this.channel = new BroadcastChannel('iw-alarm-tab-channel');
        this.channel.onmessage = (ev) => this._handleMessage(ev.data);
        window.addEventListener('beforeunload', () => {
          this.channel?.postMessage({ type: 'RELEASE', tabId: this.tabId });
        });
        window.addEventListener('focus', () => {
          this._claimLeadership();
        });
      } catch (_) {
        this.channel = null;
      }
    }
  }

  _claimLeadership() {
    this.isLeader = true;
    this.lastLeaderHeartbeat = Date.now();
    this.channel?.postMessage({ type: 'CLAIM', tabId: this.tabId });
  }

  _handleMessage(msg) {
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'CLAIM' && msg.tabId !== this.tabId) {
      // Another focused tab claimed audio leadership
      if (document.hidden) {
        this.isLeader = false;
      }
    } else if (msg.type === 'HEARTBEAT' && msg.tabId !== this.tabId) {
      this.lastLeaderHeartbeat = Date.now();
      if (document.hidden) {
        this.isLeader = false;
      }
    } else if (msg.type === 'RELEASE' && !this.isLeader) {
      this.isLeader = true;
    }
  }

  shouldPlayAudio() {
    if (!this.channel) return true; // Single-tab fallback
    if (!document.hidden) return true; // Focused tab always allowed
    return this.isLeader;
  }
}

/**
 * Alarm Policy Manager - coordinates API sync, active policy state, and listeners.
 */
export class AlarmPolicyManager {
  constructor() {
    this.policy = { ...DEFAULT_ALARM_POLICY };
    this.presets = { ...ALARM_PRESETS };
    this.isLoaded = false;
    this.listeners = new Set();
    this.tabCoordinator = new TabAudioCoordinator();
    this.fleetMemory = {};
    this.lastFleet = null;
  }

  // The one place the fleet schedule advances (the 1s alarm ticker); other
  // views read lastFleet so they agree with what the siren is doing.
  evaluateFleet(targets, nowMs = Date.now()) {
    this.lastFleet = evaluateFleetAlarm(targets, nowMs, this.policy, this.fleetMemory);
    return this.lastFleet;
  }

  // Per-host state from the latest tick; falls back to the standalone
  // evaluation before the first tick has run.
  hostState(target, nowMs = Date.now()) {
    const r = this.lastFleet && target && this.lastFleet.byInstance.get(target.instance);
    return r || evaluateAlarmState(target, nowMs, this.policy);
  }

  async load() {
    try {
      const res = await apiFetch('/api/settings/alarm-policy');
      if (res.ok) {
        const data = await res.json();
        if (data && data.policy) {
          this.policy = { ...DEFAULT_ALARM_POLICY, ...data.policy };
          if (data.presets) this.presets = { ...ALARM_PRESETS, ...data.presets };
          this.isLoaded = true;
          this._notify();
          return this.policy;
        }
      }
    } catch (e) {
      console.warn('[AlarmPolicy] Failed to load server policy, using defaults:', e);
    }
    this.isLoaded = true;
    return this.policy;
  }

  async save(newPolicy) {
    const res = await apiFetch('/api/settings/alarm-policy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(newPolicy)
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok && data.ok) {
      this.policy = { ...this.policy, ...data.policy };
      this._notify();
      return { ok: true, policy: this.policy };
    }
    return { ok: false, error: data.error || res.statusText || 'Failed to save policy' };
  }

  getPolicy() {
    return { ...this.policy };
  }

  setPolicyLocally(newPolicy) {
    this.policy = { ...this.policy, ...newPolicy };
    this._notify();
  }

  evaluate(target, nowMs = Date.now()) {
    return evaluateAlarmState(target, nowMs, this.policy);
  }

  shouldPlayAudio() {
    return this.tabCoordinator.shouldPlayAudio();
  }

  onChange(callback) {
    if (typeof callback === 'function') {
      this.listeners.add(callback);
    }
    return () => this.listeners.delete(callback);
  }

  _notify() {
    this.fleetMemory = {};   // anchors belong to the old timing
    this.listeners.forEach(cb => {
      try { cb(this.policy); } catch (e) { console.error('[AlarmPolicy] Listener error:', e); }
    });
  }
}

export const alarmPolicyManager = new AlarmPolicyManager();
