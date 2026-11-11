import { validateAttachment } from './attachment-validation.js?v=saas-redesign-20261111-1';
import { getTicket, updateTicketStatus, uploadAttachment } from './api.js?v=saas-redesign-20261111-1';
import { t } from './i18n.js?v=saas-redesign-20261111-1';

const screen = document.querySelector('#ticket-detail-screen');
const content = document.querySelector('#ticket-detail-content');
const statusPanel = document.querySelector('#ticket-detail-state');
const status = document.querySelector('#ticket-detail-status');
const retry = document.querySelector('#retry-ticket-detail');
const historyList = document.querySelector('#detail-history');
let ticket = null;
let ticketId = null;
let state = '';
let requestId = 0;
let adminView = false;
const actions = document.querySelector('#admin-ticket-actions');
const takeButton = document.querySelector('#take-ticket');
const decisionForm = document.querySelector('#ticket-decision-form');
const decisionFields = document.querySelector('#ticket-decision-fields');
const decision = document.querySelector('#ticket-decision');
const comment = document.querySelector('#ticket-decision-comment');
const saveButton = document.querySelector('#save-ticket-decision');
const actionStatus = document.querySelector('#admin-action-status');
let saving = false;
let feedback = '';
let decisionError = '';
let commentError = '';
let uploadController = null;
let uploadVersion = 0;
let attachmentFeedback = '';
const fileInput = document.querySelector('#attachment-file');


function renderAttachments() {
  const list = document.querySelector('#attachments-list');
  list.replaceChildren();
  const files = ticket?.attachments ?? [];
  for (const file of files) {
    const item = document.createElement('li');
    item.className = 'ticket';
    const link = textElement('a', t('attachmentDownload'), 'back-link');
    // Build a same-origin protected URL; never use an arbitrary metadata URL.
    if (Number.isSafeInteger(file.id) && file.id > 0) {
      link.href = `/api/v1/tickets/${ticket.id}/attachments/${file.id}`;
      link.download = file.original_name;
    }
    item.append(textElement('p', file.original_name), textElement('p', `${file.mime_type} · ${file.size_bytes} ${t('attachmentBytes')}`, 'hint'), link);
    list.append(item);
  }
  document.querySelector('#attachments-empty').hidden = files.length > 0;
  document.querySelector('#attachment-form').hidden = !ticket || adminView || ticket.status !== 'new' || files.length >= 3;
  fileInput.disabled = Boolean(uploadController);
  document.querySelector('#attachment-upload').disabled = Boolean(uploadController);
  document.querySelector('#attachment-cancel').hidden = !uploadController;
  document.querySelector('#attachment-status').textContent = attachmentFeedback ? t(attachmentFeedback) : '';
}

function renderActions() {
  actionStatus.dataset.tone = feedback === 'decisionSaved' ? 'success' : ['decisionConflict', 'decisionUncertain'].includes(feedback) ? 'warning' : 'error';
  actionStatus.hidden = !adminView || !feedback;
  actionStatus.textContent = feedback ? t(feedback) : '';
  actions.hidden = !adminView || !ticket;
  takeButton.hidden = ticket?.status !== 'new';
  takeButton.disabled = saving;
  takeButton.dataset.i18n = saving ? 'savingDecision' : 'takeTicket';
  takeButton.textContent = t(takeButton.dataset.i18n);
  decisionForm.hidden = ticket?.status !== 'in_review';
  decisionFields.disabled = saving;
  saveButton.dataset.i18n = saving ? 'savingDecision' : 'saveDecision';
  saveButton.textContent = t(saveButton.dataset.i18n);
  document.querySelector('#ticket-closed-note').hidden = !['resolved', 'rejected'].includes(ticket?.status);
  for (const [input, selector, key] of [[decision, '#ticket-decision-error', decisionError], [comment, '#ticket-decision-comment-error', commentError]]) {
    input.setAttribute('aria-invalid', String(Boolean(key)));
    const message = document.querySelector(selector);
    message.textContent = key ? t(key) : '';
    message.hidden = !key;
  }
}

function textElement(tag, text, className) {
  const element = document.createElement(tag);
  element.textContent = text;
  if (className) element.className = className;
  return element;
}

