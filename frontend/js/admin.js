import { getAdminTickets, getAdminStats, getManagers, getManagerTickets } from './api.js?v=dynamic-categories-20261113-1';
import { categoryLabel, managerLabel } from './routing.js?v=dynamic-categories-20261113-1';
import { t } from './i18n.js?v=dynamic-categories-20261113-1';

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
let queueReader = null;
let managers = [], directoryRequestId = 0;
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
  document.querySelector('#admin-stats-status').dataset.tone = ['statsError', 'accountsForbidden'].includes(statsState) ? 'error' : 'info';
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
  if (profile?.role !== 'admin') return;
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
  const manager = profile?.role === 'manager';
  document.querySelector('#admin-stats-panel').hidden = manager;
  document.querySelector('#admin-queue-flags').hidden = !profile || manager;
  document.querySelector('#admin-unassigned-filter-label').hidden = !profile || manager;
  document.querySelector('#admin-needs-reassignment-filter-label').hidden = !profile || manager;
  document.querySelector('#admin-reassignment-hint').hidden = !profile || manager;
  for (const [selector, key] of [['#admin-title', manager ? 'managerTitle' : 'adminTitle'], ['#admin-queue-heading', manager ? 'managerQueue' : 'adminQueue']]) {
    const heading = document.querySelector(selector); heading.dataset.i18n = key; heading.textContent = t(key);
  }
  renderStats();
  document.querySelector('#admin-name').textContent = profile ? `${t('greeting')}, ${profile.full_name}` : '';
  rows.replaceChildren();
  status.textContent = state ? t(state) : '';
  status.dataset.tone = ['adminQueueError', 'adminForbidden'].includes(state) ? 'error' : 'info';
  retry.hidden = state !== 'adminQueueError';
  table.hidden = !result?.data.length;
  pagination.hidden = !result || result.pagination.total <= result.pagination.limit;
  if (!result) return;
  for (const ticket of result.data) {
    const row = document.createElement('tr');
    const needsReassignment = !manager && ticket.needs_reassignment === true;
    row.dataset.needsReassignment = String(needsReassignment);
    const summary = document.createElement('th');
    summary.scope = 'row';
    summary.append(textElement('p', `${t(ticket.type)} · № ${ticket.id}`, 'hint'), textElement('p', ticket.title, 'queue-ticket-title'));
    if (needsReassignment) summary.append(textElement('p', t('needsReassignmentBadge'), 'ticket-status reassignment-badge'));
    const author = document.createElement('td');
    author.dataset.label = t('ticketAuthor');
    if (!manager && ticket.author) author.append(textElement('p', ticket.author.full_name), textElement('p', `${ticket.author.department} · ${ticket.author.position}`, 'hint'));
    else author.append(textElement('p', t('authorRestricted'), 'hint'));
    if (ticket.category) summary.append(textElement('p', categoryLabel(ticket.category), 'hint'));
    if (!manager && 'assigned_to' in ticket) summary.append(textElement('p', `${t('responsibleManager')}: ${managerLabel(ticket.assigned_to, managers)}`, 'hint'));
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
    link.href = `#/${manager ? 'manager' : 'admin'}/tickets/${ticket.id}`;
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
  state = profile?.role === 'manager' ? 'loadingManagerQueue' : 'loadingAdminQueue';
  screen.setAttribute('aria-busy', 'true');
  renderAdminQueue();
  try {
    if (!queueReader) throw new Error('ROUTING_UNAVAILABLE');
    const adminFilters = profile?.role === 'admin' ? {
      ...(document.querySelector('#admin-unassigned-filter').checked ? { unassigned: true } : {}),
      ...(document.querySelector('#admin-needs-reassignment-filter').checked ? { needs_reassignment: true } : {}),
    } : {};
    const response = await queueReader({ page, status: filter.value, ...adminFilters });
    if (id !== requestId) return;
    result = response;
    const lastPage = Math.max(1, Math.ceil(result.pagination.total / result.pagination.limit));
    if (page > lastPage) { page = lastPage; await loadQueue(); return; }
    state = response.data.length ? '' : (filter.value || Object.keys(adminFilters).length) ? 'noFilteredTickets' : profile?.role === 'manager' ? 'noManagerTickets' : 'noAdminTickets';
  } catch (error) {
    if (id !== requestId) return;
    state = error.message === 'ROUTING_UNAVAILABLE' ? 'routingUnavailable' : error.message === 'FORBIDDEN' ? 'adminForbidden' : 'adminQueueError';
  } finally {
    if (id === requestId) {
      screen.removeAttribute('aria-busy');
      renderAdminQueue();
    }
  }
}

export function openAdminQueue(user) {
  profile = user;
  queueReader = getAdminTickets;
  loadStats();
  loadQueue();
  const id = ++directoryRequestId;
  getManagers().then(users => { if (id === directoryRequestId && profile?.role === 'admin') { managers = users; renderAdminQueue(); } }).catch(() => {});
}

export function openManagerQueue(user, readAssignedTickets = getManagerTickets) {
  if (user?.role !== 'manager') return;
  profile = user;
  directoryRequestId++; managers = [];
  queueReader = readAssignedTickets;
  statsRequestId++; stats = null; statsState = '';
  loadQueue();
}

export function closeAdminQueue(reset = false) {
  requestId++;
  statsRequestId++; stats = null; statsState = '';
  result = null;
  profile = null;
  directoryRequestId++; managers = [];
  queueReader = null;
  state = '';
  if (reset) { page = 1; filter.value = ''; document.querySelector('#admin-unassigned-filter').checked = false; document.querySelector('#admin-needs-reassignment-filter').checked = false; }
  screen.removeAttribute('aria-busy');
  renderAdminQueue();
}

filter.addEventListener('change', () => { page = 1; loadQueue(); });
document.querySelector('#admin-unassigned-filter').addEventListener('change', () => { if (profile?.role === 'admin') { page = 1; loadQueue(); } });
document.querySelector('#admin-needs-reassignment-filter').addEventListener('change', () => { if (profile?.role === 'admin') { page = 1; loadQueue(); } });
retry.addEventListener('click', loadQueue);
previous.addEventListener('click', () => { if (page > 1) { page--; loadQueue(); } });
next.addEventListener('click', () => {
  if (result && page * result.pagination.limit < result.pagination.total) { page++; loadQueue(); }
});
