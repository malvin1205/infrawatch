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
  sound_id: 'alarm-default'         // active alarm sound identifier
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
    sound_id: 'alarm-default'
  },
  short_transient: {
    initial_delay_s: 15,
    ring_duration_s: 10,
    repeat_interval_s: 120,
    repeat_enabled: true,
    ack_behavior: 'remind',
    ack_reminder_interval_s: 300,
    ack_reminder_ring_duration_s: 10,
    sound_id: 'alarm-default'
  },
  standard: {
    initial_delay_s: 30,
    ring_duration_s: 15,
    repeat_interval_s: 180,
    repeat_enabled: true,
    ack_behavior: 'silence',
    ack_reminder_interval_s: 300,
    ack_reminder_ring_duration_s: 10,
    sound_id: 'alarm-default'
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
    this.listeners.forEach(cb => {
      try { cb(this.policy); } catch (e) { console.error('[AlarmPolicy] Listener error:', e); }
    });
  }
}

export const alarmPolicyManager = new AlarmPolicyManager();
