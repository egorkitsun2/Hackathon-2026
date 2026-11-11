import { changePassword, getUsers, createUser, updateUser, resetUserPassword, normalizePhone } from './api.js?v=password-reset-20261111-1';
import { t } from './i18n.js?v=password-reset-20261111-1';

const $ = id => document.querySelector(`#${id}`);
let version = 0;
let active = '';
let onChanged;
let page = 1;
let result = null;
let loading = false;
let readId = 0;
let pending = false;
let changingUser = null;
let errors = {};
let notices = {};
let resetTarget = null;
let resetting = false;
let resetVersion = 0;
const resetDialog = $('reset-password-dialog');

function clearReset() {
  resetVersion++;
  resetTarget = null;
  $('reset-temporary-password').textContent = '';
  $('reset-password-person').textContent = '';
  $('reset-password-result').hidden = true;
  notice('reset-copy-status');
  resetDialog.close();
}

function confirmReset(user) {
  if (active !== 'users' || user.role !== 'employee' || pending || resetting || changingUser !== null || loading || !$('user-created').hidden) return;
  clearReset();
  resetTarget = user;
  $('reset-password-person').textContent = `${user.full_name} · ${user.phone}`;
  $('reset-password-blocked').hidden = user.is_active;
  $('reset-password-warning').hidden = false;
  $('confirm-reset-password').hidden = false;
  renderAccounts();
  resetDialog.showModal();
  $('close-reset-password').focus();
}

export function validatePassword(current, next, repeat) {
  const errors = {};
  const bytes = value => new TextEncoder().encode(value).length;
  if (!current.length || bytes(current) > 1024) errors['current-password'] = 'currentPasswordInvalid';
  if (Array.from(next).length < 12 || Array.from(next).length > 128 || bytes(next) > 1024
    || !next.trim() || next.includes('\0') || next === current) errors['new-password'] = 'newPasswordInvalid';
  if (next !== repeat) errors['repeat-password'] = 'passwordMismatch';
  return errors;
}

export function validateEmployee(values) {
  const errors = {};
  if (values.phone.length > 64 || !normalizePhone(values.phone)) errors['user-phone'] = 'phoneInvalid';
  for (const key of ['full_name', 'department', 'position']) {
    const length = Array.from(values[key].trim()).length;
    if (!length || length > 120) errors[`user-${key}`] = 'employeeFieldInvalid';
  }
  return errors;
}

function errorNotice(error) {
  const key = ({ INVALID_CREDENTIALS: 'currentPasswordWrong', PHONE_EXISTS: 'phoneExists',
    FORBIDDEN: 'accountsForbidden', NOT_FOUND: 'employeeNotFound', INVALID_ORIGIN: 'invalidOrigin',
    SERVICE_UNAVAILABLE: 'serviceUnavailable', VALIDATION_ERROR: 'accountValidationError',
    RATE_LIMITED: 'accountRateLimited', NETWORK_ERROR: 'networkError',
    UNAUTHORIZED: 'sessionExpired', ACCOUNT_DISABLED: 'accountDisabled',
  })[error.message] ?? 'apiUnavailable';
  return { key, seconds: error.retryAfter };
}

function notice(id, value = '') { notices[id] = typeof value === 'string' ? { key: value } : value; }
const uncertain = error => ['NETWORK_ERROR', 'API_UNAVAILABLE', 'INTERNAL_ERROR'].includes(error.message);
function clearSecret() {
  $('temporary-password').textContent = '';
  $('created-user-phone').textContent = '';
  $('user-created').hidden = true;
}

