import { apiFetch } from './net.js';
import { escapeHtml, DATE_LOCALE, getDurationFormatPreference, setDurationFormatPreference } from './ui/format.js';
import { InstancesPage } from './dashboard.js';
import { LogsPage } from './logs.js';
import { HistoryPage } from './history.js';
import {
  alarmPolicyManager,
  evaluateAlarmState,
  AlarmState,
  formatDurationSeconds,
  ALARM_PRESETS,
  DEFAULT_ALARM_POLICY,
  parseClock,
  formatClock,
  validateClip,
  clipOf,
  attachClip,
  CLIP_MIN_S
} from './alarm-policy.js';

/* ════════════════════════════════════════════════════════════════════════════
   MAIN MONITOR (Dashboard + coordination)
   ════════════════════════════════════════════════════════════════════════════ */

export class ServerMonitor {
  constructor() {
    this.isMuted = false;
    this.isInitialized = false;
    this._alarmTickHandle = null;

    // ── DOM refs ──────────────────────────────────
    this.alarmAudio = document.getElementById('alarmAudio');
    this._previewAudio = new Audio();
    if (this.alarmAudio) {
      this.alarmAudio.dataset.soundId = 'alarm-default';
      this.alarmAudio.addEventListener('error', () => {
        if (this.alarmAudio.dataset.soundId !== 'alarm-default') {
          console.warn('[InfraWatch] Custom alarm sound failed to load, falling back to built-in sound');
          this.alarmAudio.dataset.soundId = 'alarm-default';
          this.alarmAudio.src = '/static/audio/alarm.mp3';
          this.alarmAudio.load();
        }
      });
      attachClip(this.alarmAudio, () => {
        const policy = alarmPolicyManager.getPolicy();
        return this.alarmAudio.dataset.soundId === (policy.sound_id || 'alarm-default') ? clipOf(policy) : null;
      });
    }

    // ── Sub-pages ─────────────────────────────────
    this.instancesPage = new InstancesPage(this);
    this.logsPage = new LogsPage(this);
    this.historyPage = new HistoryPage(this);

    this._bindLogsModal();
    this._bindSelfHealthModal();
    this._bindAlarmPolicyModal();
    this._bindEvents();
    alarmPolicyManager.onChange(() => this._syncAlarmAudio());
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
    alarmPolicyManager.load().then(() => this._syncAlarmAudio());
    alarmPolicyManager.onChange(() => this._syncAlarmAudio());
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
    // timer except the alarm while the tab/display is hidden (a backgrounded wallboard was
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
        // The siren must keep working in a background tab: the alarm worker
        // keeps ticking and polls /instances (_startAlarmTicker) in place of
        // the page timer the browser throttles to once a minute.
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

  _bindAlarmPolicyModal() {
    const modal = document.getElementById('alarmPolicyModal');
    if (!modal) return;
    const $ = id => document.getElementById(id);

    const openBtns = [$('headerAlarmPolicyBtn'), $('alarmPolicyQuickBtn')].filter(Boolean);
    const form = $('alarmPolicyForm');
    const presetChips = $('alarmPresetsChips');
    const summaryEl = $('apSummary');
    const errorEl = $('apError');
    const submitBtn = $('apSubmitBtn');

    const initialDelayInput = $('apInitialDelayInput');
    const ringDurationInput = $('apRingDurationInput');
    const repeatEnabledCheckbox = $('apRepeatEnabledCheckbox');
    const repeatIntervalInput = $('apRepeatIntervalInput');
    const repeatIntervalGroup = $('apRepeatIntervalGroup');
    const ackSilenceRadio = $('apAckSilenceRadio');
    const ackRemindRadio = $('apAckRemindRadio');
    const ackRemindControls = $('apAckRemindControls');
    const ackReminderIntervalInput = $('apAckReminderIntervalInput');
    const ackReminderRingInput = $('apAckReminderRingInput');
    const ackQuietInput = $('apAckQuietInput');
    const repeatLimitInput = $('apRepeatLimitInput');
    const repeatLimitRow = $('apRepeatLimitRow');
    const ignoreCooldownCheckbox = $('apIgnoreCooldownCheckbox');

    const soundSelect = $('apSoundSelect');
    const soundPreviewBtn = $('apSoundPreviewBtn');
    const soundDeleteBtn = $('apSoundDeleteBtn');
    const soundMeta = $('apSoundMeta');
    const soundTabs = $('apSoundTabs');
    const uploadPanel = $('apSoundUploadPanel');
    const ytPanel = $('apSoundYtPanel');
    const fileInput = $('apSoundFileInput');
    const uploadNameInput = $('apSoundNameInput');
    const uploadSubmitBtn = $('apSoundUploadSubmitBtn');
    const uploadStatus = $('apSoundUploadStatus');
    const ytUrlInput = $('apSoundYtUrlInput');
    const ytNameInput = $('apSoundYtNameInput');
    const ytImportBtn = $('apSoundYtImportBtn');
    const ytStatus = $('apSoundYtStatus');

    const clipEnabled = $('apClipEnabled');
    const clipEditor = $('apClipEditor');
    const clipTrack = $('apClipTrack');
    const clipRange = $('apClipRange');
    const clipPlayhead = $('apClipPlayhead');
    const clipStartSlider = $('apClipStartSlider');
    const clipEndSlider = $('apClipEndSlider');
    const clipStartInput = $('apClipStartInput');
    const clipEndInput = $('apClipEndInput');
    const clipLength = $('apClipLength');
    const clipDurationEl = $('apClipDuration');
    const clipError = $('apClipError');
    const clipPreviewBtn = $('apClipPreviewBtn');

    let availableSounds = [];
    let duration = null;          // real length of the selected sound, from browser metadata
    let durationToken = 0;
    let previewClip = null;       // clip the preview is limited to, or null = whole file
    let previewing = null;        // 'full' | 'clip' | null
    let playheadRaf = null;

    const soundUrl = id => (!id || id === 'alarm-default')
      ? '/static/audio/alarm.mp3'
      : `/api/alarm-sounds/${encodeURIComponent(id)}/audio`;
    const secs = v => formatDurationSeconds(v);
    const setStatus = (el, text, kind) => {
      if (!el) return;
      el.textContent = text;
      el.className = `ap-sound-status-msg${kind ? ` ${kind}` : ''}`;
      el.classList.toggle('hidden', !text);
    };

    /* ── Preview ─────────────────────────────── */
    const preview = this._previewAudio;
    const drawPlayhead = () => {
      if (!clipPlayhead) return;
      const on = previewing && duration && !clipEditor.classList.contains('hidden');
      clipPlayhead.classList.toggle('hidden', !on);
      if (on) clipPlayhead.style.left = `${Math.min(100, (preview.currentTime / duration) * 100)}%`;
      playheadRaf = previewing ? requestAnimationFrame(drawPlayhead) : null;
    };
    const stopPreview = () => {
      preview.pause();
      preview.currentTime = 0;
      previewing = null;
      previewClip = null;
      if (soundPreviewBtn) soundPreviewBtn.textContent = 'Preview';
      if (clipPreviewBtn) clipPreviewBtn.textContent = 'Play clip';
      if (playheadRaf) cancelAnimationFrame(playheadRaf);
      playheadRaf = null;
      if (clipPlayhead) clipPlayhead.classList.add('hidden');
    };
    if (!this._previewClipBound) {
      this._previewClipBound = true;
      attachClip(preview, () => previewClip, () => stopPreview());
      preview.addEventListener('ended', () => stopPreview());
      preview.addEventListener('error', () => stopPreview());
    }
    const playPreview = (mode) => {
      stopPreview();
      const clip = mode === 'clip' ? currentClip() : null;
      if (mode === 'clip' && !clip) return;
      previewClip = clip;
      preview.src = soundUrl(soundSelect.value);
      preview.loop = false;
      if (clip) preview.currentTime = clip.start;
      previewing = mode;
      (mode === 'clip' ? clipPreviewBtn : soundPreviewBtn).textContent = 'Stop';
      preview.play().then(drawPlayhead).catch(e => {
        console.warn('[AlarmSound] Preview playback failed:', e);
        stopPreview();
      });
    };

    /* ── Sound list & metadata ────────────────── */
    const selectedSound = () => availableSounds.find(s => s.id === soundSelect.value);
    const renderSoundMeta = () => {
      const s = selectedSound();
      if (soundDeleteBtn) soundDeleteBtn.classList.toggle('hidden', !s || s.source === 'builtin');
      if (!soundMeta) return;
      if (!s) { soundMeta.textContent = ''; return; }
      const src = s.source === 'builtin' ? 'Built-in' : s.source === 'youtube' ? 'YouTube' : 'Uploaded';
      const len = duration || s.duration;
      const size = s.file_size ? `${(s.file_size / (1024 * 1024)).toFixed(1)} MB` : '';
      soundMeta.textContent = [src, len ? formatClock(len) : '', size].filter(Boolean).join(' · ');
    };
    // The browser's own metadata is the only exact length: the server's is a
    // bitrate guess for uploaded MP3s.
    const loadDuration = (id) => new Promise(resolve => {
      const token = ++durationToken;
      duration = null;
      const a = new Audio();
      a.preload = 'metadata';
      const done = d => {
        if (token !== durationToken) return;
        duration = isFinite(d) && d > 0 ? d : (selectedSound()?.duration || null);
        a.src = '';
        onDurationKnown();
        resolve(duration);
      };
      a.addEventListener('loadedmetadata', () => done(a.duration), { once: true });
      a.addEventListener('error', () => done(NaN), { once: true });
      a.src = soundUrl(id);
    });
    const loadSoundsList = async (targetId) => {
      try {
        const res = await apiFetch('/api/alarm-sounds');
        if (!res.ok) return;
        const data = await res.json();
        availableSounds = data.sounds || [];
        soundSelect.innerHTML = availableSounds.map(s => {
          const label = s.source === 'builtin' ? `${s.name} (built-in)` : s.name;
          return `<option value="${this._esc(s.id)}">${this._esc(label)}</option>`;
        }).join('');
        soundSelect.value = targetId || 'alarm-default';
        if (!selectedSound() && availableSounds.length) soundSelect.value = availableSounds[0].id;
        renderSoundMeta();
      } catch (err) {
        console.warn('[AlarmSound] Failed to load alarm sounds:', err);
      }
    };

    /* ── Clip editor ─────────────────────────── */
    const readClipInputs = () => ({ start: parseClock(clipStartInput.value), end: parseClock(clipEndInput.value) });
    const clipProblem = () => {
      if (!clipEnabled.checked) return null;
      const { start, end } = readClipInputs();
      return validateClip(start, end, duration);
    };
    const currentClip = () => {
      if (!clipEnabled.checked || clipProblem()) return null;
      return readClipInputs();
    };
    const renderClip = () => {
      const { start, end } = readClipInputs();
      const max = duration || Math.max(end || 0, 1);
      const ok = isFinite(start) && isFinite(end);
      if (clipRange) {
        clipRange.style.left = ok ? `${Math.max(0, Math.min(100, (start / max) * 100))}%` : '0';
        clipRange.style.width = ok ? `${Math.max(0, Math.min(100, ((end - start) / max) * 100))}%` : '0';
      }
      if (clipDurationEl) clipDurationEl.textContent = duration ? formatClock(duration) : 'loading…';
      const problem = clipProblem();
      if (clipLength) clipLength.textContent = ok && end > start ? `${formatClock(end - start)} long` : '';
      if (clipError) {
        clipError.textContent = problem || '';
        clipError.classList.toggle('hidden', !problem);
      }
      [clipStartInput, clipEndInput].forEach(el => el.setAttribute('aria-invalid', problem ? 'true' : 'false'));
      if (clipPreviewBtn) clipPreviewBtn.disabled = Boolean(problem);
    };
    const setClipInputs = (start, end) => {
      clipStartInput.value = formatClock(start);
      clipEndInput.value = formatClock(end);
    };
    const syncSlidersFromInputs = () => {
      const { start, end } = readClipInputs();
      if (isFinite(start)) clipStartSlider.value = start;
      if (isFinite(end)) clipEndSlider.value = end;
    };
    const onDurationKnown = () => {
      const max = duration ? Math.round(duration * 10) / 10 : 100;
      clipStartSlider.max = clipEndSlider.max = max;
      syncSlidersFromInputs();
      renderSoundMeta();
      renderClip();
      onInputChange();
    };
    const setClipEnabled = (on, clip) => {
      clipEnabled.checked = on;
      clipEditor.classList.toggle('hidden', !on);
      if (on) {
        // Default suggestion: one ring's worth from the top of the file.
        const ring = Math.max(1, parseInt(ringDurationInput.value, 10) || 10);
        const c = clip || { start: 0, end: duration ? Math.min(duration, ring) : ring };
        setClipInputs(c.start, c.end);
        syncSlidersFromInputs();
      } else if (previewing === 'clip') {
        stopPreview();
      }
      renderClip();
    };
    clipEnabled.addEventListener('change', () => { setClipEnabled(clipEnabled.checked); onInputChange(); });
    // Two overlaid native sliders; neither may cross the other (keeps >= 1s apart).
    clipStartSlider.addEventListener('input', () => {
      const end = parseFloat(clipEndSlider.value);
      const start = Math.min(parseFloat(clipStartSlider.value), Math.max(0, end - CLIP_MIN_S));
      clipStartSlider.value = start;
      setClipInputs(start, end);
      renderClip(); onInputChange();
    });
    clipEndSlider.addEventListener('input', () => {
      const start = parseFloat(clipStartSlider.value);
      const end = Math.max(parseFloat(clipEndSlider.value), start + CLIP_MIN_S);
      clipEndSlider.value = end;
      setClipInputs(start, end);
      renderClip(); onInputChange();
    });
    [clipStartInput, clipEndInput].forEach(el => {
      el.addEventListener('input', () => { syncSlidersFromInputs(); renderClip(); onInputChange(); });
      // Normalise "80" to "1:20" once the operator leaves the field.
      el.addEventListener('blur', () => {
        const v = parseClock(el.value);
        if (isFinite(v)) el.value = formatClock(v);
      });
    });
    // Clicking the bare track moves whichever handle is nearer.
    clipTrack.addEventListener('pointerdown', e => {
      if (e.target !== clipTrack && e.target !== clipRange) return;
      if (!duration) return;
      const r = clipTrack.getBoundingClientRect();
      const t = Math.round(((e.clientX - r.left) / r.width) * duration * 10) / 10;
      const { start, end } = readClipInputs();
      const slider = Math.abs(t - start) <= Math.abs(t - end) ? clipStartSlider : clipEndSlider;
      slider.value = t;
      slider.dispatchEvent(new Event('input'));
    });
    clipPreviewBtn.addEventListener('click', () => (previewing === 'clip' ? stopPreview() : playPreview('clip')));

    /* ── Draft, validation, summary ───────────── */
    const NUMBER_FIELDS = [
      [initialDelayInput, 'Trigger delay'],
      [ringDurationInput, 'Ring duration'],
      [repeatIntervalInput, 'Repeat interval', () => repeatEnabledCheckbox.checked],
      [repeatLimitInput, 'Stop after', () => repeatEnabledCheckbox.checked, 'repeats'],
      [ackQuietInput, 'Quiet period', () => ackRemindRadio.checked],
      [ackReminderIntervalInput, 'Remind every', () => ackRemindRadio.checked],
      [ackReminderRingInput, 'Reminder ring', () => ackRemindRadio.checked],
    ];
    // Invalid numbers are reported, never silently replaced by a default.
    const fieldProblem = () => {
      for (const [el, name, applies, unit = 'sec'] of NUMBER_FIELDS) {
        el.removeAttribute('aria-invalid');
        if (applies && !applies()) continue;
        const v = Number(el.value);
        const min = Number(el.min), max = Number(el.max);
        if (el.value.trim() === '' || !Number.isInteger(v) || v < min || v > max) {
          el.setAttribute('aria-invalid', 'true');
          return { el, msg: `${name} must be a whole number from ${min} to ${max} ${unit}.` };
        }
      }
      const clipMsg = clipProblem();
      if (clipMsg) return { el: clipStartInput, msg: `Sound clip: ${clipMsg}` };
      return null;
    };
    const num = (el, fallback) => { const v = parseInt(el.value, 10); return Number.isFinite(v) ? v : fallback; };
    const getFormDraft = () => {
      const clip = clipEnabled.checked ? readClipInputs() : null;
      return {
        initial_delay_s: num(initialDelayInput, 0),
        ring_duration_s: num(ringDurationInput, 10),
        repeat_interval_s: num(repeatIntervalInput, 120),
        repeat_enabled: repeatEnabledCheckbox.checked,
        ack_behavior: ackSilenceRadio.checked ? 'silence' : 'remind',
        ack_reminder_interval_s: num(ackReminderIntervalInput, 300),
        ack_reminder_ring_duration_s: num(ackReminderRingInput, 10),
        ack_quiet_s: num(ackQuietInput, 300),
        repeat_limit: num(repeatLimitInput, 0),
        new_outage_mode: ignoreCooldownCheckbox.checked ? 'ring' : 'wait',
        sound_id: soundSelect.value || 'alarm-default',
        sound_start_s: clip ? Math.round(clip.start * 10) / 10 : null,
        sound_end_s: clip ? Math.round(clip.end * 10) / 10 : null,
      };
    };
    const summarize = (p) => {
      let text = p.initial_delay_s > 0
        ? `After a host has been down ${secs(p.initial_delay_s)}, the alarm rings for ${secs(p.ring_duration_s)}`
        : `As soon as a host goes down, the alarm rings for ${secs(p.ring_duration_s)}`;
      if (!p.repeat_enabled) text += ' once.';
      else if (p.repeat_limit > 0) text += `, then up to ${p.repeat_limit} more time${p.repeat_limit === 1 ? '' : 's'} every ${secs(p.repeat_interval_s)} unless acknowledged.`;
      else text += `, then again every ${secs(p.repeat_interval_s)} until acknowledged.`;
      text += p.new_outage_mode === 'wait'
        ? ' Another host going down joins the next scheduled ring.'
        : ' Another host going down rings right away, even during cooldown.';
      text += p.ack_behavior === 'silence'
        ? ' Acknowledging silences it until the host recovers.'
        : ` Acknowledging silences it for ${secs(p.ack_quiet_s)}, then it reminds every ${secs(p.ack_reminder_interval_s)} (${secs(p.ack_reminder_ring_duration_s)} ring) while the host is still down.`;
      const clip = clipOf(p);
      if (clip) text += ` Plays ${formatClock(clip.start)}–${formatClock(clip.end)} of the sound.`;
      return text;
    };
    // Presets are timing only; the chosen sound and clip survive a preset switch.
    const TIMING_KEYS = ['initial_delay_s', 'ring_duration_s', 'repeat_interval_s', 'repeat_enabled',
      'repeat_limit', 'new_outage_mode', 'ack_behavior', 'ack_quiet_s', 'ack_reminder_interval_s',
      'ack_reminder_ring_duration_s'];
    const REMIND_KEYS = ['ack_quiet_s', 'ack_reminder_interval_s', 'ack_reminder_ring_duration_s'];
    const detectMatchingPreset = (p) => {
      for (const [key, preset] of Object.entries(ALARM_PRESETS)) {
        const same = TIMING_KEYS.every(k => (p.ack_behavior === 'silence' && REMIND_KEYS.includes(k))
          || (!p.repeat_enabled && k === 'repeat_limit') || p[k] === (preset[k] ?? DEFAULT_ALARM_POLICY[k]));
        if (same) return key;
      }
      return 'custom';
    };
    const updatePresetChips = (activeKey) => {
      presetChips.querySelectorAll('.chip').forEach(chip => {
        const on = chip.dataset.preset === activeKey;
        chip.classList.toggle('chip-active', on);
        chip.setAttribute('aria-pressed', String(on));
      });
    };
    const onInputChange = () => {
      const draft = getFormDraft();
      repeatIntervalGroup.classList.toggle('is-disabled', !draft.repeat_enabled);
      repeatIntervalInput.disabled = !draft.repeat_enabled;
      repeatLimitRow.classList.toggle('is-disabled', !draft.repeat_enabled);
      repeatLimitInput.disabled = !draft.repeat_enabled;
      ackRemindControls.classList.toggle('hidden', draft.ack_behavior === 'silence');
      const problem = fieldProblem();
      summaryEl.textContent = problem ? '' : summarize(draft);
      updatePresetChips(detectMatchingPreset(draft));
      if (errorEl && !errorEl.classList.contains('hidden') && !problem) errorEl.classList.add('hidden');
    };
    const populateForm = (p) => {
      initialDelayInput.value = p.initial_delay_s;
      ringDurationInput.value = p.ring_duration_s;
      repeatIntervalInput.value = p.repeat_interval_s;
      repeatEnabledCheckbox.checked = Boolean(p.repeat_enabled);
      (p.ack_behavior === 'silence' ? ackSilenceRadio : ackRemindRadio).checked = true;
      ackReminderIntervalInput.value = p.ack_reminder_interval_s;
      ackReminderRingInput.value = p.ack_reminder_ring_duration_s;
      ackQuietInput.value = p.ack_quiet_s ?? p.ack_reminder_interval_s;
      repeatLimitInput.value = p.repeat_limit ?? 0;
      ignoreCooldownCheckbox.checked = p.new_outage_mode !== 'wait';
      if (p.sound_id && availableSounds.some(s => s.id === p.sound_id)) soundSelect.value = p.sound_id;
      const clip = clipOf(p);
      setClipEnabled(Boolean(clip), clip);
      renderSoundMeta();
      onInputChange();
    };

    /* ── Wiring ──────────────────────────────── */
    [initialDelayInput, ringDurationInput, repeatIntervalInput, repeatEnabledCheckbox,
      ackSilenceRadio, ackRemindRadio, ackReminderIntervalInput, ackReminderRingInput,
      ackQuietInput, repeatLimitInput, ignoreCooldownCheckbox].forEach(el => {
      el.addEventListener('input', onInputChange);
      el.addEventListener('change', onInputChange);
    });

    presetChips.addEventListener('click', (e) => {
      const chip = e.target.closest('.chip');
      if (!chip || !chip.dataset.preset) return;
      if (chip.dataset.preset === 'custom') {
        updatePresetChips('custom');
        initialDelayInput.focus();
        return;
      }
      const preset = ALARM_PRESETS[chip.dataset.preset];
      if (!preset) return;
      const timing = Object.fromEntries(TIMING_KEYS.map(k => [k, preset[k]]));
      populateForm({ ...getFormDraft(), ...timing });
    });

    soundSelect.addEventListener('change', () => {
      stopPreview();
      setClipEnabled(false);           // a clip belongs to one file
      renderSoundMeta();
      loadDuration(soundSelect.value);
      onInputChange();
    });
    soundPreviewBtn.addEventListener('click', () => {
      if (previewing) { stopPreview(); return; }
      playPreview(currentClip() ? 'clip' : 'full');
    });

    soundTabs.addEventListener('click', (e) => {
      const btn = e.target.closest('.ap-sound-tab-btn');
      if (!btn) return;
      const opening = !btn.classList.contains('active');
      soundTabs.querySelectorAll('.ap-sound-tab-btn').forEach(b => {
        const on = opening && b === btn;
        b.classList.toggle('active', on);
        b.setAttribute('aria-selected', String(on));
      });
      uploadPanel.classList.toggle('hidden', !(opening && btn.dataset.soundTab === 'upload'));
      ytPanel.classList.toggle('hidden', !(opening && btn.dataset.soundTab === 'youtube'));
    });
    const closeAddPanels = () => {
      soundTabs.querySelectorAll('.ap-sound-tab-btn').forEach(b => { b.classList.remove('active'); b.setAttribute('aria-selected', 'false'); });
      uploadPanel.classList.add('hidden');
      ytPanel.classList.add('hidden');
    };
    const selectNewSound = async (sound, message) => {
      await loadSoundsList(sound.id);
      stopPreview();
      setClipEnabled(false);
      await loadDuration(sound.id);
      closeAddPanels();
      renderSoundMeta();
      onInputChange();
      this.instancesPage?._triggerEventToast?.(message);
    };

    soundDeleteBtn.addEventListener('click', async () => {
      const s = selectedSound();
      if (!s || s.source === 'builtin') return;
      if (!confirm(`Delete the sound "${s.name}"? This cannot be undone.`)) return;
      soundDeleteBtn.disabled = true;
      try {
        const res = await apiFetch(`/api/alarm-sounds/${encodeURIComponent(s.id)}`, { method: 'DELETE' });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          showError(data.error || 'Failed to delete the sound.');
        } else {
          // Back to the saved policy's sound (and its clip), not Default.
          const saved = alarmPolicyManager.getPolicy();
          stopPreview();
          await loadSoundsList(saved.sound_id || 'alarm-default');
          const back = soundSelect.value === saved.sound_id ? clipOf(saved) : null;
          setClipEnabled(Boolean(back), back);
          await loadDuration(soundSelect.value);
          onInputChange();
          this.instancesPage?._triggerEventToast?.(`Deleted sound "${s.name}"`);
        }
      } catch (err) {
        showError('Network error while deleting the sound.');
      } finally {
        soundDeleteBtn.disabled = false;
      }
    });

    uploadSubmitBtn.addEventListener('click', async () => {
      const file = fileInput.files?.[0];
      if (!file) { setStatus(uploadStatus, 'Choose an audio file first.', 'error'); return; }
      const formData = new FormData();
      formData.append('file', file);
      if (uploadNameInput.value.trim()) formData.append('name', uploadNameInput.value.trim());
      uploadSubmitBtn.disabled = true;
      uploadSubmitBtn.textContent = 'Uploading…';
      setStatus(uploadStatus, '', '');
      try {
        const res = await apiFetch('/api/alarm-sounds/upload', { method: 'POST', body: formData });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          setStatus(uploadStatus, data.error || 'Upload failed.', 'error');
        } else {
          fileInput.value = '';
          uploadNameInput.value = '';
          await selectNewSound(data.sound, `Uploaded "${data.sound.name}" — selected, save to use it`);
        }
      } catch (err) {
        setStatus(uploadStatus, 'Network error during upload.', 'error');
      } finally {
        uploadSubmitBtn.disabled = false;
        uploadSubmitBtn.textContent = 'Upload';
      }
    });

