import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const boot = await readFile(new URL('../js/theme-init.js', import.meta.url), 'utf8');
const source = (await readFile(new URL('../js/theme.js', import.meta.url), 'utf8')).replace(/^import .*;\r?\n/gm, '').replaceAll('export ', '');

function harness({ dark = false, saved = null, blocked = false } = {}) {
  const storage = new Map(saved === null ? [] : [['team-voice-theme', saved]]);
  const button = { dataset: {}, attrs: {}, events: {}, setAttribute(name, value) { this.attrs[name] = value; }, addEventListener(name, callback) { this.events[name] = callback; } };
  const root = { dataset: {} };
  let changed, language = 'ru';
  const media = { matches: dark, addEventListener(event, callback) { changed = callback; } };
  const context = vm.createContext({
    document: { documentElement: root, querySelector: () => button }, matchMedia: () => media,
    t: key => `${language}:${key}`,
    localStorage: { getItem(key) { if (blocked) throw new Error('Denied'); return storage.get(key) ?? null; }, setItem(key, value) { if (blocked) throw new Error('Denied'); storage.set(key, value); } },
  });
  vm.runInContext(boot, context);
  const initial = root.dataset.theme;
  vm.runInContext(source, context); context.initTheme();
  return { context, root, initial, button, storage, changeSystem(dark) { media.matches = dark; changed({ matches: dark }); }, setLanguage(next) { language = next; context.renderThemeToggle(); } };
}

test('theme boot follows system before app initialization without saving an implicit preference', () => {
  const h = harness({ dark: true });
  assert.equal(h.initial, 'dark'); assert.equal(h.root.dataset.theme, 'dark');
  assert.equal(h.storage.size, 0);
  h.changeSystem(false); assert.equal(h.root.dataset.theme, 'light');
});

test('explicit theme is saved, overrides system and supplies translated accessible button labels', () => {
  const h = harness({ dark: true, saved: 'light' });
  assert.equal(h.initial, 'light');
  h.button.events.click();
  assert.equal(h.root.dataset.theme, 'dark'); assert.equal(h.storage.get('team-voice-theme'), 'dark');
  assert.equal(h.button.attrs['aria-pressed'], 'true');
  assert.equal(h.button.title, 'ru:switchLightTheme');
  h.changeSystem(false); assert.equal(h.root.dataset.theme, 'dark');
  h.setLanguage('kk'); assert.equal(h.button.attrs['aria-label'], 'kk:switchLightTheme');
  const reloaded = harness({ dark: false, saved: h.storage.get('team-voice-theme') });
  assert.equal(reloaded.initial, 'dark');
});

test('invalid or blocked storage falls back to system and switching remains usable', () => {
  assert.equal(harness({ dark: true, saved: 'invalid' }).initial, 'dark');
  const h = harness({ dark: false, blocked: true });
  h.button.events.click(); assert.equal(h.root.dataset.theme, 'dark');
  h.changeSystem(false); assert.equal(h.root.dataset.theme, 'dark');
});
