// Run: node alarm/static/js/alarm-policy.test.mjs
import assert from 'node:assert/strict';
import {
  parseClock, formatClock, validateClip, clipOf, evaluateFleetAlarm, AlarmState, DEFAULT_ALARM_POLICY,
} from './alarm-policy.js';

// Clock parsing / formatting.
assert.equal(parseClock('80'), 80);
assert.equal(parseClock('1:20'), 80);
assert.equal(parseClock('1:20.5'), 80.5);
assert.equal(parseClock('0:01:20'), 80);
assert.ok(Number.isNaN(parseClock('1:75')));
assert.ok(Number.isNaN(parseClock('abc')));
assert.ok(Number.isNaN(parseClock('')));
assert.equal(formatClock(80), '1:20');
assert.equal(formatClock(80.5), '1:20.5');
assert.equal(formatClock(3723), '1:02:03');
assert.equal(formatClock(parseClock('1:35')), '1:35');

// Clip validation: the 1:20-1:35 of a 4:00 file is fine.
assert.equal(validateClip(80, 95, 240), null);
assert.match(validateClip(NaN, 95, 240), /seconds/);
assert.match(validateClip(95, 80, 240), /after start/);
assert.match(validateClip(230, 250, 240), /past the end/);
assert.match(validateClip(10, 10.5, 240), /at least/);
assert.match(validateClip(0, 301, 400), /at most/);
assert.equal(validateClip(0, 5, null), null, 'unknown duration: bounds only');

assert.equal(clipOf(DEFAULT_ALARM_POLICY), null);
assert.deepEqual(clipOf({ sound_start_s: 80, sound_end_s: 95 }), { start: 80, end: 95 });

// Fleet siren: one shared schedule. Times below are seconds relative to T.
const T = 1_790_000_000;
const P = {
  ...DEFAULT_ALARM_POLICY, initial_delay_s: 15, ring_duration_s: 10, repeat_interval_s: 120,
  ack_quiet_s: 30, ack_reminder_interval_s: 60, ack_reminder_ring_duration_s: 10,
};
const host = (name, downAt, extra = {}) => ({ instance: name, health: 'down', is_alarmable: true, downSince: T + downAt, ...extra });
const at = (sec, targets, policy = P, mem = {}) => evaluateFleetAlarm(targets, (T + sec) * 1000, policy, mem);

assert.equal(at(0, []).summary, null);
assert.equal(at(0, [{ instance: 'u', health: 'up' }]).summary, null);

// Trigger delay, first ring, shared cooldown.
{
  const mem = {};
  const X = host('x', 0);
  let f = at(5, [X], P, mem);
  assert.equal(f.summary.state, 'pending');
  assert.equal(Math.round(f.summary.nextRingS), 10);
  f = at(20, [X], P, mem);                                     // ring 15..25
  assert.ok(f.isAudible);
  assert.equal(Math.round(f.summary.ringLeftS), 5);
  f = at(40, [X], P, mem);                                     // cooldown until 145
  assert.equal(f.summary.state, 'cooldown');
  assert.equal(Math.round(f.summary.nextRingS), 105);
  assert.equal(f.summary.ringLeftS, null);
}

// New outage during cooldown: 'ring' rings at once and restarts the cycle.
{
  const mem = {};
  const X = host('x', 0), Y = host('y', 50);                   // Y's first ring at 65
  at(40, [X], P, mem);
  let f = at(64, [X, Y], P, mem);
  assert.equal(f.summary.state, 'pending');                    // Y's first ring is what comes next
  assert.equal(f.byInstance.get('x').state, AlarmState.COOLDOWN);
  assert.equal(f.byInstance.get('y').state, AlarmState.PENDING_ALARM);
  f = at(66, [X, Y], P, mem);
  assert.ok(f.isAudible, 'new outage rings mid-cooldown');
  assert.equal(f.byInstance.get('x').state, AlarmState.ALARMING);
  f = at(80, [X, Y], P, mem);                                  // cycle now anchored at 65
  assert.equal(Math.round(f.summary.nextRingS), 115);
}

// ...'wait' joins the next scheduled ring instead.
{
  const W = { ...P, new_outage_mode: 'wait' };
  const mem = {};
  const X = host('x', 0), Y = host('y', 50);
  at(40, [X], W, mem);
  const f = at(66, [X, Y], W, mem);
  assert.ok(!f.isAudible);
  assert.equal(f.byInstance.get('y').state, AlarmState.COOLDOWN);
  assert.equal(Math.round(f.summary.nextRingS), 79);           // still the 145 ring
}

// ACK while ringing: silent at once, quiet period, then reminders.
{
  const mem = {};
  let X = host('x', 0);
  assert.ok(at(20, [X], P, mem).isAudible);
  X = host('x', 0, { acknowledged: true, acknowledged_at: T + 20 });
  let f = at(21, [X], P, mem);
  assert.ok(!f.isAudible, 'ACK silences immediately');
  assert.equal(f.summary.state, 'acked');
  assert.equal(Math.round(f.summary.nextRingS), 29);
  assert.ok(at(51, [X], P, mem).isAudible, 'first reminder after the 30s quiet');
  f = at(62, [X], P, mem);
  assert.ok(!f.isAudible);
  assert.equal(Math.round(f.summary.nextRingS), 58);           // next reminder at 120
}

