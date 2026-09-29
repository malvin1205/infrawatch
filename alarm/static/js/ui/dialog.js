/* Modal helpers shared across the app. Both are published on `window`
 * because callers reference them as window.trapModalFocus /
 * window.showConfirmDialog from several modules.
 */

/* ── Modal Focus Trap Helper (WCAG 2.1 SC 2.4.3) ──────── */
window.trapModalFocus = function (modalEl) {
  if (!modalEl) return () => {};
  const handler = function (e) {
    if (e.key !== 'Tab') return;
    const focusable = Array.from(modalEl.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')).filter(el => !el.disabled && el.offsetWidth > 0 && el.offsetHeight > 0);
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];

    if (e.shiftKey) {
      if (document.activeElement === first || !modalEl.contains(document.activeElement)) {
        last.focus();
        e.preventDefault();
      }
    } else {
      if (document.activeElement === last || !modalEl.contains(document.activeElement)) {
        first.focus();
        e.preventDefault();
      }
    }
  };

  modalEl.addEventListener('keydown', handler);
  return () => modalEl.removeEventListener('keydown', handler);
};

/* ── Modern Confirmation Dialog Helper ─────────────── */
// `input` ({ type, placeholder, minLength, autocomplete }) adds a field:
// resolves its value on confirm (null on cancel) instead of true/false.
window.showConfirmDialog = function ({ title, message, confirmText = 'Yes, Delete', cancelText = 'Cancel', isDanger = true, input = null }) {
  return new Promise((resolve) => {
    const modal = document.getElementById('confirmModal');
    const titleEl = document.getElementById('confirmModalTitle');
    const msgEl = document.getElementById('confirmModalMessage');
    const cancelBtn = document.getElementById('confirmCancelBtn');
    const actionBtn = document.getElementById('confirmActionBtn');
    const closeBtn = document.getElementById('closeConfirmModalBtn');

    if (!modal) {
      resolve(window.confirm(message));
      return;
    }

    if (titleEl) titleEl.textContent = title || 'Confirm Action';
    if (msgEl) msgEl.textContent = message || 'Are you sure?';
    if (cancelBtn) cancelBtn.textContent = cancelText;
    if (actionBtn) {
      actionBtn.textContent = confirmText;
      actionBtn.style.background = isDanger ? '#EF4444' : 'var(--accent)';
    }

    let field = null, errEl = null;
    if (input && msgEl) {
      field = document.createElement('input');
      field.className = 'form-input';
      field.style.width = '100%';
      field.type = input.type || 'text';
      field.placeholder = input.placeholder || '';
      field.autocomplete = input.autocomplete || 'off';
      errEl = document.createElement('div');
      errEl.className = 'form-error hidden';
      errEl.style.margin = '8px 0 16px';
      msgEl.after(field, errEl);
      field.addEventListener('keydown', e => { if (e.key === 'Enter') onConfirm(); });
    }

    modal.classList.remove('hidden');
    const untrap = window.trapModalFocus(modal);
    setTimeout(() => { (field || cancelBtn)?.focus(); }, 50);

    const cleanup = (result) => {
      untrap();
      modal.classList.add('hidden');
      if (field) { field.remove(); errEl.remove(); }
      if (cancelBtn) cancelBtn.removeEventListener('click', onCancel);
      if (actionBtn) actionBtn.removeEventListener('click', onConfirm);
      if (closeBtn) closeBtn.removeEventListener('click', onCancel);
      resolve(result);
    };

    const onCancel = () => cleanup(field ? null : false);
    const onConfirm = () => {
      if (!field) return cleanup(true);
      const min = input.minLength || 0;
      if (field.value.length < min) {
        errEl.textContent = `Must be at least ${min} characters.`;
        errEl.classList.remove('hidden');
        field.focus();
        return;
      }
      cleanup(field.value);
    };

    if (cancelBtn) cancelBtn.addEventListener('click', onCancel);
    if (actionBtn) actionBtn.addEventListener('click', onConfirm);
    if (closeBtn) closeBtn.addEventListener('click', onCancel);
  });
};