function formatDate(date) {
  return new Intl.DateTimeFormat(document.documentElement.lang === 'kk' ? 'kk-KZ' : 'ru-KZ', {
    dateStyle: 'medium', timeStyle: 'short',
  }).format(new Date(date));
}

export function renderTicketDetails() {
  renderAttachments();
  renderActions();
  statusPanel.hidden = !state;
  status.textContent = state ? t(state) : '';
  retry.hidden = state !== 'ticketLoadError';
  content.hidden = !ticket;
  historyList.replaceChildren();
  if (!ticket) return;
  const authorBlock = document.querySelector('#detail-author-block');
  authorBlock.hidden = !adminView || !ticket.author;
  if (adminView && ticket.author) {
    document.querySelector('#detail-author-name').textContent = ticket.author.full_name;
    document.querySelector('#detail-author-position').textContent = `${ticket.author.department} · ${ticket.author.position}`;
  }
  document.querySelector('#detail-meta').textContent = `${t(ticket.type)} · № ${ticket.id}`;
  document.querySelector('#detail-title').textContent = ticket.title;
  const date = document.querySelector('#detail-date');
  date.textContent = `${t('createdAt')}: ${formatDate(ticket.created_at)}`;
  date.dateTime = ticket.created_at;
  const badge = document.querySelector('#detail-status');
  badge.textContent = t(ticket.status);
  badge.className = `ticket-status status-${ticket.status}`;
  document.querySelector('#detail-description').textContent = ticket.description;
  const events = [...ticket.events].sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id - b.id);
  const decision = ['resolved', 'rejected'].includes(ticket.status)
    ? events.findLast(event => event.new_status === ticket.status)
    : null;
  document.querySelector('#detail-response').textContent = decision?.comment || t('awaitingDecision');
  for (const event of events) {
    const item = document.createElement('li');
    const date = textElement('time', formatDate(event.created_at), 'hint');
    date.dateTime = event.created_at;
    const actor = textElement('p', event.actor.full_name, 'event-actor');
    const transition = event.old_status
      ? `${t(event.old_status)} → ${t(event.new_status)}`
      : `${t('ticketCreatedEvent')}: ${t(event.new_status)}`;
    item.append(date, actor, textElement('p', transition));
    if (event.comment) item.append(textElement('p', event.comment, 'ticket-text'));
    historyList.append(item);
  }
  document.querySelector('#detail-no-history').hidden = events.length > 0;
}

async function loadTicket(message = '') {
  const id = ++requestId;
  ticket = null;
  saving = false;
  feedback = message;
  state = 'loadingTicket';
  screen.setAttribute('aria-busy', 'true');
  renderTicketDetails();
  try {
    const response = await getTicket(ticketId);
    if (id !== requestId) return;
    ticket = response.data;
    state = '';
  } catch (error) {
    if (id !== requestId) return;
    state = error.message === 'NOT_FOUND' ? 'ticketNotFound' : 'ticketLoadError';
  } finally {
    if (id === requestId) {
      screen.removeAttribute('aria-busy');
      renderTicketDetails();
    }
  }
}

export function openTicketDetails(id, admin = false) {
  adminView = admin;
  document.querySelector('#detail-back').href = admin ? '#/admin' : '#/employee';
  ticketId = id;
  loadTicket();
}

export function closeTicketDetails() {
  uploadVersion++;
  uploadController?.abort();
  uploadController = null;
  attachmentFeedback = '';
  fileInput.value = '';
  requestId++;
  ticket = null;
  ticketId = null;
  state = '';
  saving = false;
  feedback = '';
  decisionError = '';
  commentError = '';
  decision.value = '';
  comment.value = '';
  actions.removeAttribute('aria-busy');
  screen.removeAttribute('aria-busy');
  // Clear private text as well as hiding it when leaving a ticket or signing out.
  document.querySelector('#detail-author-block').hidden = true;
  for (const selector of ['#detail-meta', '#detail-title', '#detail-date', '#detail-status', '#detail-description', '#detail-response', '#detail-author-name', '#detail-author-position']) {
    document.querySelector(selector).textContent = '';
  }
  renderTicketDetails();
}

retry.addEventListener('click', () => loadTicket(feedback));