// Optimistic ACK (no acknowledged_at yet): the quiet period counts down, not restarts.
{
  const mem = {};
  const X = host('x', 0, { acknowledged: true });
  assert.equal(Math.round(at(100, [{ ...X }], P, mem).summary.nextRingS), 30);
  assert.equal(Math.round(at(110, [{ ...X }], P, mem).summary.nextRingS), 20, 'fresh object each tick keeps the ACK time');
}

// New outage during the ACK quiet period still rings.
{
  const mem = {};
  const X = host('x', 0, { acknowledged: true, acknowledged_at: T + 20 });
  const Y = host('y', 10);                                     // first ring at 25
  const f = at(26, [X, Y], P, mem);
  assert.ok(f.isAudible);
  assert.equal(f.byInstance.get('x').state, AlarmState.ACK_COOLDOWN);
  assert.equal(f.byInstance.get('y').state, AlarmState.ALARMING);
}

// Repeat limit: first ring + N repeats, then silent until a new outage.
{
  const L = { ...P, repeat_limit: 1 };
  const mem = {};
  const X = host('x', 0);                                      // rings 15..25 and 145..155
  assert.ok(at(146, [X], L, mem).isAudible);
  assert.equal(at(146, [X], L, mem).summary.nextRingS, null, 'last ring: nothing after it');
  let f = at(200, [X], L, mem);
  assert.ok(!f.isAudible);
  assert.equal(f.summary.state, 'repeat_off');
  assert.equal(f.summary.reason, 'limit');
  f = at(300, [X, host('y', 280)], L, mem);                   // Y first ring at 295
  assert.ok(f.isAudible, 'a new outage starts over');
}

// Repeat off: rings once.
{
  const f = at(40, [host('x', 0)], { ...P, repeat_enabled: false });
  assert.equal(f.summary.state, 'repeat_off');
  assert.equal(f.summary.reason, 'once');
}

// A recovering host doesn't move the schedule (no surprise ring).
{
  const mem = {};
  const X = host('x', 0), Y = host('y', 100);                  // anchor 115 after Y rings
  at(116, [X, Y], P, mem);
  const f = at(160, [X], P, mem);                              // Y recovered; X alone
  assert.ok(!f.isAudible);
  assert.equal(Math.round(f.summary.nextRingS), 85);           // still 115 + 130 = 245
}

// Both groups ringing: the siren runs until the longer one ends.
{
  const mem = {};
  const X = host('x', 0, { acknowledged: true, acknowledged_at: T - 25 });   // reminder 5..15
  const Y = host('y', -8);                                                   // ring 7..17
  const f = at(9, [X, Y], P, mem);
  assert.ok(f.isAudible);
  assert.equal(Math.round(f.summary.ringLeftS), 8);
}

// No downSince from the server: counts from first sight, so it still rings.
{
  const mem = {};
  const X = { instance: 'x', health: 'down', is_alarmable: true, downSince: 0 };
  assert.equal(at(0, [X], P, mem).summary.state, 'pending');
  assert.ok(at(16, [{ ...X }], P, mem).isAudible, 'rings after the trigger delay, not pending forever');
}

// Silence after ACK.
{
  const f = at(100, [host('x', 0, { acknowledged: true, acknowledged_at: T + 50 })], { ...P, ack_behavior: 'silence' });
  assert.equal(f.summary.state, 'silenced');
  assert.equal(f.summary.nextRingS, null);
  assert.ok(!f.isAudible);
}

console.log('alarm policy helpers: ok');

// attachClip: seeks into the clip on play, loops at the end, onEnd for play-once.
{
  const { attachClip } = await import('./alarm-policy.js');
  const ev = {};
  const audio = { currentTime: 0, duration: 240, addEventListener: (k, f) => { ev[k] = f; }, removeEventListener: () => {} };
  let clip = { start: 80, end: 95 };
  const realSet = globalThis.setInterval, realClear = globalThis.clearInterval;
  let tick = null;
  globalThis.setInterval = f => { tick = f; return 1; };
  globalThis.clearInterval = () => { tick = null; };
  const detach = attachClip(audio, () => clip);
  ev.play();
  assert.equal(audio.currentTime, 80, 'play starts at clip start');
  audio.currentTime = 95; tick();
  assert.equal(audio.currentTime, 80, 'end jumps back to start');
  audio.currentTime = 0; tick();                     // native loop wrapped to 0
  assert.equal(audio.currentTime, 80);
  audio.duration = 3; audio.currentTime = 1; tick(); // clip beyond a 3s fallback file: ignored
  assert.equal(audio.currentTime, 1);
  audio.duration = 240; clip = null; audio.currentTime = 5; tick();
  assert.equal(audio.currentTime, 5, 'no clip: untouched');
  ev.pause();
  assert.equal(tick, null, 'poll stops on pause');
  // Hidden tab: no poll, but timeupdate still arrives and enforces the clip.
  clip = { start: 80, end: 95 }; audio.duration = 240; audio.currentTime = 119; ev.timeupdate();
  assert.equal(audio.currentTime, 80, 'timeupdate alone keeps the clip');
  clip = null;
  detach();
  let ended = 0;
  audio.currentTime = 0;
  clip = { start: 10, end: 12 };
  attachClip(audio, () => clip, () => { ended++; });
  ev.play(); audio.currentTime = 12; tick();
  assert.equal(ended, 1, 'play-once preview calls onEnd');
  globalThis.setInterval = realSet; globalThis.clearInterval = realClear;
}
console.log('alarm clip playback: ok');
