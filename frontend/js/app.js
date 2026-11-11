import { openAccounts, closeAccounts, renderAccounts } from './accounts.js?v=attachments-20261111-3';
import { login, logout, getMe, normalizePhone } from './api.js?v=attachments-20261111-3';
import { setLanguage, t } from './i18n.js?v=attachments-20261111-3';
import { openEmployee, closeEmployee, renderEmployee } from './employee.js?v=attachments-20261111-3';
import { openNewTicket, resetNewTicket, renderNewTicket } from './new-ticket.js?v=attachments-20261111-3';
import { openTicketDetails, closeTicketDetails, renderTicketDetails } from './ticket.js?v=attachments-20261111-3';
import { openAdminQueue, closeAdminQueue, renderAdminQueue } from './admin.js?v=attachments-20261111-3';

const form = document.querySelector('#login-form');
const phone = document.querySelector('#phone');
const password = document.querySelector('#password');
const toggle = document.querySelector('#toggle-password');
const submit = document.querySelector('#submit-login');
const status = document.querySelector('#login-status');
const errors = { phone: '', password: '' };
let submitting = false;
let user = null;
let passwordChangeRequired = false;
let restoringSession = true;
let sessionVersion = 0;
const logoutButton = document.querySelector('#logout');
const sessionStatus = document.querySelector('#session-status');

function showStatus(element, key = '') {
  if (key) element.dataset.i18n = key;
  else delete element.dataset.i18n;
  element.textContent = key ? t(key) : '';
}

function errorKey(error) {
  return ({
    INVALID_CREDENTIALS: 'invalidCredentials', RATE_LIMITED: 'rateLimited',
    ACCOUNT_DISABLED: 'accountDisabled', INVALID_ORIGIN: 'invalidOrigin',
    VALIDATION_ERROR: 'invalidInput', NETWORK_ERROR: 'networkError',
    UNAUTHORIZED: 'sessionExpired', SERVICE_UNAVAILABLE: 'serviceUnavailable',
  })[error.message] ?? 'apiUnavailable';
}

function renderErrors() {
  for (const input of [phone, password]) {
    const key = errors[input.name];
    const message = document.querySelector(`#${input.name}-error`);
    message.textContent = key ? t(key) : '';
    message.hidden = !key;
    input.setAttribute('aria-invalid', String(Boolean(key)));
  }
}

function renderPasswordToggle() {
  toggle.dataset.i18n = password.type === 'password' ? 'showPassword' : 'hidePassword';
  toggle.textContent = t(toggle.dataset.i18n);
  toggle.setAttribute('aria-pressed', String(password.type === 'text'));
}

document.querySelectorAll('[data-language]').forEach((button) => {
  button.addEventListener('click', () => {
    setLanguage(button.dataset.language);
    renderErrors();
    renderEmployee();
    renderNewTicket();
    renderTicketDetails();
    renderAdminQueue();
    renderAccounts();
  });
});

toggle.addEventListener('click', () => {
  password.type = password.type === 'password' ? 'text' : 'password';
  renderPasswordToggle();
});

for (const input of [phone, password]) {
  input.addEventListener('input', () => {
    errors[input.name] = '';
    renderErrors();
    showStatus(status);
  });
}

// Format only a complete valid number on blur, preserving editing and pasted digits.
phone.addEventListener('blur', () => {
  const normalized = normalizePhone(phone.value);
  if (normalized) {
    phone.value = normalized.replace(/^(\+7)(\d{3})(\d{3})(\d{2})(\d{2})$/, '$1 ($2) $3-$4-$5');
  }
});

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (submitting) return;
  errors.phone = !phone.value.trim() ? 'phoneRequired' : normalizePhone(phone.value) ? '' : 'phoneInvalid';
  errors.password = password.value.length ? '' : 'passwordRequired';
  renderErrors();
  const invalid = [phone, password].find((input) => errors[input.name]);
  if (invalid) {
    showStatus(status);
    invalid.focus();
    return;
  }
  submitting = true;
  submit.disabled = true;
  submit.dataset.i18n = 'signingIn';
  submit.textContent = t('signingIn');
  form.setAttribute('aria-busy', 'true');
  showStatus(status);
  showStatus(sessionStatus);
  const version = ++sessionVersion;
  try {
    const response = await login({ phone: normalizePhone(phone.value), password: password.value });
    if (version !== sessionVersion) return;
    user = response.data.user;
    passwordChangeRequired = response.meta?.passwordChangeRequired === true;
    password.value = '';
    password.type = 'password';
    renderPasswordToggle();
    history.replaceState(null, '', user.role === 'admin' ? '#/admin' : '#/employee');
    route();
  } catch (error) {
    showStatus(status, errorKey(error));
  } finally {
    submitting = false;
    submit.disabled = false;
    submit.dataset.i18n = 'signIn';
    submit.textContent = t('signIn');
    form.removeAttribute('aria-busy');
  }
});

