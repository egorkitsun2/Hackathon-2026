import { createTicket, uploadAttachment, getTicket } from './api.js?v=password-reset-20261111-1';
import { validateAttachment } from './attachment-validation.js?v=password-reset-20261111-1';
import { t } from './i18n.js?v=password-reset-20261111-1';

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
const filesInput = document.querySelector('#ticket-files');
let filesError = '';
let uploadController = null;
let uploaded = 0;
let selectedCount = 0;
let uploadErrorKey = '';
let uploadDiagnostic = '';

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
  document.querySelector('#ticket-files-error').textContent = filesError ? t(filesError) : '';
  document.querySelector('#ticket-files-error').hidden = !filesError;
  filesInput.setAttribute('aria-invalid', String(Boolean(filesError)));
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
  listLink.hidden = !created || pending;
  detailsLink.hidden = !created || pending;
  if (created) detailsLink.href = `#/tickets/${created.id}`;
  status.textContent = created ? `${t('ticketCreated')} № ${created.id}.` : statusKey ? t(statusKey) : '';
  if (created && selectedCount) status.textContent += ` ${t(statusKey)} ${t('filesUploadedCount')}: ${uploaded}/${selectedCount}.`;
  if (created && !selectedCount) status.textContent += ` ${t('noFilesSelected')}`;
  if (uploadErrorKey) status.textContent += ` ${t(uploadErrorKey)}`;
  if (uploadDiagnostic) status.textContent += ` ${t('attachmentErrorCode')}: ${uploadDiagnostic}.`;
}

export function resetNewTicket() {
  version++;
  uploadController?.abort();
  uploadController = null;
  filesInput.value = '';
  filesError = '';
  uploaded = 0;
  selectedCount = 0;
  uploadErrorKey = '';
  uploadDiagnostic = '';
  form.reset();
  errors = {};
  pending = false;
  created = null;
  statusKey = '';
  form.removeAttribute('aria-busy');
  renderNewTicket();
}

export function openNewTicket() {
  if (created && !pending) resetNewTicket();
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
  const files = Array.from(filesInput.files ?? []);
  filesError = files.length > 3 ? 'newTicketFilesLimit' : files.map(validateAttachment).find(Boolean) || '';
  statusKey = '';
  renderNewTicket();
  const firstInvalid = Object.keys(inputs).find(name => errors[name]);
  if (firstInvalid) { inputs[firstInvalid].focus(); return; }
  if (filesError) { filesInput.focus(); return; }
  selectedCount = files.length;
  uploaded = 0;
  pending = true;
  const currentVersion = ++version;
  form.setAttribute('aria-busy', 'true');
  renderNewTicket();
  try {
    const response = await createTicket(values);
    if (version !== currentVersion) return;
    created = response.data;
    statusKey = 'newTicketFilesUploading';
    renderNewTicket();
    for (const file of files) {
      uploadController = new AbortController();
      await uploadAttachment(created.id, file, uploadController.signal);
      if (version !== currentVersion) return;
      uploaded++;
      await getTicket(created.id);
      if (version !== currentVersion) return;
      renderNewTicket();
    }
    statusKey = 'newTicketFilesSaved';
    form.reset();
    filesInput.value = '';
  } catch (error) {
    if (version !== currentVersion) return;
    if (created) {
      statusKey = 'newTicketFilesPartial';
      // Report only machine codes, never raw exception/server text or file paths.
      const code = /^[A-Z][A-Z_]{1,63}$/.test(error.message) ? error.message : 'CLIENT_ERROR';
      uploadDiagnostic = code + (Number.isInteger(error.status) ? ` (HTTP ${error.status})` : '');
      uploadErrorKey = ({
        UNSUPPORTED_FILE_TYPE: 'attachmentUnsupported', FILE_TOO_LARGE: 'attachmentTooLarge', UPLOAD_TOO_LARGE: 'attachmentTooLarge',
        VALIDATION_ERROR: 'attachmentInvalid', UNSUPPORTED_MEDIA_TYPE: 'attachmentInvalid', ATTACHMENTS_LOCKED: 'attachmentLocked',
        ATTACHMENT_LIMIT_REACHED: 'attachmentLimit', FORBIDDEN: 'attachmentForbidden', NOT_FOUND: 'attachmentEndpointMissing',
        NETWORK_ERROR: 'networkError', API_UNAVAILABLE: 'apiUnavailable', UPLOAD_TIMEOUT: 'attachmentTimeout',
        SERVICE_UNAVAILABLE: 'serviceUnavailable', RATE_LIMITED: 'rateLimited', INVALID_ORIGIN: 'invalidOrigin',
      })[error.message] ?? 'attachmentUncertain';
      filesInput.value = '';
      try {
        const response = await getTicket(created.id);
        if (version !== currentVersion) return;
        uploaded = response.data.attachments?.length ?? uploaded;
      } catch { /* The detail link offers a manual refresh; never replay the POST. */ }
    } else if (error.message === 'VALIDATION_ERROR') {
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
      uploadController = null;
      pending = false;
      form.removeAttribute('aria-busy');
      renderNewTicket();
      const firstInvalid = Object.keys(inputs).find(name => errors[name]);
      if (firstInvalid) inputs[firstInvalid].focus();
    }
  }
});

filesInput.addEventListener('change', () => { filesError = ''; renderNewTicket(); });
document.querySelector('#clear-ticket-files').addEventListener('click', () => {
  if (pending) return;
  filesInput.value = ''; filesError = ''; renderNewTicket();
});
