import { validateAttachment } from './attachment-validation.js?v=routing-v05-20261112-1';
import { getTicket, updateTicketStatus, uploadAttachment, getAttachmentPreview, assignTicket, getManagers } from './api.js?v=routing-v05-20261112-1';
import { categoryLabel, managerLabel, fillManagerSelect, selectedManager } from './routing.js?v=routing-v05-20261112-1';
import { t } from './i18n.js?v=routing-v05-20261112-1';

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
let ticketReader = getTicket;
let statusWriter = updateTicketStatus;
let reviewRole = 'employee', managers = [], assignmentPending = false, assignmentNotice = '', assignmentError = '';
let assignmentDraft = '';
let directoryVersion = 0, directoryState = '';

async function loadTicketManagers() {
  if (reviewRole !== 'admin') return;
  const version = ++directoryVersion;
  managers = []; directoryState = 'loadingManagers'; renderAssignment();
  try {
    const users = await getManagers();
    if (version !== directoryVersion || reviewRole !== 'admin') return;
    managers = users; directoryState = ''; renderTicketDetails();
  } catch (error) {
    if (version !== directoryVersion || reviewRole !== 'admin') return;
    if (error.message === 'FORBIDDEN') { closeTicketDetails(); state = 'ticketForbidden'; renderTicketDetails(); }
    else { directoryState = 'managersError'; renderAssignment(); }
  }
}

function lostAccess(error) {
  if (reviewRole !== 'manager' || !['NOT_FOUND', 'FORBIDDEN'].includes(error.message)) return false;
  closeTicketDetails();
  globalThis.window?.dispatchEvent(new Event('ticket-access-lost'));
  return true;
}
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
const attachmentPreviews = new Map();

function clearAttachmentPreviews() {
  for (const entry of attachmentPreviews.values()) {
    entry.controller.abort();
    if (entry.url) URL.revokeObjectURL(entry.url);
  }
  attachmentPreviews.clear();
}

function loadAttachmentPreview(file, container) {
  const id = requestId;
  const currentTicket = ticket.id;
  const entry = { controller: new AbortController(), url: null, state: 'loading', container };
  attachmentPreviews.set(file.id, entry);
  getAttachmentPreview(currentTicket, file.id, entry.controller.signal).then(blob => {
    if (id !== requestId || attachmentPreviews.get(file.id) !== entry) return;
    entry.url = URL.createObjectURL(blob); entry.state = 'ready';
    renderSavedImage(file, entry);
  }).catch(error => {
    if (id !== requestId || attachmentPreviews.get(file.id) !== entry) return;
    if (lostAccess(error)) return;
    entry.state = 'error'; renderSavedImage(file, entry);
  });
  return entry;
}

function renderSavedImage(file, entry) {
  const container = entry.container;
  container.replaceChildren();
  if (entry.url) {
    const image = document.createElement('img');
    const source = entry.url;
    image.src = source; image.alt = file.original_name; image.className = 'attachment-image-preview';
    image.addEventListener('error', () => {
      if (attachmentPreviews.get(file.id) !== entry || entry.url !== source) return;
      URL.revokeObjectURL(source); entry.url = null; entry.state = 'error'; renderSavedImage(file, entry);
    });
    container.append(image);
  } else {
    container.append(textElement('p', t(entry.state === 'loading' ? 'attachmentPreviewLoading' : 'attachmentPreviewUnavailable'), 'hint'));
    if (entry.state === 'error') {
      const retryPreview = textElement('button', t('retry'), 'secondary-button'); retryPreview.type = 'button';
      retryPreview.setAttribute('aria-label', `${t('retry')}: ${file.original_name}`);
      retryPreview.addEventListener('click', () => {
        if (!ticket || attachmentPreviews.get(file.id) !== entry) return;
        const next = loadAttachmentPreview(file, container); renderSavedImage(file, next);
      });
      container.append(retryPreview);
    }
  }
}


