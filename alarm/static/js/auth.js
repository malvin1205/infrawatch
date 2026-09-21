/* Session auth + current-user state + the user-management modal.
 * Wired up by initAuth() at boot. */
import { apiFetch } from './net.js';
import { escapeHtml } from './ui/format.js';

// ── Session Authentication & Current User State ─────────────────────────────
window.currentUser = null;
window.isSystemInitialized = true;

async function checkAuthStatus() {
  try {
    const res = await fetch('/api/auth/status', {
      headers: { 'X-Requested-With': 'XMLHttpRequest' },
      credentials: 'same-origin'
    });
    if (res.ok) {
      const data = await res.json();
      window.isSystemInitialized = data.initialized;
      window.currentUser = data.user;
      updateUserUI(data.user);
      if (!data.initialized) {
        showSetupModal();
      }
      return data;
    }
  } catch (e) {
    console.error('Failed to fetch auth status', e);
  }
  return null;
}

function showSetupModal() {
  const modal = document.getElementById('setupModal');
  if (modal) {
    modal.classList.remove('hidden');
    document.getElementById('setupUsernameInput')?.focus();
  }
}

function closeSetupModal() {
  const modal = document.getElementById('setupModal');
  if (modal) modal.classList.add('hidden');
}

function showLoginModal() {
  const modal = document.getElementById('loginModal');
  if (modal) {
    modal.classList.remove('hidden');
    document.getElementById('loginUsernameInput')?.focus();
  }
}

function closeLoginModal() {
  const modal = document.getElementById('loginModal');
  if (modal) modal.classList.add('hidden');
}

// 'owner' (the founding account) and 'admin' share the same UI privileges;
// what only the owner can do is enforced server-side in the user-mgmt routes.
export function isAdminLike(u) {
  return !!u && (u.role === 'admin' || u.role === 'owner');
}

function showUsersModal() {
  // Manage Users needs an admin/owner session. The header button is already
  // hidden for non-admins, but a stale click (session expired since page load)
  // or a direct call should route to login, not open a modal that only 401s.
  if (!isAdminLike(window.currentUser)) {
    showLoginModal();
    return;
  }
  const modal = document.getElementById('usersModal');
  if (modal) {
    modal.classList.remove('hidden');
    fetchUsersList();
    document.getElementById('newUsernameInput')?.focus();
  }
}

function closeUsersModal() {
  const modal = document.getElementById('usersModal');
  if (modal) modal.classList.add('hidden');
}

export function showTelegramModal() {
  if (!isAdminLike(window.currentUser)) {
    showLoginModal();
    return;
  }
  const modal = document.getElementById('telegramModal');
  if (modal) {
    modal.classList.remove('hidden');
    loadTelegramConfig();
    document.getElementById('tgChatIdInput')?.focus();
  }
}

export function closeTelegramModal() {
  const modal = document.getElementById('telegramModal');
  if (modal) modal.classList.add('hidden');
}

async function loadTelegramConfig() {
  const errEl = document.getElementById('tgError');
  const succEl = document.getElementById('tgSuccess');
  const testStatus = document.getElementById('tgTestStatus');
  if (errEl) { errEl.textContent = ''; errEl.classList.add('hidden'); }
  if (succEl) { succEl.textContent = ''; succEl.style.display = 'none'; }
  if (testStatus) { testStatus.textContent = ''; }

  try {
    const res = await apiFetch('/api/telegram');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (data.ok) {
      const enabledCb = document.getElementById('tgEnabledCheckbox');
      const chatIdInput = document.getElementById('tgChatIdInput');
      const minSevSel = document.getElementById('tgMinSeveritySelect');
      const sendFiringCb = document.getElementById('tgSendFiringCheckbox');
      const sendResolvedCb = document.getElementById('tgSendResolvedCheckbox');
      const tokenMaskedHint = document.getElementById('tgTokenMaskedHint');
      const tokenInput = document.getElementById('tgBotTokenInput');

      if (enabledCb) enabledCb.checked = data.enabled !== false;
      if (chatIdInput) chatIdInput.value = data.chat_id || '';
      if (minSevSel && data.min_severity) minSevSel.value = data.min_severity;
      if (sendFiringCb) sendFiringCb.checked = data.send_firing !== false;
      if (sendResolvedCb) sendResolvedCb.checked = data.send_resolved !== false;
      if (tokenInput) tokenInput.value = '';
      if (tokenMaskedHint) {
        tokenMaskedHint.textContent = data.bot_token_masked
          ? `Current active token: ${data.bot_token_masked}`
          : 'No bot token currently configured.';
      }
    }
  } catch (err) {
    if (errEl) {
      errEl.textContent = 'Failed to load Telegram configuration: ' + err.message;
      errEl.classList.remove('hidden');
    }
  }
}