export function renderAccounts() {
  for (const id of ['current-password', 'new-password', 'repeat-password', 'user-phone', 'user-full_name', 'user-department', 'user-position']) {
    $(id).setAttribute('aria-invalid', String(Boolean(errors[id])));
    $(`${id}-error`).textContent = errors[id] ? t(errors[id]) : '';
    $(`${id}-error`).hidden = !errors[id];
  }
  for (const id of ['change-password-status', 'create-user-status', 'users-status', 'users-action-status', 'reset-copy-status']) {
    const value = notices[id];
    $(id).textContent = value?.key ? t(value.key) + (value.seconds != null ? ` ${t('retrySeconds')} ${value.seconds}` : '') : '';
  }
  $('change-password-fields').disabled = pending;
  $('create-user-fields').disabled = pending || resetting || !$('user-created').hidden;
  $('confirm-reset-password').disabled = resetting;
  $('close-reset-password').disabled = resetting;
  $('close-reset-password').dataset.i18n = $('reset-password-result').hidden ? 'cancelReset' : 'closeResult';
  $('close-reset-password').textContent = t($('close-reset-password').dataset.i18n);
  $('reset-password-progress').textContent = resetting ? t('savingAccount') : '';
  $('users-list').replaceChildren();
  for (const user of result?.data ?? []) {
    const row = document.createElement('li');
    row.className = 'ticket';
    for (const [tag, text] of [
      ['h3', user.full_name], ['p', `${t('phoneLabel')}: ${user.phone}`],
      ['p', `${t('department')}: ${user.department}`], ['p', `${t('position')}: ${user.position}`],
      ['p', t(user.is_active ? 'accountActive' : 'accountBlocked')],
      ['p', t(user.must_change_password ? 'passwordPending' : 'passwordUpdated')],
    ]) { const element = document.createElement(tag); element.textContent = text; row.append(element); }
    const button = document.createElement('button');
    button.type = 'button'; button.className = 'secondary-button';
    button.textContent = t(user.is_active ? 'blockEmployee' : 'activateEmployee');
    button.disabled = changingUser !== null || loading || pending || resetting;
    button.addEventListener('click', () => toggleUser(user));
    if (user.role === 'employee') {
      const reset = document.createElement('button');
      reset.type = 'button'; reset.className = 'secondary-button';
      reset.textContent = t('resetPassword');
      reset.disabled = button.disabled || !$('user-created').hidden;
      reset.addEventListener('click', () => confirmReset(user));
      row.append(reset);
    }
    row.append(button); $('users-list').append(row);
  }
  $('users-pagination').hidden = !result || result.pagination.total <= result.pagination.limit;
  $('users-page').textContent = result ? `${t('page')} ${result.pagination.page}` : '';
  $('users-previous').disabled = loading || changingUser !== null || page <= 1;
  $('users-next').disabled = loading || changingUser !== null || !result || page * result.pagination.limit >= result.pagination.total;
  $('retry-users').hidden = !notices['users-status']?.key || loading || Boolean(result);
}

async function loadUsers() {
  const generation = version;
  const id = ++readId;
  loading = true; result = null;
  notice('users-status', 'loadingEmployees'); renderAccounts();
  try {
    const response = await getUsers(page);
    if (generation !== version || id !== readId) return;
    result = response;
    notice('users-status', result.data.length ? '' : 'noEmployees');
  } catch (error) {
    if (generation !== version || id !== readId) return;
    notice('users-status', errorNotice(error));
  } finally {
    if (generation === version && id === readId) { loading = false; renderAccounts(); }
  }
}

export function closeAccounts() {
  clearReset(); resetting = false;
  version++; readId++; active = ''; onChanged = null; page = 1; result = null;
  pending = false; loading = false; changingUser = null; errors = {}; notices = {};
  $('change-password-form').reset(); $('create-user-form').reset(); clearSecret(); renderAccounts();
}

export function openAccounts(screen, callback) {
  if (active === screen) return;
  closeAccounts(); active = screen; onChanged = callback;
  if (screen === 'users') loadUsers();
}

function invalid() {
  renderAccounts();
  const id = Object.keys(errors)[0];
  if (id) $(id).focus();
  return Boolean(id);
}

$('change-password-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (pending || active !== 'password') return;
  errors = validatePassword($('current-password').value, $('new-password').value, $('repeat-password').value);
  notice('change-password-status');
  if (invalid()) return;
  const generation = version;
  pending = true; notice('change-password-status', 'savingAccount'); renderAccounts();
  try {
    const response = await changePassword({ current_password: $('current-password').value, new_password: $('new-password').value });
    if (generation !== version) return;
    const callback = onChanged;
    closeAccounts(); callback(response);
  } catch (error) {
    if (generation !== version) return;
    notice('change-password-status', uncertain(error) ? 'passwordChangeUncertain' : errorNotice(error));
  } finally {
    if (generation === version) { pending = false; renderAccounts(); }
  }
});

$('create-user-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (pending || resetting || active !== 'users' || !$('user-created').hidden) return;
  const values = Object.fromEntries(['phone', 'full_name', 'department', 'position'].map(key => [key, $(`user-${key}`).value]));
  errors = validateEmployee(values); notice('create-user-status');
  if (invalid()) return;
  const generation = version;
  pending = true; notice('create-user-status', 'savingAccount'); renderAccounts();
  try {
    const response = await createUser(values);
    if (generation !== version) return;
    $('create-user-form').reset(); notice('create-user-status');
    $('temporary-password').textContent = response.data.temporary_password;
    $('created-user-phone').textContent = response.data.user.phone;
    $('user-created').hidden = false;
    $('close-user-created').focus();
    page = 1; loadUsers();
  } catch (error) {
    if (generation !== version) return;
    if (error.message === 'PHONE_EXISTS') errors['user-phone'] = 'phoneExists';
    notice('create-user-status', uncertain(error) ? 'createEmployeeUncertain' : errorNotice(error));
    if (uncertain(error)) { page = 1; await loadUsers(); }
  } finally {
    if (generation === version) { pending = false; renderAccounts(); }
  }
});