function renderAttachments() {
  const list = document.querySelector('#attachments-list');
  list.replaceChildren();
  const files = ticket?.attachments ?? [];
  for (const file of files) {
    const item = document.createElement('li');
    item.className = 'ticket saved-attachment';
    const link = textElement('a', t('attachmentDownload'), 'back-link');
    // Build a same-origin protected URL; never use an arbitrary metadata URL.
    if (Number.isSafeInteger(file.id) && file.id > 0) {
      link.href = `/api/v1/tickets/${ticket.id}/attachments/${file.id}`;
      link.download = file.original_name;
    }
    item.append(textElement('p', file.original_name), textElement('p', `${file.mime_type} · ${file.size_bytes} ${t('attachmentBytes')}`, 'hint'), link);
    if (file.mime_type === 'application/pdf') {
      item.dataset.kind = 'pdf';
      const icon = textElement('span', 'PDF', 'attachment-pdf'); icon.setAttribute('aria-hidden', 'true'); item.append(icon);
    } else if (['image/jpeg', 'image/png', 'image/webp'].includes(file.mime_type) && Number.isSafeInteger(file.id) && file.id > 0) {
      const container = document.createElement('div');
      const entry = attachmentPreviews.get(file.id) ?? loadAttachmentPreview(file, container);
      entry.container = container; renderSavedImage(file, entry); item.append(container);
    }
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
  takeButton.disabled = saving || assignmentPending || !statusWriter;
  takeButton.dataset.i18n = saving ? 'savingDecision' : 'takeTicket';
  takeButton.textContent = t(takeButton.dataset.i18n);
  decisionForm.hidden = ticket?.status !== 'in_review';
  decisionFields.disabled = saving || assignmentPending || !statusWriter;
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

function renderAssignment() {
  const panel = document.querySelector('#ticket-assignment-panel');
  panel.hidden = reviewRole !== 'admin' || !ticket;
  const select = document.querySelector('#ticket-assignee');
  if (panel.hidden) select.replaceChildren();
  else fillManagerSelect(select, managers, assignmentDraft);
  document.querySelector('#ticket-assignment-fields').disabled = assignmentPending || saving || Boolean(directoryState);
  document.querySelector('#retry-ticket-managers').hidden = panel.hidden || directoryState !== 'managersError';
  select.setAttribute('aria-invalid', String(Boolean(assignmentError)));
  document.querySelector('#ticket-assignee-error').textContent = assignmentError ? t(assignmentError) : '';
  document.querySelector('#ticket-assignee-error').hidden = !assignmentError;
  const message = document.querySelector('#ticket-assignment-status');
  message.textContent = directoryState ? t(directoryState) : assignmentNotice ? t(assignmentNotice) : '';
  message.dataset.tone = directoryState ? (directoryState === 'managersError' ? 'error' : 'info') : assignmentNotice === 'assignmentSaved' ? 'success' : assignmentNotice === 'assignmentUncertain' ? 'warning' : 'error';
}

document.querySelector('#ticket-assignee').addEventListener('change', event => {
  assignmentDraft = event.target.value; assignmentError = ''; assignmentNotice = ''; renderAssignment();
});
document.querySelector('#ticket-assignment-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (reviewRole !== 'admin' || !ticket || assignmentPending || saving || directoryState) return;
  let target;
  try { target = selectedManager(assignmentDraft, managers); }
  catch { assignmentError = 'managerRequired'; renderAssignment(); document.querySelector('#ticket-assignee').focus(); return; }
  const version = requestId;
  assignmentPending = true; assignmentNotice = ''; assignmentError = ''; renderAssignment(); renderActions();
  try {
    await assignTicket(ticket.id, target);
    if (version !== requestId) return;
    assignmentPending = false; assignmentNotice = 'assignmentSaved'; await loadTicket();
  } catch (error) {
    if (version !== requestId) return;
    assignmentPending = false;
    if (error.message === 'VALIDATION_ERROR') { assignmentError = 'managerRequired'; renderAssignment(); }
    else if (error.message === 'FORBIDDEN') { ticket = null; state = 'ticketForbidden'; renderTicketDetails(); }
    else if (error.message === 'NOT_FOUND') { ticket = null; state = 'ticketNotFound'; renderTicketDetails(); }
    else {
      assignmentNotice = error.status === 409 ? 'assignmentConflict' : ['NETWORK_ERROR', 'API_UNAVAILABLE', 'INTERNAL_ERROR'].includes(error.message) ? 'assignmentUncertain' : 'assignmentError';
      await loadTicket();
    }
  } finally { if (version === requestId) { assignmentPending = false; renderAssignment(); renderActions(); } }
});
document.querySelector('#retry-ticket-managers').addEventListener('click', () => { if (!assignmentPending && !saving) loadTicketManagers(); });

function formatDate(date) {
  return new Intl.DateTimeFormat(document.documentElement.lang === 'kk' ? 'kk-KZ' : 'ru-KZ', {
    dateStyle: 'medium', timeStyle: 'short',
  }).format(new Date(date));
}

export function renderTicketDetails() {
  renderAttachments();
  renderActions();
  renderAssignment();
  statusPanel.hidden = !state;
  status.textContent = state ? t(state) : '';
  retry.hidden = state !== 'ticketLoadError';
  content.hidden = !ticket;
  historyList.replaceChildren();
  if (!ticket) return;
  document.querySelector('#detail-routing').hidden = !ticket.category;
  document.querySelector('#detail-category').textContent = ticket.category ? categoryLabel(ticket.category) : '';
  document.querySelector('#detail-assignee').textContent = reviewRole === 'admin' ? managerLabel(ticket.assigned_to, managers) : t(ticket.assigned_to == null ? 'noResponsibleManager' : 'responsibleAssigned');
  const authorBlock = document.querySelector('#detail-author-block');
  authorBlock.hidden = reviewRole !== 'admin' || !ticket.author;
  if (reviewRole === 'admin' && ticket.author) {
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
  clearAttachmentPreviews();
  ticket = null;
  saving = false;
  feedback = message;
  state = 'loadingTicket';
  screen.setAttribute('aria-busy', 'true');
  renderTicketDetails();
  try {
    if (!ticketReader) throw new Error('ROUTING_UNAVAILABLE');
    const response = await ticketReader(ticketId);
    if (id !== requestId) return;
    ticket = response.data;
    assignmentDraft = ticket.assigned_to == null ? '' : String(ticket.assigned_to);
    state = '';
  } catch (error) {
    if (id !== requestId) return;
    if (lostAccess(error)) return;
    state = error.message === 'ROUTING_UNAVAILABLE' ? 'routingUnavailable' : error.message === 'NOT_FOUND' ? 'ticketNotFound' : error.message === 'FORBIDDEN' ? 'ticketForbidden' : 'ticketLoadError';
  } finally {
    if (id === requestId) {
      screen.removeAttribute('aria-busy');
      renderTicketDetails();
    }
  }
}

export function openTicketDetails(id, admin = false) {
  adminView = admin;
  directoryVersion++; directoryState = ''; managers = [];
  reviewRole = admin ? 'admin' : 'employee';
  ticketReader = getTicket;
  statusWriter = updateTicketStatus;
  document.querySelector('#detail-back').href = admin ? '#/admin' : '#/employee';
  ticketId = id;
  loadTicket();
  if (admin) loadTicketManagers();
}

export function openManagerTicketDetails(id, { readTicket = getTicket, updateStatus = (id, body) => updateTicketStatus(id, body, 'manager') } = {}) {
  adminView = true;
  reviewRole = 'manager';
  directoryVersion++; directoryState = ''; managers = [];
  ticketReader = readTicket;
  statusWriter = updateStatus;
  document.querySelector('#detail-back').href = '#/manager';
  ticketId = id;
  loadTicket();
}

export function closeTicketDetails() {
  directoryVersion++; directoryState = '';
  reviewRole = 'employee'; managers = []; assignmentPending = false; assignmentNotice = ''; assignmentError = ''; assignmentDraft = '';
  clearAttachmentPreviews();
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
  for (const selector of ['#detail-meta', '#detail-title', '#detail-date', '#detail-status', '#detail-description', '#detail-response', '#detail-author-name', '#detail-author-position', '#detail-category', '#detail-assignee']) {
    document.querySelector(selector).textContent = '';
  }
  renderTicketDetails();
}

retry.addEventListener('click', () => loadTicket(feedback));

async function saveStatus(nextStatus) {
  if (!adminView || !ticket || saving || assignmentPending || !statusWriter) return;
  const allowed = ticket.status === 'new' ? nextStatus === 'in_review'
    : ticket.status === 'in_review' && ['resolved', 'rejected'].includes(nextStatus);
  if (!allowed) return;
  const id = requestId;
  saving = true;
  feedback = '';
  actions.setAttribute('aria-busy', 'true');
  renderActions(); renderAssignment();
  try {
    await statusWriter(ticket.id, { status: nextStatus, comment: comment.value });
    if (id !== requestId) return;
    decision.value = '';
    comment.value = '';
    await loadTicket('decisionSaved');
  } catch (error) {
    if (id !== requestId) return;
    if (lostAccess(error)) return;
    if (error.message === 'FORBIDDEN') { ticket = null; state = 'ticketForbidden'; renderTicketDetails(); return; }
    if (error.message === 'INVALID_TRANSITION') await loadTicket('decisionConflict');
    else if (['NETWORK_ERROR', 'API_UNAVAILABLE', 'INTERNAL_ERROR', 'NOT_FOUND'].includes(error.message)) {
      await loadTicket('decisionUncertain');
    } else {
      if (error.message === 'VALIDATION_ERROR' && error.details?.comment) commentError = 'decisionCommentError';
      if (error.message === 'VALIDATION_ERROR' && error.details?.status) decisionError = 'decisionRequired';
      feedback = ({ VALIDATION_ERROR: 'decisionValidationError', FORBIDDEN: 'adminForbidden',
        UNAUTHORIZED: 'sessionExpired', ACCOUNT_DISABLED: 'accountDisabled', INVALID_ORIGIN: 'invalidOrigin',
        RATE_LIMITED: 'rateLimited', SERVICE_UNAVAILABLE: 'serviceUnavailable' })[error.message] ?? 'decisionSaveError';
    }
  } finally {
    // A refreshed detail or another route owns its own request state.
    if (id === requestId) { saving = false; renderActions(); renderAssignment(); }
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
