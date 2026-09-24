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
  DEFAULT_ALARM_POLICY
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

  _bindAlarmPolicyModal() {
    const modal = document.getElementById('alarmPolicyModal');
    if (!modal) return;

    const openBtns = [
      document.getElementById('headerAlarmPolicyBtn'),
      document.getElementById('alarmPolicyQuickBtn')
    ].filter(Boolean);
    const closeBtn = document.getElementById('closeAlarmPolicyModalBtn');
    const cancelBtn = document.getElementById('apCancelBtn');
    const resetBtn = document.getElementById('apResetDefaultsBtn');
    const form = document.getElementById('alarmPolicyForm');

    const initialDelayInput = document.getElementById('apInitialDelayInput');
    const ringDurationInput = document.getElementById('apRingDurationInput');
    const repeatIntervalInput = document.getElementById('apRepeatIntervalInput');
    const repeatEnabledCheckbox = document.getElementById('apRepeatEnabledCheckbox');
    const repeatIntervalGroup = document.getElementById('apRepeatIntervalGroup');
    const ackSilenceRadio = document.getElementById('apAckSilenceRadio');
    const ackRemindRadio = document.getElementById('apAckRemindRadio');
    const ackRemindControls = document.getElementById('apAckRemindControls');
    const ackReminderIntervalInput = document.getElementById('apAckReminderIntervalInput');
    const ackReminderRingInput = document.getElementById('apAckReminderRingInput');
    const presetChips = document.getElementById('alarmPresetsChips');
    const timelineTrack = document.getElementById('apTimelineTrack');
    const previewMode = document.getElementById('apPreviewMode');
    const errorEl = document.getElementById('apError');
    const successEl = document.getElementById('apSuccess');
    const submitBtn = document.getElementById('apSubmitBtn');

    // ── Audible Sound Controls ──
    const soundSelect = document.getElementById('apSoundSelect');
    const soundPreviewBtn = document.getElementById('apSoundPreviewBtn');
    const soundPreviewText = document.getElementById('apSoundPreviewText');
    const soundDeleteBtn = document.getElementById('apSoundDeleteBtn');
    const soundSourceBadge = document.getElementById('apSoundSourceBadge');
    const soundDurationInfo = document.getElementById('apSoundDurationInfo');
    const soundTabs = document.getElementById('apSoundTabs');
    const choosePanel = document.getElementById('apSoundChoosePanel');
    const uploadPanel = document.getElementById('apSoundUploadPanel');
    const ytPanel = document.getElementById('apSoundYtPanel');
    const fileInput = document.getElementById('apSoundFileInput');
    const uploadNameInput = document.getElementById('apSoundNameInput');
    const uploadSubmitBtn = document.getElementById('apSoundUploadSubmitBtn');
    const uploadStatus = document.getElementById('apSoundUploadStatus');
    const ytUrlInput = document.getElementById('apSoundYtUrlInput');
    const ytNameInput = document.getElementById('apSoundYtNameInput');
    const ytImportBtn = document.getElementById('apSoundYtImportBtn');
    const ytStatus = document.getElementById('apSoundYtStatus');

    let availableSounds = [];
    let isPreviewPlaying = false;

    const stopPreview = () => {
      if (this._previewAudio) {
        this._previewAudio.pause();
        this._previewAudio.currentTime = 0;
      }
      isPreviewPlaying = false;
      if (soundPreviewBtn) {
        soundPreviewBtn.classList.remove('btn-primary');
        soundPreviewBtn.classList.add('btn-secondary');
        soundPreviewBtn.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg> <span id="apSoundPreviewText">Preview</span>';
      }
    };

    if (this._previewAudio) {
      this._previewAudio.addEventListener('ended', stopPreview);
      this._previewAudio.addEventListener('error', () => {
        console.warn('[AlarmSound] Preview error');
        stopPreview();
      });
    }

    const playPreview = (soundId) => {
      stopPreview();
      const sid = soundId || soundSelect?.value || 'alarm-default';
      const url = sid === 'alarm-default'
        ? '/static/audio/alarm.mp3'
        : `/api/alarm-sounds/${encodeURIComponent(sid)}/audio`;

      this._previewAudio.src = url;
      isPreviewPlaying = true;
      if (soundPreviewBtn) {
        soundPreviewBtn.classList.remove('btn-secondary');
        soundPreviewBtn.classList.add('btn-primary');
        soundPreviewBtn.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg> <span id="apSoundPreviewText">Stop</span>';
      }
      this._previewAudio.play().catch(e => {
        console.warn('[AlarmSound] Preview playback failed:', e);
        stopPreview();
      });
    };

    const updateSoundMeta = () => {
      const selectedId = soundSelect?.value || 'alarm-default';
      const s = availableSounds.find(item => item.id === selectedId);
      if (s) {
        if (soundSourceBadge) {
          soundSourceBadge.textContent = s.source === 'builtin' ? 'Built-in' : (s.source === 'youtube' ? 'YouTube' : 'Custom');
        }
        if (soundDurationInfo) {
          const durSec = s.duration || s.duration_s;
          const dur = durSec ? `~${Number(durSec).toFixed(1)}s` : '';
          const szBytes = s.file_size || s.file_size_bytes;
          const sz = szBytes ? ` · ${(szBytes / 1024).toFixed(0)} KB` : '';
          soundDurationInfo.textContent = `${dur}${sz}`.trim();
        }
        if (soundDeleteBtn) {
          if (s.source === 'builtin') {
            soundDeleteBtn.classList.add('hidden');
          } else {
            soundDeleteBtn.classList.remove('hidden');
          }
        }
      } else {
        if (soundDeleteBtn) soundDeleteBtn.classList.add('hidden');
      }
    };

    const loadSoundsList = async (targetId) => {
      try {
        const res = await fetch('/api/alarm-sounds', {
          headers: { 'X-Requested-With': 'XMLHttpRequest' }
        });
        if (res.ok) {
          const data = await res.json();
          availableSounds = data.sounds || [];
          if (soundSelect) {
            const currentVal = targetId || soundSelect.value || 'alarm-default';
            soundSelect.innerHTML = availableSounds.map(s => {
              const ext = (s.format || s.filename?.split('.').pop() || '').toUpperCase();
              const tag = s.source === 'builtin' ? ' (Default)' : (ext ? ` [${ext}]` : '');
              const label = s.name + tag;
              return `<option value="${this._esc(s.id)}">${this._esc(label)}</option>`;
            }).join('');
            soundSelect.value = currentVal;
            if (!availableSounds.some(s => s.id === soundSelect.value) && availableSounds.length > 0) {
              soundSelect.value = availableSounds[0].id;
            }
          }
          updateSoundMeta();
        }
      } catch (err) {
        console.warn('[AlarmSound] Failed to load alarm sounds:', err);
      }
    };

    if (soundTabs) {
      soundTabs.addEventListener('click', (e) => {
        const btn = e.target.closest('.ap-sound-tab-btn');
        if (!btn) return;
        soundTabs.querySelectorAll('.ap-sound-tab-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        const tab = btn.dataset.soundTab;
        if (choosePanel) choosePanel.classList.toggle('hidden', tab !== 'choose');
        if (uploadPanel) uploadPanel.classList.toggle('hidden', tab !== 'upload');
        if (ytPanel) ytPanel.classList.toggle('hidden', tab !== 'youtube');
      });
    }

    if (soundSelect) {
      soundSelect.addEventListener('change', () => {
        stopPreview();
        updateSoundMeta();
        onInputChange();
      });
    }

    if (soundPreviewBtn) {
      soundPreviewBtn.addEventListener('click', () => {
        if (isPreviewPlaying) {
          stopPreview();
        } else {
          playPreview(soundSelect?.value || 'alarm-default');
        }
      });
    }

    if (soundDeleteBtn) {
      soundDeleteBtn.addEventListener('click', async () => {
        const selectedId = soundSelect?.value;
        if (!selectedId || selectedId === 'alarm-default') return;
        const soundObj = availableSounds.find(s => s.id === selectedId);
        const soundName = soundObj ? soundObj.name : selectedId;
        if (!confirm(`Delete custom sound "${soundName}"?`)) return;

        try {
          soundDeleteBtn.disabled = true;
          const res = await fetch(`/api/alarm-sounds/${encodeURIComponent(selectedId)}`, {
            method: 'DELETE',
            headers: { 'X-Requested-With': 'XMLHttpRequest' }
          });
          const data = await res.json();
          if (!res.ok) {
            alert(data.error || 'Failed to delete sound');
          } else {
            this.instancesPage?._triggerEventToast?.(`Deleted sound "${soundName}"`);
            stopPreview();
            await loadSoundsList('alarm-default');
            onInputChange();
          }
        } catch (err) {
          alert('Network error deleting sound');
        } finally {
          soundDeleteBtn.disabled = false;
        }
      });
    }

    if (uploadSubmitBtn) {
      uploadSubmitBtn.addEventListener('click', async () => {
        const file = fileInput?.files?.[0];
        if (!file) {
          if (uploadStatus) {
            uploadStatus.textContent = 'Please choose an audio file (.mp3, .wav, .ogg).';
            uploadStatus.style.color = 'var(--critical)';
            uploadStatus.classList.remove('hidden');
          }
          return;
        }
        const formData = new FormData();
        formData.append('file', file);
        formData.append('audio_file', file);
        if (uploadNameInput?.value?.trim()) {
          formData.append('name', uploadNameInput.value.trim());
        }

        uploadSubmitBtn.disabled = true;
        uploadSubmitBtn.textContent = 'Uploading…';
        if (uploadStatus) {
          uploadStatus.textContent = 'Processing file…';
          uploadStatus.style.color = 'var(--text-muted)';
          uploadStatus.classList.remove('hidden');
        }

        try {
          const res = await fetch('/api/alarm-sounds/upload', {
            method: 'POST',
            body: formData,
            headers: { 'X-Requested-With': 'XMLHttpRequest' }
          });
          const data = await res.json();
          if (!res.ok) {
            if (uploadStatus) {
              uploadStatus.textContent = data.error || 'Upload failed.';
              uploadStatus.style.color = 'var(--critical)';
              uploadStatus.classList.remove('hidden');
            }
          } else {
            if (uploadStatus) {
              uploadStatus.textContent = 'Upload successful!';
              uploadStatus.style.color = 'var(--success)';
              uploadStatus.classList.remove('hidden');
            }
            if (fileInput) fileInput.value = '';
            if (uploadNameInput) uploadNameInput.value = '';

            await loadSoundsList(data.sound.id);
            const chooseTabBtn = soundTabs?.querySelector('[data-sound-tab="choose"]');
            if (chooseTabBtn) chooseTabBtn.click();
            onInputChange();
            this.instancesPage?._triggerEventToast?.(`Uploaded sound "${data.sound.name}"`);
          }
        } catch (err) {
          if (uploadStatus) {
            uploadStatus.textContent = 'Network error during upload.';
            uploadStatus.style.color = 'var(--critical)';
            uploadStatus.classList.remove('hidden');
          }
        } finally {
          uploadSubmitBtn.disabled = false;
          uploadSubmitBtn.textContent = 'Upload';
        }
      });
    }

    if (ytImportBtn) {
      ytImportBtn.addEventListener('click', async () => {
        const url = ytUrlInput?.value?.trim();
        if (!url) {
          if (ytStatus) {
            ytStatus.textContent = 'Please enter a valid YouTube URL.';
            ytStatus.style.color = 'var(--critical)';
            ytStatus.classList.remove('hidden');
          }
          return;
        }
        ytImportBtn.disabled = true;
        ytImportBtn.textContent = 'Importing…';
        if (ytStatus) {
          ytStatus.textContent = 'Contacting server…';
          ytStatus.style.color = 'var(--text-muted)';
          ytStatus.classList.remove('hidden');
        }

        try {
          const res = await fetch('/api/alarm-sounds/import', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'X-Requested-With': 'XMLHttpRequest'
            },
            body: JSON.stringify({
              url: url,
              name: ytNameInput?.value?.trim() || ''
            })
          });
          const data = await res.json();
          if (!res.ok) {
            if (ytStatus) {
              ytStatus.textContent = data.error || 'Import failed.';
              ytStatus.style.color = 'var(--critical)';
              ytStatus.classList.remove('hidden');
            }
          } else {
            if (ytStatus) {
              ytStatus.textContent = 'Import successful!';
              ytStatus.style.color = 'var(--success)';
              ytStatus.classList.remove('hidden');
            }
            if (ytUrlInput) ytUrlInput.value = '';
            if (ytNameInput) ytNameInput.value = '';
            await loadSoundsList(data.sound.id);
            const chooseTabBtn = soundTabs?.querySelector('[data-sound-tab="choose"]');
            if (chooseTabBtn) chooseTabBtn.click();
            onInputChange();
          }
        } catch (err) {
          if (ytStatus) {
            ytStatus.textContent = 'Network error during import.';
            ytStatus.style.color = 'var(--critical)';
            ytStatus.classList.remove('hidden');
          }
        } finally {
          ytImportBtn.disabled = false;
          ytImportBtn.textContent = 'Import';
        }
      });
    }

    const getFormDraft = () => ({
      initial_delay_s: Math.max(0, parseInt(initialDelayInput?.value, 10) || 0),
      ring_duration_s: Math.max(1, parseInt(ringDurationInput?.value, 10) || 10),
      repeat_interval_s: Math.max(5, parseInt(repeatIntervalInput?.value, 10) || 120),
      repeat_enabled: Boolean(repeatEnabledCheckbox?.checked),
      ack_behavior: ackSilenceRadio?.checked ? 'silence' : 'remind',
      ack_reminder_interval_s: Math.max(5, parseInt(ackReminderIntervalInput?.value, 10) || 300),
      ack_reminder_ring_duration_s: Math.max(1, parseInt(ackReminderRingInput?.value, 10) || 10),
      sound_id: soundSelect?.value || 'alarm-default'
    });

    const renderTimeline = (p) => {
      if (!timelineTrack) return;
      const html = [];
      const chevron = '<div class="ap-step-connector"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="9 18 15 12 9 6"/></svg></div>';

      // 1. Host DOWN
      html.push(`
        <div class="ap-step ap-step-down">
          <div class="ap-step-icon">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
          </div>
          <div class="ap-step-title">Host DOWN</div>
          <div class="ap-step-sub">${p.initial_delay_s > 0 ? p.initial_delay_s + 's delay' : 'Immediate'}</div>
        </div>
      `);

      html.push(chevron);

      // 2. Primary Alarm
      html.push(`
        <div class="ap-step ap-step-ring">
          <div class="ap-step-icon">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>
          </div>
          <div class="ap-step-title">Ring Alert</div>
          <div class="ap-step-sub">${p.ring_duration_s}s sound</div>
        </div>
      `);

      html.push(chevron);

      // 3. Repeating / Silent
      if (p.repeat_enabled) {
        html.push(`
          <div class="ap-step ap-step-repeat">
            <div class="ap-step-icon">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/></svg>
            </div>
            <div class="ap-step-title">Repeating</div>
            <div class="ap-step-sub">Every ${formatDurationSeconds(p.repeat_interval_s)}</div>
          </div>
        `);
      } else {
        html.push(`
          <div class="ap-step ap-step-silent">
            <div class="ap-step-icon">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M13.73 21a2 2 0 0 1-3.46 0"/><path d="M18.63 13A17.89 17.89 0 0 1 18 8"/><path d="M6.26 6.26A5.86 5.86 0 0 0 6 8c0 7-3 9-3 9h14"/><line x1="1" y1="1" x2="23" y2="23"/></svg>
            </div>
            <div class="ap-step-title">Single Alert</div>
            <div class="ap-step-sub">Then silent</div>
          </div>
        `);
      }

      html.push(chevron);

      // 4. On Acknowledgment (ACK)
      if (p.ack_behavior === 'silence') {
        html.push(`
          <div class="ap-step ap-step-ack-silence">
            <div class="ap-step-icon">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><line x1="23" y1="9" x2="17" y2="15"/><line x1="17" y1="9" x2="23" y2="15"/></svg>
            </div>
            <div class="ap-step-title">ACK Muted</div>
            <div class="ap-step-sub">Until UP</div>
          </div>
        `);
      } else {
        html.push(`
          <div class="ap-step ap-step-ack-remind">
            <div class="ap-step-icon">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
            </div>
            <div class="ap-step-title">ACK Remind</div>
            <div class="ap-step-sub">Every ${formatDurationSeconds(p.ack_reminder_interval_s)}</div>
          </div>
        `);
      }

      html.push(chevron);

      // 5. Recovery
      html.push(`
        <div class="ap-step ap-step-recovery">
          <div class="ap-step-icon">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>
          </div>
          <div class="ap-step-title">Recovery</div>
          <div class="ap-step-sub">Host UP</div>
        </div>
      `);

      timelineTrack.innerHTML = html.join('');
    };

    const detectMatchingPreset = (p) => {
      for (const [key, preset] of Object.entries(ALARM_PRESETS)) {
        if (
          p.initial_delay_s === preset.initial_delay_s &&
          p.ring_duration_s === preset.ring_duration_s &&
          p.repeat_interval_s === preset.repeat_interval_s &&
          p.repeat_enabled === preset.repeat_enabled &&
          p.ack_behavior === preset.ack_behavior &&
          (p.sound_id || 'alarm-default') === (preset.sound_id || 'alarm-default') &&
          (p.ack_behavior === 'silence' || (
            p.ack_reminder_interval_s === preset.ack_reminder_interval_s &&
            p.ack_reminder_ring_duration_s === preset.ack_reminder_ring_duration_s
          ))
        ) {
          return key;
        }
      }
      return 'custom';
    };

    const updatePresetChips = (activeKey) => {
      if (!presetChips) return;
      presetChips.querySelectorAll('.chip').forEach(chip => {
        chip.classList.toggle('chip-active', chip.dataset.preset === activeKey);
      });
      if (previewMode) {
        previewMode.textContent = activeKey === 'custom' ? 'Custom Policy' : `Preset: ${activeKey.replace('_', ' ').toUpperCase()}`;
      }
    };

    const populateForm = (p) => {
      if (initialDelayInput) initialDelayInput.value = p.initial_delay_s;
      if (ringDurationInput) ringDurationInput.value = p.ring_duration_s;
      if (repeatIntervalInput) repeatIntervalInput.value = p.repeat_interval_s;
      if (repeatEnabledCheckbox) repeatEnabledCheckbox.checked = p.repeat_enabled;
      if (p.ack_behavior === 'silence') {
        if (ackSilenceRadio) ackSilenceRadio.checked = true;
      } else {
        if (ackRemindRadio) ackRemindRadio.checked = true;
      }
      if (ackReminderIntervalInput) ackReminderIntervalInput.value = p.ack_reminder_interval_s;
      if (ackReminderRingInput) ackReminderRingInput.value = p.ack_reminder_ring_duration_s;

      if (repeatIntervalGroup) repeatIntervalGroup.style.opacity = p.repeat_enabled ? '1' : '0.4';
      if (ackRemindControls) ackRemindControls.style.display = p.ack_behavior === 'silence' ? 'none' : 'grid';

      if (soundSelect && p.sound_id) {
        soundSelect.value = p.sound_id;
      }
      updateSoundMeta();

      renderTimeline(p);
      updatePresetChips(detectMatchingPreset(p));
    };

    const openModal = async () => {
      const current = alarmPolicyManager.getPolicy();
      await loadSoundsList(current.sound_id || 'alarm-default');
      populateForm(current);
      if (errorEl) errorEl.classList.add('hidden');
      if (successEl) successEl.style.display = 'none';
      if (uploadStatus) uploadStatus.classList.add('hidden');
      if (ytStatus) ytStatus.classList.add('hidden');
      modal.classList.remove('hidden');
      initialDelayInput?.focus();
    };

    const closeModal = () => {
      stopPreview();
      modal.classList.add('hidden');
    };

    openBtns.forEach(btn => btn.addEventListener('click', openModal));
    if (closeBtn) closeBtn.addEventListener('click', closeModal);
    if (cancelBtn) cancelBtn.addEventListener('click', closeModal);
    modal.addEventListener('click', (e) => {
      if (e.target === modal) closeModal();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !modal.classList.contains('hidden')) {
        closeModal();
      }
    });

    const onInputChange = () => {
      const draft = getFormDraft();
      if (repeatIntervalGroup) repeatIntervalGroup.style.opacity = draft.repeat_enabled ? '1' : '0.4';
      if (ackRemindControls) ackRemindControls.style.display = draft.ack_behavior === 'silence' ? 'none' : 'grid';
      renderTimeline(draft);
      updatePresetChips(detectMatchingPreset(draft));
    };

    [
      initialDelayInput, ringDurationInput, repeatIntervalInput,
      repeatEnabledCheckbox, ackSilenceRadio, ackRemindRadio,
      ackReminderIntervalInput, ackReminderRingInput
    ].forEach(el => {
      if (el) {
        el.addEventListener('input', onInputChange);
        el.addEventListener('change', onInputChange);
      }
    });

    if (presetChips) {
      presetChips.addEventListener('click', (e) => {
        const chip = e.target.closest('.chip');
        if (!chip || !chip.dataset.preset) return;
        const key = chip.dataset.preset;
        if (key === 'custom') {
          updatePresetChips('custom');
          return;
        }
        const preset = ALARM_PRESETS[key];
        if (preset) {
          populateForm({ ...alarmPolicyManager.getPolicy(), ...preset });
        }
      });
    }

    if (resetBtn) {
      resetBtn.addEventListener('click', () => {
        populateForm(DEFAULT_ALARM_POLICY);
      });
    }

    if (form) {
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const draft = getFormDraft();
        if (errorEl) errorEl.classList.add('hidden');
        if (successEl) successEl.style.display = 'none';
        if (submitBtn) {
          submitBtn.disabled = true;
          submitBtn.textContent = 'Saving…';
        }

        try {
          const res = await alarmPolicyManager.save(draft);
          if (res.ok) {
            if (successEl) {
              successEl.textContent = 'Alarm Policy saved successfully.';
              successEl.style.display = 'block';
            }
            this.instancesPage?._triggerEventToast?.('Alarm Policy updated successfully');
            renderTimeline(res.policy);
            this._syncAlarmAudio();
            setTimeout(() => closeModal(), 600);
          } else {
            if (errorEl) {
              errorEl.textContent = res.error || 'Failed to save policy';
              errorEl.classList.remove('hidden');
            }
          }
        } catch (err) {
          if (errorEl) {
            errorEl.textContent = 'Network error saving policy';
            errorEl.classList.remove('hidden');
          }
        } finally {
          if (submitBtn) {
            submitBtn.disabled = false;
            submitBtn.textContent = 'Save Policy';
          }
        }
      });
    }
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
  _alarmPhaseFor(t, nowMs) {
    if (!t) return 'silent';
    const isAcked = Boolean(this.instancesPage?.acknowledgedDownInstances?.has(t.instance) || t.acknowledged);
    const targetWithAck = isAcked !== Boolean(t.acknowledged) ? { ...t, acknowledged: isAcked } : t;
    const res = alarmPolicyManager.evaluate(targetWithAck, nowMs);
    return res.isAudible ? 'burst' : 'silent';
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
    const shouldPlay = !this.isMuted && canPlayTab && targets.some(t => this._alarmPhaseFor(t, now) === 'burst');

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
