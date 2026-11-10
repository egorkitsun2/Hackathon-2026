import { getAdminTickets } from './api.js';
import { t } from './i18n.js';

const screen = document.querySelector('#admin-screen');
const filter = document.querySelector('#admin-status-filter');
const rows = document.querySelector('#admin-ticket-rows');
const table = document.querySelector('#admin-ticket-table');
const status = document.querySelector('#admin-queue-status');
const retry = document.querySelector('#retry-admin-queue');
const pagination = document.querySelector('#admin-pagination');
const previous = document.querySelector('#admin-previous-page');
const next = document.querySelector('#admin-next-page');
let profile = null;
let page = 1;
let result = null;
let state = '';
let requestId = 0;

function textElement(tag, text, className) {
  const element = document.createElement(tag);
  element.textContent = text;
  if (className) element.className = className;
  return element;
}

export function renderAdminQueue() {
  document.querySelector('#admin-name').textContent = profile ? `${t('greeting')}, ${profile.full_name}` : '';
  rows.replaceChildren();
  status.textContent = state ? t(state) : '';
  retry.hidden = state !== 'adminQueueError';
  table.hidden = !result?.data.length;
  pagination.hidden = !result || result.pagination.total <= result.pagination.limit;
  if (!result) return;
  for (const ticket of result.data) {
    const row = document.createElement('tr');
    const summary = document.createElement('th');
    summary.scope = 'row';
    summary.append(textElement('p', `${t(ticket.type)} · № ${ticket.id}`, 'hint'), textElement('p', ticket.title, 'queue-ticket-title'));
    const author = document.createElement('td');
    author.dataset.label = t('ticketAuthor');
    author.append(textElement('p', ticket.author.full_name), textElement('p', `${ticket.author.department} · ${ticket.author.position}`, 'hint'));
    const dateCell = document.createElement('td');
    dateCell.dataset.label = t('createdAt');
    const date = textElement('time', new Intl.DateTimeFormat(document.documentElement.lang === 'kk' ? 'kk-KZ' : 'ru-KZ', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(ticket.created_at)));
    date.dateTime = ticket.created_at;
    dateCell.append(date);
    const badgeCell = document.createElement('td');
    badgeCell.dataset.label = t('statusFilter');
    badgeCell.append(textElement('p', t(ticket.status), `ticket-status status-${ticket.status}`));
    const actionCell = document.createElement('td');
    const link = textElement('a', t('ticketDetails'), 'secondary-button action-link');
    link.href = `#/admin/tickets/${ticket.id}`;
    actionCell.append(link);
    row.append(summary, author, dateCell, badgeCell, actionCell);
    rows.append(row);
  }
  document.querySelector('#admin-page-number').textContent = `${t('page')} ${result.pagination.page}`;
  previous.disabled = page <= 1;
  next.disabled = page * result.pagination.limit >= result.pagination.total;
}

async function loadQueue() {
  const id = ++requestId;
  result = null;
  state = 'loadingAdminQueue';
  screen.setAttribute('aria-busy', 'true');
  renderAdminQueue();
  try {
    const response = await getAdminTickets({ page, status: filter.value });
    if (id !== requestId) return;
    result = response;
    state = response.data.length ? '' : filter.value ? 'noFilteredTickets' : 'noAdminTickets';
  } catch (error) {
    if (id !== requestId) return;
    state = error.message === 'FORBIDDEN' ? 'adminForbidden' : 'adminQueueError';
  } finally {
    if (id === requestId) {
      screen.removeAttribute('aria-busy');
      renderAdminQueue();
    }
  }
}

export function openAdminQueue(user) {
  profile = user;
  loadQueue();
}

export function closeAdminQueue(reset = false) {
  requestId++;
  result = null;
  profile = null;
  state = '';
  if (reset) { page = 1; filter.value = ''; }
  screen.removeAttribute('aria-busy');
  renderAdminQueue();
}

filter.addEventListener('change', () => { page = 1; loadQueue(); });
retry.addEventListener('click', loadQueue);
previous.addEventListener('click', () => { if (page > 1) { page--; loadQueue(); } });
next.addEventListener('click', () => {
  if (result && page * result.pagination.limit < result.pagination.total) { page++; loadQueue(); }
});
