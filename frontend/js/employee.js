import { getMyTickets } from './api.js?v=writing-help-20261111-1';
import { t } from './i18n.js?v=writing-help-20261111-1';

const screen = document.querySelector('#employee-screen');
const list = document.querySelector('#ticket-list');
const status = document.querySelector('#tickets-status');
const retry = document.querySelector('#retry-tickets');
const pagination = document.querySelector('#ticket-pagination');
const previous = document.querySelector('#previous-page');
const next = document.querySelector('#next-page');
let profile;
let result;
let page = 1;
let ownerId = null;
let state = 'loadingTickets';
let requestId = 0;

function textElement(tag, text, className) {
  const element = document.createElement(tag);
  element.textContent = text;
  if (className) element.className = className;
  return element;
}

export function renderEmployee() {
  if (profile) {
    document.querySelector('#employee-name').textContent = `${t('greeting')}, ${profile.full_name}`;
    document.querySelector('#employee-position').textContent = `${profile.department} · ${profile.position}`;
  }
  list.replaceChildren();
  status.textContent = state ? t(state) : '';
  retry.hidden = state !== 'ticketsError';
  pagination.hidden = !result || result.pagination.total <= result.pagination.limit;
  if (!result) return;
  for (const ticket of result.data) {
    const item = document.createElement('li');
    item.className = 'ticket';
    const meta = textElement('p', `${t(ticket.type)} · № ${ticket.id}`, 'hint');
    const title = textElement('h3', ticket.title);
    const time = textElement('time', new Intl.DateTimeFormat(document.documentElement.lang === 'kk' ? 'kk-KZ' : 'ru-KZ', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(ticket.created_at)), 'hint');
    time.dateTime = ticket.created_at;
    const badge = textElement('p', t(ticket.status), `ticket-status status-${ticket.status}`);
    const details = textElement('a', t('ticketDetails'), 'secondary-button action-link');
    details.href = `#/tickets/${ticket.id}`;
    item.append(meta, title, time, badge, details);
    list.append(item);
  }
  document.querySelector('#page-number').textContent = `${t('page')} ${result.pagination.page}`;
  previous.disabled = page <= 1;
  next.disabled = page * result.pagination.limit >= result.pagination.total;
}

async function loadTickets() {
  const id = ++requestId;
  state = 'loadingTickets';
  result = null;
  screen.setAttribute('aria-busy', 'true');
  renderEmployee();
  try {
    const ticketsResponse = await getMyTickets({ page });
    if (id !== requestId) return;
    result = ticketsResponse;
    const lastPage = Math.max(1, Math.ceil(result.pagination.total / result.pagination.limit));
    if (page > lastPage) { page = lastPage; await loadTickets(); return; }
    state = result.data.length ? '' : 'noTickets';
  } catch {
    if (id !== requestId) return;
    state = 'ticketsError';
  } finally {
    if (id === requestId) {
      screen.removeAttribute('aria-busy');
      renderEmployee();
    }
  }
}

export function openEmployee(user) {
  if (ownerId !== user.id) page = 1;
  ownerId = user.id;
  profile = user;
  loadTickets();
}

export function closeEmployee(reset = false) {
  if (reset) { page = 1; ownerId = null; }
  requestId++;
  profile = null;
  result = null;
  document.querySelector('#employee-name').textContent = '';
  document.querySelector('#employee-position').textContent = '';
  list.replaceChildren();
  screen.removeAttribute('aria-busy');
}

previous.addEventListener('click', () => { if (page > 1) { page--; loadTickets(); } });
next.addEventListener('click', () => {
  if (result && page * result.pagination.limit < result.pagination.total) { page++; loadTickets(); }
});
retry.addEventListener('click', loadTickets);