async function toggleUser(user) {
  if (active !== 'users' || pending || resetting || changingUser !== null || loading) return;
  const generation = version;
  changingUser = user.id; notice('users-action-status', 'savingAccount'); renderAccounts();
  try {
    const response = await updateUser(user.id, !user.is_active);
    if (generation !== version) return;
    if (result) result.data = result.data.map(item => item.id === user.id ? response.data.user : item);
    notice('users-action-status', 'accountSaved');
  } catch (error) {
    if (generation !== version) return;
    notice('users-action-status', uncertain(error) ? 'accountUpdateUncertain' : errorNotice(error));
    if (uncertain(error) || error.message === 'NOT_FOUND') await loadUsers();
  } finally {
    if (generation === version) { changingUser = null; renderAccounts(); }
  }
}

$('close-user-created').addEventListener('click', () => { clearSecret(); renderAccounts(); $('user-full_name').focus(); });
$('retry-users').addEventListener('click', () => { if (!loading && active === 'users') loadUsers(); });
$('users-previous').addEventListener('click', () => { if (!loading && changingUser === null && page > 1) { page--; loadUsers(); } });
$('users-next').addEventListener('click', () => { if (!loading && changingUser === null && result && page * result.pagination.limit < result.pagination.total) { page++; loadUsers(); } });

$('close-reset-password').addEventListener('click', () => { if (!resetting) { clearReset(); renderAccounts(); } });
resetDialog.addEventListener('cancel', event => { if (resetting) event.preventDefault(); });
resetDialog.addEventListener('close', () => {
  // Native Escape and route changes must erase the secret, including hidden DOM.
  if (resetDialog.open) return;
  resetVersion++; resetTarget = null;
  $('reset-temporary-password').textContent = '';
  $('reset-password-person').textContent = '';
  $('reset-copy-status').textContent = '';
  notice('reset-copy-status');
  $('reset-password-result').hidden = true;
});

$('confirm-reset-password').addEventListener('click', async () => {
  if (active !== 'users' || !resetTarget || resetting || !resetDialog.open || !$('reset-password-result').hidden) return;
  const generation = version;
  const operation = resetVersion;
  const id = resetTarget.id;
  resetting = true; notice('users-action-status'); renderAccounts();
  try {
    const response = await resetUserPassword(id);
    if (generation !== version || operation !== resetVersion) return;
    if (result) result.data = result.data.map(user => user.id === id ? response.data.user : user);
    resetTarget = response.data.user;
    $('reset-password-person').textContent = response.data.user.phone;
    $('reset-temporary-password').textContent = response.data.temporary_password;
    $('reset-password-blocked').hidden = response.data.user.is_active;
    $('reset-password-warning').hidden = true;
    $('reset-password-result').hidden = false;
    $('confirm-reset-password').hidden = true;
    $('copy-reset-password').focus();
  } catch (error) {
    if (generation !== version || operation !== resetVersion) return;
    clearReset();
    const key = ({ PASSWORD_CHANGED: 'resetPasswordConflict', INTERNAL_ERROR: 'resetPasswordFailed',
      VALIDATION_ERROR: 'resetRequestInvalid', UNSUPPORTED_MEDIA_TYPE: 'resetRequestInvalid',
    })[error.message];
    notice('users-action-status', key || (uncertain(error) ? 'resetPasswordUncertain' : errorNotice(error)));
    if (['NOT_FOUND', 'PASSWORD_CHANGED'].includes(error.message) || uncertain(error)) await loadUsers();
    if (error.message === 'FORBIDDEN') globalThis.window?.dispatchEvent(new Event('session-refresh-requested'));
  } finally {
    if (generation === version) { resetting = false; renderAccounts(); }
  }
});

$('copy-reset-password').addEventListener('click', async () => {
  if (!resetDialog.open || $('reset-password-result').hidden) return;
  const operation = resetVersion;
  try {
    if (!navigator.clipboard?.writeText) throw new Error('CLIPBOARD_UNAVAILABLE');
    await navigator.clipboard.writeText($('reset-temporary-password').textContent);
    if (operation === resetVersion) notice('reset-copy-status', 'passwordCopied');
  } catch {
    if (operation === resetVersion) notice('reset-copy-status', 'passwordCopyFailed');
  }
  if (operation === resetVersion) renderAccounts();
});
