import { getAdminCategories, getCategories, createCategory, setCategoryActive, getManagers, updateRouting } from './api.js?v=dynamic-categories-20261113-1';
import { t } from './i18n.js?v=dynamic-categories-20261113-1';

let categoryNames = [];
let categoryNamesVersion = 0;
export function categoryLabel(code) {
  if (code && typeof code === 'object') return code[document.documentElement.lang === 'kk' ? 'name_kk' : 'name_ru'] ?? String(code.id ?? '');
  const entry = categoryNames.find(item => item.code === code);
  return entry ? entry[document.documentElement.lang === 'kk' ? 'name_kz' : 'name_ru'] : code;
}
export function clearCategoryNames() { categoryNamesVersion++; categoryNames = []; }
export async function loadCategoryNames(admin = false) {
  const version = ++categoryNamesVersion;
  const result = await (admin ? getAdminCategories() : getCategories());
  if (version === categoryNamesVersion) categoryNames = result.data;
  return result.data;
}
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
let archived = false;
const drafts = new Map();
const list = document.querySelector('#category-managers-list');

export function renderRouting() {
  if (archiveCode) document.querySelector('#archive-category-name').textContent = categoryLabel(archiveCode);
  document.querySelector('#category-managers-panel').hidden = !active;
  const status = document.querySelector('#category-managers-status');
  status.textContent = state ? t(state) : notice ? t(notice) : '';
  status.dataset.tone = ['assignmentSaved', 'directionCreated', 'directionArchived', 'directionRestored'].includes(notice) ? 'success'
    : ['assignmentUncertain', 'categoryMutationUncertain'].includes(notice) ? 'warning'
    : ['routingError', 'accountsForbidden'].includes(state) || fieldError || ['categoryArchivedError', 'categoryRequiredActive'].includes(notice) ? 'error' : 'info';
  document.querySelector('#retry-category-managers').hidden = !active || state !== 'routingError';
  document.querySelector('#category-create-fields').disabled = pending || Boolean(state);
  document.querySelector('#category-create-manager').disabled = pending || Boolean(state);
  const managerSelect = document.querySelector('#category-create-manager');
  const managerValue = managerSelect.value;
  fillManagerSelect(managerSelect, managers, managerValue || '');
  document.querySelector('#category-create-error').textContent = fieldError && !rules.some(rule => rule.category === fieldError) ? t(fieldError) : '';
  list.replaceChildren();
  if (!active || state) return;
  for (const rule of rules) {
    if (Boolean(rule.is_active) === archived) continue;
    const form = document.createElement('form'); form.noValidate = true;
    const label = document.createElement('label'); label.htmlFor = `routing-${rule.category}`; label.textContent = categoryLabel(rule.category);
    const current = document.createElement('p'); current.className = 'hint routing-current'; current.textContent = `${t('currentResponsible')}: ${managerLabel(rule.manager_id, managers)}`;
    const blocked = managers.some(user => user.id === rule.manager_id && !user.is_active);
    current.dataset.blocked = String(blocked);
    const select = document.createElement('select'); select.id = label.htmlFor; select.disabled = pending || !rule.is_active;
    fillManagerSelect(select, managers, drafts.get(rule.category) ?? '');
    select.addEventListener('change', () => { drafts.set(rule.category, select.value); fieldError = ''; notice = ''; error.hidden = true; error.textContent = ''; select.setAttribute('aria-invalid', 'false'); });
    const error = document.createElement('p'); error.id = `${select.id}-error`; error.className = 'field-error';
    error.textContent = fieldError === rule.category ? t('managerRequired') : ''; error.hidden = !error.textContent;
    select.setAttribute('aria-describedby', error.id); select.setAttribute('aria-invalid', String(!error.hidden));
    const button = document.createElement('button'); button.type = 'submit'; button.className = 'primary-button'; button.disabled = pending || !rule.is_active; button.textContent = t(pending ? 'savingDecision' : 'saveRouting');
    const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'secondary-button danger-ghost'; remove.textContent = t('removeAssignment'); remove.disabled = pending || !rule.is_active || rule.manager_id === null;
    remove.setAttribute('aria-label', `${t('removeAssignment')}: ${categoryLabel(rule.category)}`);
    remove.addEventListener('click', () => { if (rule.manager_id !== null) return saveRule(rule.category, null); });
    const actions = document.createElement('div'); actions.className = 'routing-actions'; actions.append(button, remove);
    const hint = document.createElement('p'); hint.className = 'hint routing-note';
    hint.textContent = blocked ? t('blockedRoutingHint') : rule.manager_id === null ? t('unassignedRoutingHint') : ''; hint.hidden = !hint.textContent;
    form.append(label, current, select, error, actions, hint);
    const archive = document.createElement('button'); archive.type = 'button'; archive.className = 'secondary-button' + (rule.is_active ? ' danger-ghost' : '');
    archive.textContent = t(rule.is_active ? 'archiveDirection' : 'restoreDirection');
    archive.disabled = pending || (rule.is_active && rule.category === 'general');
    if (rule.category === 'general') archive.title = t('categoryRequiredActive');
    archive.setAttribute('aria-label', `${archive.textContent}: ${categoryLabel(rule.category)}`);
    archive.addEventListener('click', () => {
      if (pending || !active) return;
      if (!rule.is_active) return changeCategory(rule.category, true);
      archiveCode = rule.category;
      document.querySelector('#archive-category-name').textContent = categoryLabel(rule.category);
      document.querySelector('#archive-category-dialog').showModal();
    });
    form.append(archive);
    if (!rule.is_active) { select.hidden = true; actions.hidden = true; hint.textContent = t('archivedDirectionNote'); hint.hidden = false; }
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
    rules = rules.map(item => item.category === category ? { ...item, ...response.data } : item);
    drafts.set(category, response.data.manager_id === null ? '' : String(response.data.manager_id));
    notice = 'assignmentSaved';
  } catch (error) {
    if (version !== generation) return;
    if (error.message === 'CATEGORY_ARCHIVED') { await loadRouting('categoryArchivedError'); return; }
    else if (error.message === 'VALIDATION_ERROR') fieldError = category;
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
    const [categories, directory] = await Promise.all([getAdminCategories(), getManagers()]);
    if (version !== generation) return;
    categoryNames = categories.data;
    rules = categories.data.map(item => ({ ...item, category: item.code })); managers = directory;
    for (const rule of rules) drafts.set(rule.category, rule.manager_id === null ? '' : String(rule.manager_id));
    state = '';
  } catch (error) { if (version === generation) state = error.message === 'FORBIDDEN' ? 'accountsForbidden' : 'routingError'; }
  finally { if (version === generation) renderRouting(); }
}
export function openRouting() { if (active) return; active = true; loadRouting(); }
export function closeRouting() {
  archived = false; document.querySelector('#show-archived-categories').checked = false;
  document.querySelector('#category-create-form').reset();
  archiveCode = null; document.querySelector('#archive-category-dialog').close();
  active = false; generation++; pending = false; rules = []; managers = []; drafts.clear(); state = ''; notice = ''; fieldError = ''; renderRouting();
}
document.querySelector('#retry-category-managers').addEventListener('click', () => { if (active && !pending) loadRouting(); });
globalThis.window?.addEventListener('staff-directory-changed', () => { if (active && !pending) loadRouting(); });

