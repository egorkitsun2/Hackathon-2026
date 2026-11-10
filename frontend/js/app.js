import { login, normalizePhone } from './api.js';
import { setLanguage, t } from './i18n.js';

const form = document.querySelector('#login-form');
const phone = document.querySelector('#phone');
const password = document.querySelector('#password');
const toggle = document.querySelector('#toggle-password');
const submit = document.querySelector('#submit-login');
const status = document.querySelector('#login-status');
const errors = { phone: '', password: '' };
let submitting = false;

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
    status.dataset.i18n = 'backendUnavailable';
    status.textContent = t('backendUnavailable');
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
    status.dataset.i18n = 'backendUnavailable';
    status.textContent = t('backendUnavailable');
    invalid.focus();
    return;
  }
  submitting = true;
  submit.disabled = true;
  submit.dataset.i18n = 'signingIn';
  submit.textContent = t('signingIn');
  form.setAttribute('aria-busy', 'true');
  try {
    await login({ phone: normalizePhone(phone.value), password: password.value });
  } catch (error) {
    status.dataset.i18n = error.message === 'BACKEND_NOT_CONNECTED' ? 'loginUnavailable' : 'backendUnavailable';
    status.textContent = t(status.dataset.i18n);
  } finally {
    submitting = false;
    submit.disabled = false;
    submit.dataset.i18n = 'signIn';
    submit.textContent = t('signIn');
    form.removeAttribute('aria-busy');
  }
});

// Only the login screen exists at this stage; other SPA routes come later.
function route() {
  if (location.hash !== '#/login') {
    history.replaceState(null, '', `${location.pathname}${location.search}#/login`);
  }
}
window.addEventListener('hashchange', route);
route();
setLanguage('ru');
renderPasswordToggle();