async function saveStatus(nextStatus) {
  if (!adminView || !ticket || saving) return;
  const allowed = ticket.status === 'new' ? nextStatus === 'in_review'
    : ticket.status === 'in_review' && ['resolved', 'rejected'].includes(nextStatus);
  if (!allowed) return;
  const id = requestId;
  saving = true;
  feedback = '';
  actions.setAttribute('aria-busy', 'true');
  renderActions();
  try {
    await updateTicketStatus(ticket.id, { status: nextStatus, comment: comment.value });
    if (id !== requestId) return;
    decision.value = '';
    comment.value = '';
    await loadTicket('decisionSaved');
  } catch (error) {
    if (id !== requestId) return;
    if (error.message === 'INVALID_TRANSITION') await loadTicket('decisionConflict');
    else if (['NETWORK_ERROR', 'API_UNAVAILABLE', 'INTERNAL_ERROR', 'NOT_FOUND'].includes(error.message)) {
      await loadTicket('decisionUncertain');
    } else {
      if (error.message === 'VALIDATION_ERROR' && error.details?.comment) commentError = 'decisionCommentError';
      feedback = ({ VALIDATION_ERROR: 'decisionValidationError', FORBIDDEN: 'adminForbidden',
        UNAUTHORIZED: 'sessionExpired', ACCOUNT_DISABLED: 'accountDisabled', INVALID_ORIGIN: 'invalidOrigin',
        RATE_LIMITED: 'rateLimited', SERVICE_UNAVAILABLE: 'serviceUnavailable' })[error.message] ?? 'decisionSaveError';
    }
  } finally {
    // A refreshed detail or another route owns its own request state.
    if (id === requestId) { saving = false; renderActions(); }
    if (!saving) actions.removeAttribute('aria-busy');
  }
}

takeButton.addEventListener('click', () => saveStatus('in_review'));
decisionForm.addEventListener('submit', async event => {
  event.preventDefault();
  if (!adminView || ticket?.status !== 'in_review' || saving) return;
  decisionError = ['resolved', 'rejected'].includes(decision.value) ? '' : 'decisionRequired';
  const length = Array.from(comment.value.trim()).length;
  commentError = length >= 5 && length <= 2000 ? '' : 'decisionCommentError';
  renderActions();
  if (decisionError || commentError) { (decisionError ? decision : comment).focus(); return; }
  await saveStatus(decision.value);
});
decision.addEventListener('change', () => { decisionError = ''; renderActions(); });
comment.addEventListener('input', () => { commentError = ''; renderActions(); });

document.querySelector('#attachment-cancel').addEventListener('click', () => uploadController?.abort());
document.querySelector('#attachment-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (!ticket || adminView || ticket.status !== 'new' || uploadController || (ticket.attachments?.length ?? 0) >= 3) return;
  const file = fileInput.files?.[0];
  attachmentFeedback = validateAttachment(file);
  if (attachmentFeedback) { renderAttachments(); return; }
  const version = ++uploadVersion;
  uploadController = new AbortController();
  attachmentFeedback = 'attachmentUploading';
  renderAttachments();
  try {
    await uploadAttachment(ticket.id, file, uploadController.signal);
    if (version !== uploadVersion) return;
    attachmentFeedback = 'attachmentSaved';
  } catch (error) {
    if (version !== uploadVersion) return;
    attachmentFeedback = ({ FILE_TOO_LARGE: 'attachmentTooLarge', UPLOAD_TOO_LARGE: 'attachmentTooLarge',
      UNSUPPORTED_FILE_TYPE: 'attachmentUnsupported', UNSUPPORTED_MEDIA_TYPE: 'attachmentInvalid',
      VALIDATION_ERROR: 'attachmentInvalid', ATTACHMENT_LIMIT_REACHED: 'attachmentLimit',
      ATTACHMENTS_LOCKED: 'attachmentLocked', FORBIDDEN: 'attachmentForbidden', NOT_FOUND: 'ticketNotFound',
      INVALID_ORIGIN: 'invalidOrigin', RATE_LIMITED: 'rateLimited',
    })[error.message] ?? 'attachmentUncertain';
  } finally {
    if (version === uploadVersion) {
      uploadController = null;
      fileInput.value = '';
      // Also refresh on cancellation/timeout: the upload may already have committed.
      await loadTicket();
    }
  }
});
