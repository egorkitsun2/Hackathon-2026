import { createTicket, uploadAttachment, getTicket } from './api.js?v=saved-previews-20261112-1';
import { validateAttachment } from './attachment-validation.js?v=saved-previews-20261112-1';
import { t } from './i18n.js?v=saved-previews-20261112-1';

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
let attachments = [];
let previewOpen = false;
let previewRevision = 0;
let renderedPreviewKey = '';
const previewList = document.querySelector('#ticket-previews');
let writingHelpKey = '';
const writingPrompts = {
  problem: ['helpWhatHappened', 'helpWhereWhen', 'helpWorkImpact', 'helpSolution'],
  suggestion: ['helpSuggestionChange', 'helpSuggestionBenefit', 'helpSuggestionResult'],
  complaint: ['helpComplaintAbout', 'helpComplaintWhereWhen', 'helpComplaintImpact', 'helpComplaintOutcome'],
  gratitude: ['helpGratitudeWho', 'helpGratitudeAction', 'helpGratitudeImpact'],
};

function renderWritingHelp() {
  const key = `${inputs.type.value}:${t('writingHelpTitle')}`;
  if (key === writingHelpKey) return;
  writingHelpKey = key;
  const prompts = writingPrompts[inputs.type.value] ?? [];
  const list = document.querySelector('#ticket-help-prompts');
  list.replaceChildren();
  for (const prompt of prompts) {
    const item = document.createElement('li'); item.textContent = t(prompt); list.append(item);
  }
  list.hidden = !prompts.length;
  document.querySelector('#ticket-help-choose').hidden = Boolean(prompts.length);
}

function releasePreviewURLs() {
  for (const entry of attachments) {
    if (entry.url) URL.revokeObjectURL(entry.url);
    entry.url = null;
  }
}

function clearAttachments() {
  releasePreviewURLs(); attachments = []; previewRevision++;
  filesInput.value = '';
}

function previewText(tag, text, className = '') {
  const element = document.createElement(tag);
  element.textContent = text; element.className = className;
  return element;
}

function renderPreviews() {
  const key = `${previewRevision}:${t('removeSelectedFile')}:${pending}:${Boolean(created)}:${previewOpen}`;
  if (key === renderedPreviewKey) return;
  renderedPreviewKey = key;
  previewList.replaceChildren();
  previewList.hidden = !previewOpen || Boolean(created) || !attachments.length;
  document.querySelector('#clear-ticket-files').disabled = pending || Boolean(created) || !attachments.length;
  if (!previewOpen || created) { releasePreviewURLs(); return; }
  for (const entry of attachments) {
    const { file } = entry;
    const card = document.createElement('li'); card.className = 'attachment-preview';
    if (/\.(jpe?g|png|webp)$/i.test(file.name) && !entry.failed) {
      try { entry.url ??= URL.createObjectURL(file); } catch { entry.failed = true; }
      if (entry.url) {
        const image = document.createElement('img');
        const source = entry.url;
        image.className = 'attachment-thumbnail'; image.alt = ''; image.src = source;
        image.addEventListener('error', () => {
          if (!attachments.includes(entry) || entry.url !== source) return;
          URL.revokeObjectURL(entry.url); entry.url = null; entry.failed = true;
          previewRevision++; renderPreviews();
        });
        card.append(image);
      }
    }
    if (/\.pdf$/i.test(file.name)) {
      const icon = previewText('span', 'PDF', 'attachment-pdf');
      icon.setAttribute('aria-hidden', 'true'); card.append(icon);
    } else if (entry.failed) card.append(previewText('p', t('attachmentPreviewUnavailable'), 'hint'));
    const info = document.createElement('div'); info.className = 'attachment-preview-info';
    info.append(previewText('p', file.name), previewText('p', `${file.size} ${t('attachmentBytes')}`, 'hint'));
    const remove = previewText('button', t('removeSelectedFile'), 'secondary-button');
    remove.type = 'button'; remove.disabled = pending;
    remove.setAttribute('aria-label', `${t('removeSelectedFile')}: ${file.name}`);
    remove.addEventListener('click', () => {
      if (pending || created) return;
      if (entry.url) URL.revokeObjectURL(entry.url);
      attachments = attachments.filter(item => item !== entry);
      previewRevision++; filesError = ''; renderNewTicket(); document.querySelector('#choose-ticket-files').focus();
    });
    card.append(info, remove); previewList.append(card);
  }
}

export const ticketTextLength = value => Array.from(value.trim()).length;