    ytImportBtn.addEventListener('click', async () => {
      const url = ytUrlInput.value.trim();
      if (!url) { setStatus(ytStatus, 'Paste a YouTube link first.', 'error'); return; }
      ytImportBtn.disabled = true;
      ytImportBtn.textContent = 'Importing…';
      setStatus(ytStatus, 'Downloading audio on the server — this can take a while for long videos.', '');
      try {
        const res = await apiFetch('/api/alarm-sounds/import', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url, name: ytNameInput.value.trim() })
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          setStatus(ytStatus, data.error || 'Import failed.', 'error');
        } else {
          ytUrlInput.value = '';
          ytNameInput.value = '';
          setStatus(ytStatus, '', '');
          await selectNewSound(data.sound, `Imported "${data.sound.name}" — pick the part to play, then save`);
          clipEnabled.focus();
        }
      } catch (err) {
        setStatus(ytStatus, 'Network error during import.', 'error');
      } finally {
        ytImportBtn.disabled = false;
        ytImportBtn.textContent = 'Import';
      }
    });

    const showError = (msg) => {
      errorEl.textContent = msg;
      errorEl.classList.remove('hidden');
    };

    const openModal = async () => {
      const current = alarmPolicyManager.getPolicy();
      errorEl.classList.add('hidden');
      setStatus(uploadStatus, '', '');
      setStatus(ytStatus, '', '');
      closeAddPanels();
      await loadSoundsList(current.sound_id || 'alarm-default');
      populateForm(current);
      modal.classList.remove('hidden');
      initialDelayInput.focus();
      await loadDuration(soundSelect.value);
    };
    const closeModal = () => {
      stopPreview();
      modal.classList.add('hidden');
    };

    openBtns.forEach(btn => btn.addEventListener('click', openModal));
    $('closeAlarmPolicyModalBtn')?.addEventListener('click', closeModal);
    $('apCancelBtn')?.addEventListener('click', closeModal);
    modal.addEventListener('click', (e) => { if (e.target === modal) closeModal(); });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !modal.classList.contains('hidden')) closeModal();
    });
    $('apResetDefaultsBtn')?.addEventListener('click', async () => {
      populateForm(DEFAULT_ALARM_POLICY);
      soundSelect.value = 'alarm-default';
      renderSoundMeta();
      await loadDuration('alarm-default');
    });

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const problem = fieldProblem();
      if (problem) {
        showError(problem.msg);
        problem.el.focus();
        return;
      }
      errorEl.classList.add('hidden');
      submitBtn.disabled = true;
      submitBtn.textContent = 'Saving…';
      try {
        const res = await alarmPolicyManager.save(getFormDraft());
        if (res.ok) {
          this.instancesPage?._triggerEventToast?.('Alarm policy saved');
          this._syncAlarmAudio();
          closeModal();
        } else {
          showError(res.error || 'Failed to save the policy.');
        }
      } catch (err) {
        showError('Network error while saving the policy.');
      } finally {
        submitBtn.disabled = false;
        submitBtn.textContent = 'Save policy';
      }
    });
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
        ? `Last successful update: ${this._lastHealthSuccessAt.toLocaleTimeString(DATE_LOCALE)}`
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
      try { localStorage.setItem('logsModalTab', tab); } catch (_) { /* private mode */ }
      Object.entries(tabs).forEach(([key, { btn, panel }]) => {
        const active = key === tab;
        if (panel) panel.classList.toggle('hidden', !active);
        if (btn) {
          btn.classList.toggle('chip-active', active);
          btn.setAttribute('aria-selected', String(active));
        }
      });
      if (tab !== 'history') this.historyPage.onDeactivate();
      if (tab !== 'logs') this.logsPage.onDeactivate();
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
      // Reopen on the tab the operator last used (it always snapped back to
      // Live Alert Log).
      let last = 'logs';
      try { last = localStorage.getItem('logsModalTab') || 'logs'; } catch (_) { /* private mode */ }
      showTab(tabs[last] ? last : 'logs');
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
    // The add form's input + submit are gated by auth.js's WRITE_CONTROL_IDS
    // so they follow login/logout; doing it once here left them dead for the
    // rest of the session after a first-run setup or a login.
    const isReadOnlyUser = () => !window.currentUser
      || (window.currentUser.role !== 'admin' && window.currentUser.role !== 'owner');
    const readOnlyTitle = 'Read-only account — sign in as an operator to change this';

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

    // Duration display format preference
    const durationPrefRadios = modal ? modal.querySelectorAll('input[name="durationDisplayFormat"]') : [];
    const syncDurationPrefUI = () => {
      const currentPref = getDurationFormatPreference();
      durationPrefRadios.forEach(r => {
        r.checked = (r.value === currentPref);
      });
    };
    durationPrefRadios.forEach(radio => {
      radio.addEventListener('change', (e) => {
        if (e.target.checked) {
          setDurationFormatPreference(e.target.value);
        }
      });
    });

    if (openBtn && modal) {
      openBtn.addEventListener('click', () => {
        modal.classList.remove('hidden');
        syncDurationPrefUI();
        const readOnlyAlert = document.getElementById('endpointReadOnlyAlert');
        if (readOnlyAlert) readOnlyAlert.classList.toggle('hidden', !isReadOnlyUser());
        if (this._untrapEndpoint) this._untrapEndpoint();
        this._untrapEndpoint = window.trapModalFocus(modal);
        fetchEndpoints();
      });
    }

    const loginTriggerBtn = document.getElementById('endpointLoginTriggerBtn');
    if (loginTriggerBtn && modal) {
      loginTriggerBtn.addEventListener('click', () => {
        if (this._untrapEndpoint) { this._untrapEndpoint(); this._untrapEndpoint = null; }
        modal.classList.add('hidden');
        window.dispatchEvent(new CustomEvent('iw:unauthorized'));
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
    // The icon swapped but the tooltip didn't, so a muted wallboard still
    // read "Alarm sound: ON — click to mute" on hover.
    const soundBtn = document.getElementById('soundToggleBtn');
    if (soundBtn) {
      soundBtn.title = enabled
        ? 'Alarm sound: ON — click to mute'
        : 'Alarm sound: MUTED — click to unmute';
      soundBtn.setAttribute('aria-pressed', enabled ? 'false' : 'true');
    }
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
    if (this._previewAudio) {
      this._previewAudio.muted = false;
      this._previewAudio.volume = 1.0;
    }
    try { localStorage.setItem('iw-audio-unlocked', 'true'); } catch (e) { }
    console.log('[InfraWatch] Audio context & element unlocked cleanly');
  }

  // ── Alarm lifecycle ───────────────────────────────
  // Evaluated pure-functionally per target via alarmPolicyManager.evaluate(t, nowMs).
  // No volatile timers or scattered setTimeout() handles. Server epoch timestamps
  // and configured policy drive the state machine deterministically across tabs.
  // Targets with this tab's optimistic ACKs (clicked, server not caught up
  // yet) folded in, so the siren stops the moment the operator acknowledges.
  _targetsWithLocalAcks(targets) {
    const acked = this.instancesPage?.acknowledgedDownInstances;
    return targets.map(t => (acked?.has(t.instance) && !t.acknowledged) ? { ...t, acknowledged: true } : t);
  }

  // Single decision point for the shared <audio> element: recomputed from
  // scratch every tick, so play()/pause() calls are idempotent (guarded by
  // .paused) rather than edge-triggered — nothing to double-fire or miss.
  _syncAlarmAudio() {
    if (!this.alarmAudio) return;

    // Sync active sound source from policy
    const policy = alarmPolicyManager.getPolicy();
    const soundId = policy?.sound_id || 'alarm-default';
    const expectedSrc = soundId === 'alarm-default'
      ? '/static/audio/alarm.mp3'
      : `/api/alarm-sounds/${encodeURIComponent(soundId)}/audio`;

    if (this.alarmAudio.dataset.soundId !== soundId) {
      this.alarmAudio.dataset.soundId = soundId;
      const wasPlaying = !this.alarmAudio.paused;
      this.alarmAudio.src = expectedSrc;
      this.alarmAudio.load();
      if (wasPlaying) {
        this.alarmAudio.play().catch(e => this._reportAlarmAudioFailure(e));
      }
    }

    const targets = this.instancesPage?.data || [];
    const now = Date.now();
    const canPlayTab = alarmPolicyManager.shouldPlayAudio();
    const fleet = alarmPolicyManager.evaluateFleet(this._targetsWithLocalAcks(targets), now);
    this._renderAlarmStatusBar(fleet.summary, canPlayTab);
    const shouldPlay = !this.isMuted && canPlayTab && fleet.isAudible;

    if (shouldPlay) {
      // Pause preview audio if an active outage alarm starts
      if (this._previewAudio && !this._previewAudio.paused) {
        this._previewAudio.pause();
        this._previewAudio.currentTime = 0;
      }
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

  // Top-bar readout of the siren across all hosts, from the same evaluation
  // the ticker plays from: the most urgent state and the time to the next ring.
  _renderAlarmStatusBar(sum, canPlayTab) {
    const bar = document.getElementById('alarmStatusBar');
    if (!bar) return;
    bar.classList.toggle('is-idle', !sum);
    if (!sum) { bar.removeAttribute('data-state'); return; }
    const c = sum.counts;
    const hosts = n => `${n} host${n === 1 ? '' : 's'}`;
    const next = sum.nextRingS != null ? formatDurationSeconds(Math.ceil(sum.nextRingS)) : null;
    const [state, detail] = {
      ringing: ['Ringing', sum.ringLeftS != null
        ? `${hosts(c.ringing)} · ${formatDurationSeconds(Math.ceil(sum.ringLeftS))} left`
        : hosts(c.ringing)],
      pending: ['Pending', next && `first ring in ${next}`],
      cooldown: ['Cooldown', next && `next ring in ${next}`],
      acked: ['Acknowledged', next && `reminder in ${next}`],
      silenced: ['Acknowledged', 'silenced until recovery'],
      repeat_off: sum.reason === 'limit'
        ? ['Repeat limit reached', 'silent until acknowledged or a new outage']
        : ['Rang once', 'repeat is off'],
    }[sum.state];
    const note = this.isMuted ? 'sound muted' : (!canPlayTab ? 'playing in another tab' : '');
    bar.dataset.state = sum.state;
    document.getElementById('alarmStatusState').textContent = state;
    const detailEl = document.getElementById('alarmStatusDetail');
    detailEl.textContent = detail || '';
    if (note) {
      const warn = document.createElement('span');
      warn.className = 'is-warn';
      warn.textContent = `${detail ? ' · ' : ''}${note}`;
      detailEl.appendChild(warn);
    }
    bar.title = [
      c.ringing && `${hosts(c.ringing)} ringing`,
      c.pending && `${hosts(c.pending)} pending`,
      c.cooldown && `${hosts(c.cooldown)} in cooldown`,
      c.acked && `${hosts(c.acked)} acknowledged, reminders on`,
      c.silenced && `${hosts(c.silenced)} acknowledged, silenced`,
      c.repeat_off && `${hosts(c.repeat_off)} ${sum.reason === 'limit' ? 'past the repeat limit' : 'rang once (repeat off)'}`,
    ].filter(Boolean).join(' · ');
  }

  // Driven by a worker (alarm-tick-worker.js): a background tab's own timers
  // drop to once a minute, which let a ring start or run on up to a minute
  // late. Falls back to setInterval where workers are unavailable.
  _startAlarmTicker() {
    if (this._alarmTickHandle || this._alarmTickWorker) return;
    try {
      this._alarmTickWorker = new Worker('/static/js/alarm-tick-worker.js');
      this._alarmTickWorker.onmessage = () => {
        const ip = this.instancesPage;
        if (document.hidden && ip && Date.now() - (this._hiddenPollAt || 0) >= (ip.refreshIntervalMs || 5000)) {
          this._hiddenPollAt = Date.now();
          ip.load();
        }
        this._syncAlarmAudio();
      };
      this._alarmTickWorker.onerror = () => {
        this._alarmTickWorker?.terminate();
        this._alarmTickWorker = null;
        if (!this._alarmTickHandle) this._alarmTickHandle = setInterval(() => this._syncAlarmAudio(), 1000);
      };
    } catch (e) {
      this._alarmTickWorker = null;
      this._alarmTickHandle = setInterval(() => this._syncAlarmAudio(), 1000);
    }
  }

  _stopAlarmTicker() {
    if (this._alarmTickWorker) {
      this._alarmTickWorker.terminate();
      this._alarmTickWorker = null;
    }
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
