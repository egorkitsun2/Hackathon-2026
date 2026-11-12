import { getRouting, getManagers, updateRouting } from './api.js?v=reassignment-filter-20261112-1';
import { t } from './i18n.js?v=reassignment-filter-20261112-1';

export const categoryLabel = code => t(({ it: 'directionIT', procurement: 'directionPurchasing', general: 'directionGeneral' })[code] ?? 'directionUnknown');
export function managerLabel(id, managers = []) {
  if (id === null || id === undefined) return t('noResponsibleManager');
  const manager = managers.find(user => user.id === id);
  return manager ? `${manager.full_name}${manager.is_active ? '' : ` (${t('accountBlocked')})`}` : `${t('roleManager')} № ${id}`;
}
export function fillManagerSelect(select, managers, value) {
  select.replaceChildren();
  for (const [id, text, disabled] of [
    ['', t('noResponsibleManager'), false],
    ...managers.filter(user => user.role === 'manager' && user.is_active).map(user => [String(user.id), user.full_name, false]),
    ...(value && !managers.some(user => user.role === 'manager' && user.is_active && String(user.id) === value)
      ? [[value, managerLabel(Number(value), managers), true]] : []),
  ]) {
    const option = document.createElement('option'); option.value = id; option.textContent = text; option.disabled = disabled; select.append(option);
  }
  select.value = value;
}
export function selectedManager(value, managers) {
  if (value === '') return null;
  const id = Number(value);
  if (!Number.isSafeInteger(id) || !managers.some(user => user.id === id && user.role === 'manager' && user.is_active)) throw new Error('INVALID_MANAGER');
  return id;
}

let active = false, generation = 0, pending = false;
let rules = [], managers = [], state = '', notice = '', fieldError = '';
const drafts = new Map();
const list = document.querySelector('#category-managers-list');

export function renderRouting() {
  document.querySelector('#category-managers-panel').hidden = !active;
  const status = document.querySelector('#category-managers-status');
  status.textContent = state ? t(state) : notice ? t(notice) : '';
  status.dataset.tone = notice === 'assignmentSaved' ? 'success' : notice === 'assignmentUncertain' ? 'warning' : state === 'routingError' || fieldError ? 'error' : 'info';
  document.querySelector('#retry-category-managers').hidden = !active || state !== 'routingError';
  list.replaceChildren();
  if (!active || state) return;
  for (const rule of rules) {
    const form = document.createElement('form'); form.noValidate = true;
    const label = document.createElement('label'); label.htmlFor = `routing-${rule.category}`; label.textContent = categoryLabel(rule.category);
    const current = document.createElement('p'); current.className = 'hint routing-current'; current.textContent = `${t('currentResponsible')}: ${managerLabel(rule.manager_id, managers)}`;
    const blocked = managers.some(user => user.id === rule.manager_id && !user.is_active);
    current.dataset.blocked = String(blocked);
    const select = document.createElement('select'); select.id = label.htmlFor; select.disabled = pending;
    fillManagerSelect(select, managers, drafts.get(rule.category) ?? '');
    select.addEventListener('change', () => { drafts.set(rule.category, select.value); fieldError = ''; notice = ''; error.hidden = true; error.textContent = ''; select.setAttribute('aria-invalid', 'false'); });
    const error = document.createElement('p'); error.id = `${select.id}-error`; error.className = 'field-error';
    error.textContent = fieldError === rule.category ? t('managerRequired') : ''; error.hidden = !error.textContent;
    select.setAttribute('aria-describedby', error.id); select.setAttribute('aria-invalid', String(!error.hidden));
    const button = document.createElement('button'); button.type = 'submit'; button.className = 'primary-button'; button.disabled = pending; button.textContent = t(pending ? 'savingDecision' : 'saveRouting');
    const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'secondary-button danger-ghost'; remove.textContent = t('removeAssignment'); remove.disabled = pending || rule.manager_id === null;
    remove.setAttribute('aria-label', `${t('removeAssignment')}: ${categoryLabel(rule.category)}`);
    remove.addEventListener('click', () => { if (rule.manager_id !== null) return saveRule(rule.category, null); });
    const actions = document.createElement('div'); actions.className = 'routing-actions'; actions.append(button, remove);
    const hint = document.createElement('p'); hint.className = 'hint routing-note';
    hint.textContent = blocked ? t('blockedRoutingHint') : rule.manager_id === null ? t('unassignedRoutingHint') : ''; hint.hidden = !hint.textContent;
    form.append(label, current, select, error, actions, hint);
    form.addEventListener('submit', async event => {
      event.preventDefault(); if (!active || pending) return;
      let id;
      try { id = selectedManager(select.value, managers); } catch { fieldError = rule.category; renderRouting(); document.querySelector(`#routing-${rule.category}`)?.focus(); return; }
      await saveRule(rule.category, id);
    });
    list.append(form);
  }
}

async function saveRule(category, id) {
  if (!active || pending) return;
  const version = generation; pending = true; notice = ''; fieldError = ''; renderRouting();
  try {
    const response = await updateRouting(category, id);
    if (version !== generation) return;
    rules = rules.map(item => item.category === category ? response.data : item);
    drafts.set(category, response.data.manager_id === null ? '' : String(response.data.manager_id));
    notice = 'assignmentSaved';
  } catch (error) {
    if (version !== generation) return;
    if (error.message === 'VALIDATION_ERROR') fieldError = category;
    else if (error.message === 'FORBIDDEN') { rules = []; managers = []; state = 'accountsForbidden'; }
    else {
      const message = ['NETWORK_ERROR', 'API_UNAVAILABLE', 'INTERNAL_ERROR', 'INVALID_TRANSITION'].includes(error.message) ? 'assignmentUncertain' : 'assignmentError';
      await loadRouting(message); return;
    }
  } finally { if (version === generation) { pending = false; renderRouting(); } }
}

async function loadRouting(message = '') {
  const version = ++generation;
  pending = false; rules = []; managers = []; drafts.clear(); fieldError = ''; notice = message; state = 'loadingDirections'; renderRouting();
  try {
    const [routing, directory] = await Promise.all([getRouting(), getManagers()]);
    if (version !== generation) return;
    rules = routing.data; managers = directory;
    for (const rule of rules) drafts.set(rule.category, rule.manager_id === null ? '' : String(rule.manager_id));
    state = '';
  } catch (error) { if (version === generation) state = error.message === 'FORBIDDEN' ? 'accountsForbidden' : 'routingError'; }
  finally { if (version === generation) renderRouting(); }
}
export function openRouting() { if (active) return; active = true; loadRouting(); }
export function closeRouting() {
  active = false; generation++; pending = false; rules = []; managers = []; drafts.clear(); state = ''; notice = ''; fieldError = ''; renderRouting();
}
document.querySelector('#retry-category-managers').addEventListener('click', () => { if (active && !pending) loadRouting(); });
globalThis.window?.addEventListener('staff-directory-changed', () => { if (active && !pending) loadRouting(); });
