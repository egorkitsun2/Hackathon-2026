import { createTicket } from './api.js';
import { t } from './i18n.js';

const form = document.querySelector('#new-ticket-form');
const fields = document.querySelector('#ticket-fields');
const submit = document.querySelector('#send-ticket');
const status = document.querySelector('#create-ticket-status');
const listLink = document.querySelector('#created-ticket-list');
const detailsLink = document.querySelector('#created-ticket-details');
const inputs = Object.fromEntries(['type', 'title', 'description'].map(name => [name, document.querySelector(`#ticket-${name}`)]));
let errors = {};
let pending = false;
let created = null;
let statusKey = '';
let version = 0;

export function validateTicket(values) {
  const errors = {};
  if (!['problem', 'suggestion', 'complaint', 'gratitude'].includes(values.type)) errors.type = 'typeRequired';
  for (const [name, min, max] of [['title', 5, 120], ['description', 10, 4000]]) {
    const length = Array.from(values[name].trim()).length;
    if (length < min || length > max) errors[name] = name === 'title' ? 'titleLengthError' : 'descriptionLengthError';
  }
  return errors;
}

export function renderNewTicket() {
  for (const [name, input] of Object.entries(inputs)) {
    const message = document.querySelector(`#ticket-${name}-error`);
    message.textContent = errors[name] ? t(errors[name]) : '';
    message.hidden = !errors[name];
    input.setAttribute('aria-invalid', String(Boolean(errors[name])));
  }
  submit.dataset.i18n = pending ? 'sendingTicket' : 'sendTicket';
  submit.textContent = t(submit.dataset.i18n);
  fields.disabled = pending || Boolean(created);
  form.hidden = Boolean(created);
  listLink.hidden = !created;
  detailsLink.hidden = !created;
  if (created) detailsLink.href = `#/tickets/${created.id}`;
  status.textContent = created ? `${t('ticketCreated')} № ${created.id}.` : statusKey ? t(statusKey) : '';
}

export function resetNewTicket() {
  version++;
  form.reset();
  errors = {};
  pending = false;
  created = null;
  statusKey = '';
  form.removeAttribute('aria-busy');
  renderNewTicket();
}

export function openNewTicket() {
  if (created) resetNewTicket();
  renderNewTicket();
}

for (const [name, input] of Object.entries(inputs)) {
  input.addEventListener('input', () => {
    delete errors[name];
    // Keep an uncertain submission warning visible until the user checks the list.
    if (statusKey !== 'submissionUncertain') statusKey = '';
    renderNewTicket();
  });
}

form.addEventListener('submit', async event => {
  event.preventDefault();
  if (pending || created) return;
  const values = Object.fromEntries(Object.entries(inputs).map(([name, input]) => [name, input.value]));
  errors = validateTicket(values);
  statusKey = '';
  renderNewTicket();
  const firstInvalid = Object.keys(inputs).find(name => errors[name]);
  if (firstInvalid) { inputs[firstInvalid].focus(); return; }
  pending = true;
  const currentVersion = ++version;
  form.setAttribute('aria-busy', 'true');
  renderNewTicket();
  try {
    const response = await createTicket(values);
    if (version !== currentVersion) return;
    created = response.data;
    form.reset();
  } catch (error) {
    if (version !== currentVersion) return;
    if (error.message === 'VALIDATION_ERROR') {
      for (const name of Object.keys(inputs)) {
        if (error.details?.[name]) errors[name] = ({ type: 'typeRequired', title: 'titleLengthError', description: 'descriptionLengthError' })[name];
      }
      statusKey = 'ticketValidationError';
    } else {
      statusKey = ({ UNAUTHORIZED: 'sessionExpired', ACCOUNT_DISABLED: 'accountDisabled',
        FORBIDDEN: 'ticketForbidden', INVALID_ORIGIN: 'invalidOrigin', RATE_LIMITED: 'rateLimited',
        SERVICE_UNAVAILABLE: 'serviceUnavailable' })[error.message] ?? 'submissionUncertain';
    }
  } finally {
    if (version === currentVersion) {
      pending = false;
      form.removeAttribute('aria-busy');
      renderNewTicket();
      const firstInvalid = Object.keys(inputs).find(name => errors[name]);
      if (firstInvalid) inputs[firstInvalid].focus();
    }
  }
});