export function validateTicket(values) {
  const errors = {};
  if (!['problem', 'suggestion', 'complaint', 'gratitude'].includes(values.type)) errors.type = 'typeRequired';
  for (const [name, min, max] of [['title', 5, 120], ['description', 10, 4000]]) {
    const length = ticketTextLength(values[name]);
    if (length < min || length > max) errors[name] = name === 'title' ? 'titleLengthError' : 'descriptionLengthError';
  }
  return errors;
}

export function renderNewTicket() {
  renderWritingHelp();
  renderPreviews();
  for (const [name, maximum] of [['title', 120], ['description', 4000]]) {
    const length = ticketTextLength(inputs[name].value);
    const counter = document.querySelector(`#ticket-${name}-counter`);
    counter.textContent = `${length} / ${maximum}`;
    counter.dataset.exceeded = String(length > maximum);
    counter.setAttribute('aria-label', `${t('characterCount')}: ${length} / ${maximum}${length > maximum ? `. ${t('characterLimitExceeded')}` : ''}`);
  }
  document.querySelector('#ticket-files-error').textContent = filesError ? t(filesError) : '';
  document.querySelector('#ticket-files-error').hidden = !filesError;
  filesInput.setAttribute('aria-invalid', String(Boolean(filesError)));
  document.querySelector('#choose-ticket-files').setAttribute('aria-invalid', String(Boolean(filesError)));
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
  status.dataset.tone = ['newTicketFilesPartial', 'submissionUncertain'].includes(statusKey) ? 'warning' : created && !pending ? 'success' : statusKey && !pending ? 'error' : 'info';
  if (created && selectedCount) status.textContent += ` ${t(statusKey)} ${t('filesUploadedCount')}: ${uploaded}/${selectedCount}.`;
  if (created && !selectedCount) status.textContent += ` ${t('noFilesSelected')}`;
  if (uploadErrorKey) status.textContent += ` ${t(uploadErrorKey)}`;
  if (uploadDiagnostic) status.textContent += ` ${t('attachmentErrorCode')}: ${uploadDiagnostic}.`;
}

export function resetNewTicket() {
  document.querySelector('#ticket-writing-help').open = false;
  clearAttachments();
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
  previewOpen = true;
  if (created && !pending) resetNewTicket();
  renderNewTicket();
}

export function closeNewTicket() {
  previewOpen = false;
  releasePreviewURLs(); renderedPreviewKey = '';
  previewList.replaceChildren(); previewList.hidden = true;
}

for (const [name, input] of Object.entries(inputs)) {
  const onInput = () => {
    delete errors[name];
    // Keep an uncertain submission warning visible until the user checks the list.
    if (statusKey !== 'submissionUncertain') statusKey = '';
    renderNewTicket();
  };
  input.addEventListener('input', onInput);
  if (name === 'type') input.addEventListener('change', onInput);
}

form.addEventListener('submit', async event => {
  event.preventDefault();
  if (pending || created) return;
  const values = Object.fromEntries(Object.entries(inputs).map(([name, input]) => [name, input.value]));
  errors = validateTicket(values);
  const files = attachments.map(entry => entry.file);
  filesError = filesError || (files.length > 3 ? 'newTicketFilesLimit' : files.map(validateAttachment).find(Boolean) || '');
  statusKey = '';
  renderNewTicket();
  const firstInvalid = Object.keys(inputs).find(name => errors[name]);
  if (firstInvalid) { inputs[firstInvalid].focus(); return; }
  if (filesError) { document.querySelector('#choose-ticket-files').focus(); return; }
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
    clearAttachments();
    form.reset();
    filesInput.value = '';
  } catch (error) {
    if (version !== currentVersion) return;
    if (created) {
      clearAttachments();
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

filesInput.addEventListener('change', () => {
  if (pending || created) return;
  const files = Array.from(filesInput.files ?? []);
  filesInput.value = '';
  if (!files.length) return;
  filesError = attachments.length + files.length > 3 ? 'newTicketFilesLimit' : files.map(validateAttachment).find(Boolean) || '';
  if (!filesError) {
    attachments.push(...files.map(file => ({ file, url: null, failed: false })));
    previewRevision++;
  }
  renderNewTicket();
});
document.querySelector('#choose-ticket-files').addEventListener('click', () => filesInput.click());
document.querySelector('#clear-ticket-files').addEventListener('click', () => {
  if (pending) return;
  clearAttachments(); filesError = ''; renderNewTicket();
});