let archiveCode = null;
document.querySelector('#show-archived-categories').addEventListener('change', event => { archived = event.target.checked; renderRouting(); });
document.querySelector('#cancel-archive-category').addEventListener('click', () => document.querySelector('#archive-category-dialog').close());
document.querySelector('#archive-category-dialog').addEventListener('close', () => { archiveCode = null; });
document.querySelector('#confirm-archive-category').addEventListener('click', () => {
  const code = archiveCode;
  document.querySelector('#archive-category-dialog').close();
  if (code) return changeCategory(code, false);
});

async function changeCategory(code, is_active) {
  if (!active || pending) return;
  const version = generation; pending = true; notice = ''; fieldError = ''; renderRouting();
  try {
    await setCategoryActive(code, is_active);
    if (version !== generation) return;
    await loadRouting(is_active ? 'directionRestored' : 'directionArchived');
  } catch (error) {
    if (version !== generation) return;
    await loadRouting(({ CATEGORY_REQUIRED_ACTIVE: 'categoryRequiredActive', CATEGORY_ARCHIVED: 'categoryArchivedError', FORBIDDEN: 'accountsForbidden' })[error.message] ?? 'categoryMutationUncertain');
  } finally { if (version === generation) { pending = false; renderRouting(); } }
}

document.querySelector('#category-create-form').addEventListener('submit', async event => {
  event.preventDefault(); if (!active || pending || state) return;
  const values = Object.fromEntries(['code', 'name_ru', 'name_kz'].map(key => [key, document.querySelector(`#category-${key}`).value.trim()]));
  fieldError = !/^[a-z][a-z0-9_]{1,31}$/.test(values.code) ? 'categoryCodeError'
    : [values.name_ru, values.name_kz].some(name => !name || Array.from(name).length > 120) ? 'categoryNameError' : '';
  try { values.manager_id = selectedManager(document.querySelector('#category-create-manager').value, managers); } catch { fieldError = 'managerRequired'; }
  if (fieldError) { renderRouting(); document.querySelector(fieldError === 'categoryCodeError' ? '#category-code' : fieldError === 'managerRequired' ? '#category-create-manager' : '#category-name_ru').focus(); return; }
  const version = generation; pending = true; notice = ''; renderRouting();
  try {
    await createCategory(values);
    if (version !== generation) return;
    document.querySelector('#category-create-form').reset();
    await loadRouting('directionCreated');
  } catch (error) {
    if (version !== generation) return;
    if (error.message === 'CATEGORY_EXISTS') fieldError = 'categoryExists';
    else if (error.message === 'VALIDATION_ERROR') fieldError = 'categoryValidationError';
    else if (error.message === 'FORBIDDEN') { rules = []; managers = []; state = 'accountsForbidden'; }
    else { await loadRouting('categoryMutationUncertain'); return; }
  } finally { if (version === generation) { pending = false; renderRouting(); } }
});