async function patchUser(userId, payload) {
  const res = await apiFetch(`/api/auth/users/${userId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok) {
    alert(data.error || 'Failed to update user');
    return false;
  }
  return true;
}

function initUsersListActions() {
  const container = document.getElementById('usersListContainer');
  if (!container) return;

  container.addEventListener('change', async (e) => {
    const sel = e.target.closest('.user-role-select');
    if (!sel) return;
    const prevValue = sel.dataset.prev || (sel.value === 'admin' ? 'viewer' : 'admin');
    sel.disabled = true;
    const ok = await patchUser(sel.dataset.userId, { role: sel.value });
    sel.disabled = false;
    if (ok) { sel.dataset.prev = sel.value; }
    else { sel.value = prevValue; }
  });

  container.addEventListener('click', async (e) => {
    const toggleBtn = e.target.closest('.user-status-toggle');
    if (toggleBtn) {
      if (toggleBtn.disabled) return;
      const wasActive = toggleBtn.dataset.active === '1';
      toggleBtn.disabled = true;
      const ok = await patchUser(toggleBtn.dataset.userId, { is_active: !wasActive });
      toggleBtn.disabled = false;
      if (ok) fetchUsersList();
      return;
    }
    const resetBtn = e.target.closest('.user-reset-pw-btn');
    if (resetBtn) {
      if (resetBtn.disabled) return;
      const newPassword = prompt('New password (min 12 chars):');
      if (newPassword === null) return;
      if (newPassword.length < 12) { alert('Password must be at least 12 characters'); return; }
      resetBtn.disabled = true;
      const ok = await patchUser(resetBtn.dataset.userId, { password: newPassword });
      resetBtn.disabled = false;
      if (ok) alert('Password updated.');
    }
  });
}

async function fetchUsersList() {
  const container = document.getElementById('usersListContainer');
  if (!container) return;
  const createForm = document.getElementById('createUserForm');
  try {
    const res = await apiFetch('/api/auth/users');
    if (res.status === 401 || res.status === 403) {
      // apiFetch suppresses its auto login-modal for /api/auth/* URLs, so a
      // 401 here just rendered a bare "Unauthorized". Make it actionable and
      // hide the create form (pointless without admin access).
      if (createForm) createForm.classList.add('hidden');
      container.innerHTML = `<div style="padding: 16px; text-align: center; font-size: 12px; color: var(--text-secondary);">`
        + `Your session has expired or you are not signed in as an administrator.`
        + `<div style="margin-top: 10px;"><button type="button" id="usersModalLoginBtn" class="btn btn-primary btn-sm">Log In</button></div>`
        + `</div>`;
      document.getElementById('usersModalLoginBtn')?.addEventListener('click', () => { closeUsersModal(); showLoginModal(); });
      return;
    }
    if (createForm) createForm.classList.remove('hidden');
    const data = await res.json();
    if (res.ok && data.ok) {
      if (!data.users || data.users.length === 0) {
        container.innerHTML = '<div style="padding: 12px; text-align: center; color: var(--text-muted); font-size: 12px;">No users found.</div>';
        return;
      }
      const selfId = window.currentUser ? window.currentUser.id : null;
      const viewerIsOwner = window.currentUser && window.currentUser.role === 'owner';
      container.innerHTML = `
        <table style="width: 100%; border-collapse: collapse; font-size: 12px; text-align: left;">
          <thead>
            <tr style="border-bottom: 1px solid var(--border); color: var(--text-secondary); background: var(--bg-card);">
              <th style="padding: 8px 12px;">Username</th>
              <th style="padding: 8px 12px;">Display Name</th>
              <th style="padding: 8px 12px;">Role</th>
              <th style="padding: 8px 12px;">Status</th>
              <th style="padding: 8px 12px; text-align: right;">Actions</th>
            </tr>
          </thead>
          <tbody>
            ${data.users.map(u => {
              // The owner row is read-only to everyone but the owner: no role
              // change (role is permanent), and status/password locked for a
              // non-owner viewer. Mirrors the server-side guards.
              const isOwnerRow = u.role === 'owner';
              const rowLocked = isOwnerRow && !viewerIsOwner;
              const roleCell = isOwnerRow
                ? `<span class="user-role-pill role-owner">OWNER</span>`
                : `<select class="search-input user-role-select" data-user-id="${u.id}" style="font-size: 11px; padding: 3px 6px; border-radius: var(--r-sm);">
                    <option value="admin" ${u.role === 'admin' ? 'selected' : ''}>ADMIN</option>
                    <option value="viewer" ${u.role === 'viewer' ? 'selected' : ''}>VIEWER</option>
                  </select>`;
              return `
              <tr style="border-bottom: 1px solid var(--border-subtle);" data-user-row="${u.id}">
                <td style="padding: 8px 12px; font-weight: 600; color: var(--text-primary);">${escapeHtml(u.username)}${u.id === selfId ? ' <span style="color: var(--text-muted); font-weight: 400;">(you)</span>' : ''}</td>
                <td style="padding: 8px 12px; color: var(--text-secondary);">${escapeHtml(u.display_name) || '—'}</td>
                <td style="padding: 8px 12px;">${roleCell}</td>
                <td style="padding: 8px 12px;">
                  <button type="button" class="user-status-toggle" data-user-id="${u.id}" data-active="${u.is_active ? '1' : '0'}" ${rowLocked ? 'disabled' : ''} style="background: none; border: none; cursor: ${rowLocked ? 'not-allowed' : 'pointer'}; padding: 0; color: ${u.is_active ? 'var(--success)' : 'var(--critical)'}; font-weight: 500; font-size: 12px; opacity: ${rowLocked ? '0.5' : '1'};">
                    ${u.is_active ? '● Active' : '○ Inactive'}
                  </button>
                </td>
                <td style="padding: 8px 12px; text-align: right;">
                  <button type="button" class="btn btn-secondary user-reset-pw-btn" data-user-id="${u.id}" ${rowLocked ? 'disabled' : ''} style="padding: 3px 8px; font-size: 11px; ${rowLocked ? 'opacity: 0.5; cursor: not-allowed;' : ''}">Reset Password</button>
                </td>
              </tr>
            `;
            }).join('')}
          </tbody>
        </table>
      `;
    } else {
      container.innerHTML = `<div style="padding: 12px; text-align: center; color: var(--critical); font-size: 12px;">${data.error || 'Failed to load users'}</div>`;
    }
  } catch (err) {
    if (createForm) createForm.classList.remove('hidden');
    container.innerHTML = '<div style="padding: 12px; text-align: center; color: var(--critical); font-size: 12px;">Network error loading users</div>';
  }
}

// Write controls a read-only viewer cannot actually use. The server already
// refuses these via @require_permission, so this is purely about not letting an
// operator discover their own permissions by having an action fail (audit 4.8).
// Ids only — no behaviour change for admins/owners.
const WRITE_CONTROL_IDS = [
  'drawerMaintStartBtn',        // maintenance.write
  'drawerDependencyRemoveBtn',  // dependencies.write
  'drawerDeleteBtn',            // targets.write
  'ackAlarmBtn',                // alerts.ack
  'openAddTargetModalBtn',      // targets.write
  'submitAddTargetBtn',         // targets.write
  'selectModeBtn',              // targets.write
  'removeSelectedBtn',          // targets.write
  'bulkMaintenanceBtn',         // maintenance.write
  'bulkMaintSubmitBtn',         // maintenance.write
];

function applyRolePermissions(user) {
  const readOnly = !isAdminLike(user);
  WRITE_CONTROL_IDS.forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    el.disabled = readOnly;
    el.classList.toggle('is-readonly', readOnly);
    if (readOnly) {
      el.setAttribute('title', 'Read-only account — sign in as an operator to change this');
    } else if (el.getAttribute('title') === 'Read-only account — sign in as an operator to change this') {
      el.removeAttribute('title');
    }
  });
}

function updateUserUI(user) {
  const avatar = document.getElementById('userAvatar');
  const nameLabel = document.getElementById('userNameLabel');
  const rolePill = document.getElementById('userRolePill');
  const dropdownName = document.getElementById('dropdownUserName');
  const dropdownRole = document.getElementById('dropdownUserRole');
  const loginBtn = document.getElementById('headerLoginBtn');
  const logoutBtn = document.getElementById('headerLogoutBtn');
  const manageUsersBtn = document.getElementById('headerManageUsersBtn');
  const telegramBtn = document.getElementById('headerTelegramBtn');

  if (user && user.username) {
    const name = user.display_name || user.username;
    if (avatar) avatar.textContent = (name[0] || 'U').toUpperCase();
    if (nameLabel) nameLabel.textContent = name;
    if (rolePill) {
      rolePill.textContent = (user.role || 'viewer').toUpperCase();
      rolePill.className = `user-role-pill role-${user.role || 'viewer'}`;
    }
    if (dropdownName) dropdownName.textContent = name;
    if (dropdownRole) dropdownRole.textContent = user.role === 'owner' ? 'Owner' : user.role === 'admin' ? 'Administrator' : 'Read-Only Viewer';
    if (loginBtn) loginBtn.classList.add('hidden');
    if (logoutBtn) logoutBtn.classList.remove('hidden');
    if (manageUsersBtn) {
      if (isAdminLike(user)) manageUsersBtn.classList.remove('hidden');
      else manageUsersBtn.classList.add('hidden');
    }
    if (telegramBtn) {
      if (isAdminLike(user)) telegramBtn.classList.remove('hidden');
      else telegramBtn.classList.add('hidden');
    }
  } else {
    if (avatar) avatar.textContent = 'G';
    if (nameLabel) nameLabel.textContent = 'Guest';
    if (rolePill) {
      rolePill.textContent = 'VIEWER';
      rolePill.className = 'user-role-pill role-viewer';
    }
    if (dropdownName) dropdownName.textContent = 'Guest Operator';
    if (dropdownRole) dropdownRole.textContent = 'Read-Only Viewer';
    if (loginBtn) loginBtn.classList.remove('hidden');
    if (logoutBtn) logoutBtn.classList.add('hidden');
    if (manageUsersBtn) manageUsersBtn.classList.add('hidden');
    if (telegramBtn) telegramBtn.classList.add('hidden');
  }

  applyRolePermissions(user);
}


export function initAuth() {
  // apiFetch (net.js) dispatches this on a 401 instead of reaching in here.
  window.addEventListener('iw:unauthorized', () => showLoginModal());

  // First-run Admin Setup Form
  const setupForm = document.getElementById('setupForm');
  if (setupForm) {
    setupForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const username = document.getElementById('setupUsernameInput')?.value.trim();
      const password = document.getElementById('setupPasswordInput')?.value;
      const confirm = document.getElementById('setupConfirmPasswordInput')?.value;
      const displayName = document.getElementById('setupDisplayNameInput')?.value.trim();
      const errorEl = document.getElementById('setupError');

      if (errorEl) errorEl.classList.add('hidden');

      try {
        const res = await fetch('/api/auth/setup', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
          credentials: 'same-origin',
          body: JSON.stringify({
            username, password, confirm_password: confirm, display_name: displayName
          })
        });
        const data = await res.json();
        if (res.ok && data.ok) {
          closeSetupModal();
          window.isSystemInitialized = true;
          window.currentUser = data.user;
          updateUserUI(data.user);
          if (window.monitor && window.monitor.instancesPage) {
            window.monitor.instancesPage._triggerEventToast(`System initialized. Logged in as ${data.user.username}`);
          }
        } else {
          if (errorEl) {
            errorEl.textContent = data.error || 'Failed to initialize administrator';
            errorEl.classList.remove('hidden');
          }
        }
      } catch (err) {
        if (errorEl) {
          errorEl.textContent = err.message || 'Network error';
          errorEl.classList.remove('hidden');
        }
      }
    });
  }

  // Operator Login Form
  const loginForm = document.getElementById('loginForm');
  if (loginForm) {
    loginForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const username = document.getElementById('loginUsernameInput')?.value.trim();
      const password = document.getElementById('loginPasswordInput')?.value;
      const errorEl = document.getElementById('loginError');

      if (errorEl) errorEl.classList.add('hidden');

      try {
        const res = await fetch('/api/auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
          credentials: 'same-origin',
          body: JSON.stringify({ username, password })
        });
        const data = await res.json();
        if (res.ok && data.ok) {
          closeLoginModal();
          window.currentUser = data.user;
          updateUserUI(data.user);
          if (window.monitor && window.monitor.instancesPage) {
            window.monitor.instancesPage._triggerEventToast(`Logged in as ${data.user.username}`);
            window.monitor.instancesPage.load();
          }
        } else {
          if (errorEl) {
            errorEl.textContent = data.error || 'Invalid username or password';
            errorEl.classList.remove('hidden');
          }
        }
      } catch (err) {
        if (errorEl) {
          errorEl.textContent = err.message || 'Network error';
          errorEl.classList.remove('hidden');
        }
      }
    });
  }

  // User Menu dropdown toggle & action buttons
  const userMenuBtn = document.getElementById('userMenuBtn');
  const userDropdown = document.getElementById('userDropdown');
  if (userMenuBtn && userDropdown) {
    userMenuBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const isHidden = userDropdown.classList.contains('hidden');
      if (isHidden) {
        userDropdown.classList.remove('hidden');
        userMenuBtn.setAttribute('aria-expanded', 'true');
      } else {
        userDropdown.classList.add('hidden');
        userMenuBtn.setAttribute('aria-expanded', 'false');
      }
    });
    document.addEventListener('click', (e) => {
      if (!userDropdown.classList.contains('hidden') && !e.target.closest('#userAuthWrap')) {
        userDropdown.classList.add('hidden');
        userMenuBtn.setAttribute('aria-expanded', 'false');
      }
    });
  }

  document.getElementById('headerLoginBtn')?.addEventListener('click', () => {
    userDropdown?.classList.add('hidden');
    showLoginModal();
  });

  document.getElementById('closeLoginModalBtn')?.addEventListener('click', closeLoginModal);
  document.getElementById('cancelLoginBtn')?.addEventListener('click', closeLoginModal);

  document.getElementById('headerLogoutBtn')?.addEventListener('click', async () => {
    userDropdown?.classList.add('hidden');
    try {
      await fetch('/api/auth/logout', {
        method: 'POST',
        headers: { 'X-Requested-With': 'XMLHttpRequest' },
        credentials: 'same-origin'
      });
    } catch (e) {}
    window.currentUser = null;
    updateUserUI(null);
    if (window.monitor && window.monitor.instancesPage) {
      window.monitor.instancesPage._triggerEventToast('Logged out');
      window.monitor.instancesPage.load();
    }
  });

  document.getElementById('headerManageUsersBtn')?.addEventListener('click', () => {
    userDropdown?.classList.add('hidden');
    showUsersModal();
  });

  document.getElementById('closeUsersModalBtn')?.addEventListener('click', closeUsersModal);
  document.getElementById('cancelUsersModalBtn')?.addEventListener('click', closeUsersModal);
  initUsersListActions();

  // Telegram Notifications Modal bindings
  document.getElementById('headerTelegramBtn')?.addEventListener('click', () => {
    userDropdown?.classList.add('hidden');
    showTelegramModal();
  });

  document.getElementById('closeTelegramModalBtn')?.addEventListener('click', closeTelegramModal);
  document.getElementById('tgCancelBtn')?.addEventListener('click', closeTelegramModal);

  document.getElementById('telegramModal')?.addEventListener('click', (e) => {
    if (e.target.id === 'telegramModal') closeTelegramModal();
  });

  document.getElementById('tgToggleTokenVisibilityBtn')?.addEventListener('click', () => {
    const input = document.getElementById('tgBotTokenInput');
    if (!input) return;
    input.type = input.type === 'password' ? 'text' : 'password';
  });

  document.getElementById('tgTestBtn')?.addEventListener('click', async () => {
    const statusEl = document.getElementById('tgTestStatus');
    const testBtn = document.getElementById('tgTestBtn');
    const tokenInput = document.getElementById('tgBotTokenInput');
    const chatIdInput = document.getElementById('tgChatIdInput');
    if (statusEl) {
      statusEl.textContent = 'Testing connection...';
      statusEl.style.color = 'var(--text-muted)';
    }
    if (testBtn) testBtn.disabled = true;

    try {
      const payload = {
        chat_id: chatIdInput?.value.trim() || ''
      };
      const token = tokenInput?.value.trim();
      if (token) payload.bot_token = token;

      const res = await apiFetch('/api/telegram/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const data = await res.json();
      if (res.ok && data.ok) {
        if (statusEl) {
          statusEl.textContent = '✓ ' + (data.message || 'Connected successfully!');
          statusEl.style.color = 'var(--success)';
        }
      } else {
        if (statusEl) {
          statusEl.textContent = '✗ ' + (data.error || 'Connection failed');
          statusEl.style.color = 'var(--critical)';
        }
      }
    } catch (err) {
      if (statusEl) {
        statusEl.textContent = '✗ ' + (err.message || 'Request failed');
        statusEl.style.color = 'var(--critical)';
      }
    } finally {
      if (testBtn) testBtn.disabled = false;
    }
  });

  const tgForm = document.getElementById('telegramSettingsForm');
  if (tgForm) {
    tgForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const errEl = document.getElementById('tgError');
      const succEl = document.getElementById('tgSuccess');
      const saveBtn = document.getElementById('tgSaveBtn');
      if (errEl) { errEl.textContent = ''; errEl.classList.add('hidden'); }
      if (succEl) { succEl.textContent = ''; succEl.style.display = 'none'; }
      if (saveBtn) saveBtn.disabled = true;

      try {
        const payload = {
          enabled: !!document.getElementById('tgEnabledCheckbox')?.checked,
          chat_id: document.getElementById('tgChatIdInput')?.value.trim() || '',
          min_severity: document.getElementById('tgMinSeveritySelect')?.value || 'warning',
          send_firing: !!document.getElementById('tgSendFiringCheckbox')?.checked,
          send_resolved: !!document.getElementById('tgSendResolvedCheckbox')?.checked
        };
        const token = document.getElementById('tgBotTokenInput')?.value.trim();
        if (token) payload.bot_token = token;

        const res = await apiFetch('/api/telegram', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
        const data = await res.json();
        if (res.ok && data.ok) {
          if (succEl) {
            succEl.textContent = data.message || 'Telegram configuration saved successfully!';
            succEl.style.display = 'block';
          }
          if (window.monitor && window.monitor.instancesPage) {
            window.monitor.instancesPage._triggerEventToast('Telegram settings updated');
          }
          setTimeout(() => {
            closeTelegramModal();
          }, 1200);
        } else {
          if (errEl) {
            errEl.textContent = data.error || 'Failed to save settings';
            errEl.classList.remove('hidden');
          }
        }
      } catch (err) {
        if (errEl) {
          errEl.textContent = err.message || 'Network error';
          errEl.classList.remove('hidden');
        }
      } finally {
        if (saveBtn) saveBtn.disabled = false;
      }
    });
  }

  const createUserForm = document.getElementById('createUserForm');
  if (createUserForm) {
    createUserForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const username = document.getElementById('newUsernameInput')?.value.trim();
      const displayName = document.getElementById('newDisplayNameInput')?.value.trim();
      const password = document.getElementById('newPasswordInput')?.value;
      const role = document.getElementById('newRoleSelect')?.value || 'viewer';
      const errorEl = document.getElementById('createUserError');
      const successEl = document.getElementById('createUserSuccess');

      if (errorEl) errorEl.classList.add('hidden');
      if (successEl) successEl.classList.add('hidden');

      try {
        const res = await apiFetch('/api/auth/users', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            username,
            display_name: displayName,
            password,
            role
          })
        });
        const data = await res.json();
        if (res.ok && data.ok) {
          if (successEl) {
            successEl.textContent = `User "${username}" (${role}) created successfully!`;
            successEl.classList.remove('hidden');
          }
          document.getElementById('newUsernameInput').value = '';
          document.getElementById('newDisplayNameInput').value = '';
          document.getElementById('newPasswordInput').value = '';
          fetchUsersList();
          if (window.monitor && window.monitor.instancesPage) {
            window.monitor.instancesPage._triggerEventToast(`Created user "${username}"`);
          }
        } else {
          if (errorEl) {
            errorEl.textContent = data.error || 'Failed to create user';
            errorEl.classList.remove('hidden');
          }
        }
      } catch (err) {
        if (errorEl) {
          errorEl.textContent = err.message || 'Network error';
          errorEl.classList.remove('hidden');
        }
      }
    });
  }

  // Check auth status on startup
  checkAuthStatus();
}
