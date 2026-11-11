import { getAdminTickets, getAdminStats } from './api.js?v=theme-20261111-1';
import { t } from './i18n.js?v=theme-20261111-1';

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
let statsRequestId = 0;
let stats = null;
let statsState = '';
const metrics = [
  ['employees', 'total', 'statsEmployeesTotal'], ['employees', 'active', 'statsEmployeesActive'],
  ['tickets', 'total', 'statsTicketsTotal'], ['tickets', 'new', 'statsTicketsNew'],
  ['tickets', 'in_review', 'statsTicketsReview'], ['tickets', 'resolved', 'statsTicketsResolved'],
  ['tickets', 'rejected', 'statsTicketsRejected'],
];

function renderStats() {
  const list = document.querySelector('#admin-stats');
  list.replaceChildren();
  document.querySelector('#admin-stats-status').textContent = statsState ? t(statsState) : '';
  document.querySelector('#retry-admin-stats').hidden = statsState !== 'statsError';
  if (!stats) return;
  for (const [group, field, label] of metrics) {
    const card = document.createElement('div');
    card.className = 'stat-card';
    card.append(textElement('dt', t(label)), textElement('dd', String(stats[group][field])));
    list.append(card);
  }
}

async function loadStats() {
  if (!profile) return;
  const id = ++statsRequestId;
  stats = null; statsState = 'statsLoading'; renderStats();
  try {
    const response = await getAdminStats();
    if (id !== statsRequestId) return;
    if (!metrics.every(([group, field]) => Number.isSafeInteger(response.data?.[group]?.[field]) && response.data[group][field] >= 0)) throw new Error('API_UNAVAILABLE');
    stats = response.data; statsState = '';
  } catch (error) {
    if (id !== statsRequestId) return;
    statsState = error.message === 'FORBIDDEN' ? 'accountsForbidden' : 'statsError';
  } finally {
    if (id === statsRequestId) renderStats();
  }
}

document.querySelector('#retry-admin-stats').addEventListener('click', loadStats);

function textElement(tag, text, className) {
  const element = document.createElement(tag);
  element.textContent = text;
  if (className) element.className = className;
  return element;
}

export function renderAdminQueue() {
  renderStats();
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
  loadStats();
  loadQueue();
}

export function closeAdminQueue(reset = false) {
  requestId++;
  statsRequestId++; stats = null; statsState = '';
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
