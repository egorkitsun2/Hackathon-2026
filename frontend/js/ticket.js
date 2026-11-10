import { getTicket } from './api.js';
import { t } from './i18n.js';

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

async function loadTicket() {
  const id = ++requestId;
  ticket = null;
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
  requestId++;
  ticket = null;
  ticketId = null;
  state = '';
  screen.removeAttribute('aria-busy');
  // Clear private text as well as hiding it when leaving a ticket or signing out.
  document.querySelector('#detail-author-block').hidden = true;
  for (const selector of ['#detail-meta', '#detail-title', '#detail-date', '#detail-status', '#detail-description', '#detail-response', '#detail-author-name', '#detail-author-position']) {
    document.querySelector(selector).textContent = '';
  }
  renderTicketDetails();
}

retry.addEventListener('click', loadTicket);