function route() {
  const changing = Boolean(user && passwordChangeRequired);
  const employee = !changing && user?.role === 'employee';
  const admin = !changing && user?.role === 'admin';
  const managing = admin && location.hash === '#/admin/users';
  const creating = employee && location.hash === '#/new-ticket';
  const detailMatch = employee ? location.hash.match(/^#\/tickets\/(\d+)$/) : admin ? location.hash.match(/^#\/admin\/tickets\/(\d+)$/) : null;
  const viewing = Boolean(detailMatch);
  const target = changing ? '#/change-password' : managing ? '#/admin/users' : employee ? (creating ? '#/new-ticket' : viewing ? location.hash : '#/employee') : admin ? (viewing ? location.hash : '#/admin') : '#/login';
  if (!restoringSession && location.hash !== target) history.replaceState(null, '', target);
  document.querySelector('#login-screen').hidden = Boolean(user);
  document.querySelector('#change-password-screen').hidden = !changing;
  document.querySelector('#users-screen').hidden = !managing;
  document.querySelector('#employee-screen').hidden = !employee || creating || viewing;
  document.querySelector('#new-ticket-screen').hidden = !creating;
  document.querySelector('#ticket-detail-screen').hidden = !viewing;
  document.querySelector('#admin-screen').hidden = !admin || viewing || managing;
  document.body.classList.toggle('employee-screen', employee || viewing);
  document.body.classList.toggle('admin-screen', admin && !viewing);
  logoutButton.hidden = !user;
  closeEmployee();
  closeTicketDetails();
  closeAdminQueue(!admin);
  if (changing || managing) {
    resetNewTicket();
    openAccounts(changing ? 'password' : 'users', response => {
      user = response.data.user;
      passwordChangeRequired = response.meta?.passwordChangeRequired === true;
      route();
    });
    return;
  }
  closeAccounts();
  if (creating) openNewTicket();
  else if (viewing) openTicketDetails(detailMatch[1], admin);
  else if (employee) openEmployee(user);
  else if (admin) openAdminQueue(user);
}

window.addEventListener('password-change-required', () => {
  if (!user) return;
  passwordChangeRequired = true;
  route();
});

window.addEventListener('session-ended', (event) => {
  sessionVersion++;
  user = null;
  resetNewTicket();
  route();
  showStatus(status, event?.code === 'ACCOUNT_DISABLED' ? 'accountDisabled' : 'sessionExpired');
});

logoutButton.addEventListener('click', async () => {
  closeAccounts();
  logoutButton.disabled = true;
  showStatus(sessionStatus);
  try {
    await logout();
    sessionVersion++;
    user = null;
    resetNewTicket();
    route();
    showStatus(status);
  } catch (error) {
    route();
    showStatus(sessionStatus, errorKey(error));
  } finally { logoutButton.disabled = false; }
});

async function restoreSession() {
  const version = sessionVersion;
  submit.disabled = true;
  showStatus(status, 'checkingSession');
  try {
    const response = await getMe();
    if (version !== sessionVersion) return;
    user = response.data.user;
    passwordChangeRequired = response.meta?.passwordChangeRequired === true;
    showStatus(status);
  } catch (error) {
    if (error.message === 'UNAUTHORIZED') showStatus(status);
    else showStatus(status, errorKey(error));
  } finally {
    restoringSession = false;
    submit.disabled = false;
    route();
  }
}
window.addEventListener('hashchange', route);
setLanguage('ru');
renderPasswordToggle();
route();
restoreSession();
