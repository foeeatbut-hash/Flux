/**
 * Панель «Черновики»: отбор, порядок и группы (src/lib/draftsPanel.ts) и
 * чтение настроек (src/store/draftsSettingsStore.ts) — без браузера.
 */
import assert from 'node:assert/strict';
import type { WindowsDraftEntry } from '../filesystem/contracts';
import { badgeCount, dateGroup, draftKind, draftState, extLabel, filterDrafts, groupDrafts, numberedName, openDraftIds, shortWhen, sortDrafts } from '../src/lib/draftsPanel';
import { DRAFTS_DEFAULTS, normalizeDraftsSettings } from '../src/store/draftsSettingsStore';

let passed = 0;
const ok = (name: string, check: () => void) => { check(); passed++; console.log('✓', name); };

const NOW = new Date(2026, 10, 5, 12, 0).getTime();
const at = (daysAgo: number, hour = 9) => { const d = new Date(NOW); d.setDate(d.getDate() - daysAgo); d.setHours(hour, 30, 0, 0); return d.toISOString(); };
const draft = (id: string, name: string, daysAgo: number, extra: Partial<WindowsDraftEntry> = {}): WindowsDraftEntry => ({
  name, relativePath: name, storage: 'flux', draftId: id, kind: 'file', fileId: id, size: 1000, modifiedAt: at(daysAgo), linked: false,
  parent: { rootId: 'r', relativePath: '' }, metadata: { fileId: id, tags: [], projectIds: [], revision: '', responsible: '', history: [] }, ...extra,
});
const sheet = draft('a', 'Опросный лист.xlsx', 0, { size: 5000 });
const letter = draft('b', 'Письмо.docx', 1, { metadata: { fileId: 'b', tags: ['AHU-2'], projectIds: ['p1'], revision: '', responsible: '', history: [] } });
const scheme = draft('c', 'Схема.pdf', 3);
const folder = draft('d', 'Бланки', 20, { kind: 'directory', size: 0 });
const node = draft('e', 'Узел.dwg', 40);
const all = [sheet, letter, scheme, folder, node];
const none = new Set<string>();
const base = { kind: 'all' as const, state: null, text: '', folders: true, scope: 'all' as const, openDrafts: none, now: NOW };

ok('Тип по расширению и метка значка', () => {
  assert.deepEqual(all.map(draftKind), ['table', 'doc', 'drawing', 'folder', 'drawing']);
  assert.equal(extLabel(sheet), 'XLSX'); assert.equal(extLabel(folder), '');
});
ok('Состояние: открыт — «правится», без проекта — «не в проекте»', () => {
  assert.equal(draftState(sheet, new Set(['a'])), 'editing');
  assert.equal(draftState(sheet, none), 'unsent');
  assert.equal(draftState(letter, none), 'draft');
});
ok('Фильтры типа, состояния, поиска (по имени и тегу) и папок', () => {
  assert.deepEqual(filterDrafts(all, { ...base, kind: 'drawing' }).map((e) => e.draftId), ['c', 'e']);
  assert.deepEqual(filterDrafts(all, { ...base, state: 'draft' }).map((e) => e.draftId), ['b']);
  assert.deepEqual(filterDrafts(all, { ...base, text: 'ahu' }).map((e) => e.draftId), ['b']);
  assert.deepEqual(filterDrafts(all, { ...base, text: 'схем' }).map((e) => e.draftId), ['c']);
  assert.ok(!filterDrafts(all, { ...base, folders: false }).includes(folder));
  assert.deepEqual(filterDrafts(all, { ...base, scope: 'current', projectId: 'p1' }).map((e) => e.draftId), ['b']);
  assert.deepEqual(filterDrafts(all, { ...base, olderThanDays: 14 }).map((e) => e.draftId), ['d', 'e']);
});
ok('Сортировка по ключам и порядку, закреплённые первыми', () => {
  assert.deepEqual(sortDrafts(all, 'modified', 'desc').map((e) => e.draftId), ['a', 'b', 'c', 'd', 'e']);
  assert.deepEqual(sortDrafts(all, 'modified', 'asc').map((e) => e.draftId), ['e', 'd', 'c', 'b', 'a']);
  assert.equal(sortDrafts(all, 'size', 'desc')[0].draftId, 'a');
  assert.deepEqual(sortDrafts(all, 'name', 'asc').map((e) => e.name), ['Бланки', 'Опросный лист.xlsx', 'Письмо.docx', 'Схема.pdf', 'Узел.dwg']);
  assert.deepEqual(sortDrafts(all, 'modified', 'desc', ['e', 'c']).map((e) => e.draftId), ['e', 'c', 'a', 'b', 'd']);
});
ok('Группы по дате: Сегодня, Вчера, Неделя, Раньше — от свежих к старым при любом порядке', () => {
  assert.deepEqual([0, 1, 3, 20].map((d) => dateGroup(at(d), NOW)), ['Сегодня', 'Вчера', 'Неделя', 'Раньше']);
  const sections = groupDrafts(sortDrafts(all, 'name', 'asc'), 'date', { now: NOW, openDrafts: none });
  assert.deepEqual(sections.map((s) => s.label), ['Сегодня', 'Вчера', 'Неделя', 'Раньше']);
  assert.deepEqual(sections[3].items.map((e) => e.draftId), ['d', 'e']);
  assert.equal(groupDrafts(all, 'none', { openDrafts: none }).length, 1);
});
ok('Закреплённые — первая группа, их нет среди остальных', () => {
  const sections = groupDrafts(sortDrafts(all, 'modified', 'desc', ['e']), 'date', { now: NOW, openDrafts: none, pinned: ['e'] });
  assert.deepEqual(sections.map((s) => s.label), ['Закреплённые', 'Сегодня', 'Вчера', 'Неделя', 'Раньше']);
  assert.deepEqual(sections[0].items.map((e) => e.draftId), ['e']);
  assert.deepEqual(sections[4].items.map((e) => e.draftId), ['d'], 'закреплённый не повторяется в своей дате');
  assert.deepEqual(groupDrafts(all, 'date', { now: NOW, openDrafts: none, pinned: ['нет-такого'] }).map((s) => s.label), ['Сегодня', 'Вчера', 'Неделя', 'Раньше']);
});
ok('Короткое время под плиткой', () => {
  assert.equal(shortWhen(at(0), NOW), '9:30');
  assert.equal(shortWhen(at(1), NOW), 'вчера 9:30');
  assert.match(shortWhen(at(20), NOW), /^\d\d\.\d\d$/);
  assert.equal(shortWhen('', NOW), '—');
});
ok('Счётчик кнопки, открытые окна и свободное имя', () => {
  assert.equal(badgeCount(all, 'unsent', none), 4);
  assert.equal(badgeCount(all, 'all', none), 5);
  assert.equal(badgeCount(all, 'off', none), 0);
  assert.deepEqual([...openDraftIds(['/windows-file?root=r&path=a&draft=a', '/explorer?root=r&draft=x', '/registry'])], ['a']);
  assert.equal(numberedName('Документ.docx', 2, false), 'Документ (2).docx');
  assert.equal(numberedName('Папка.v2', 3, true), 'Папка.v2 (3)');
});
ok('Настройки: чужие значения заменяются умолчаниями поле за полем', () => {
  assert.deepEqual(normalizeDraftsSettings(null), DRAFTS_DEFAULTS);
  const s = normalizeDraftsSettings({ view: 'compact', rows: 3, columns: 6, sort: 'evil', kind: 'folder', pinned: ['x', 1], remindDays: 30 });
  assert.equal(s.view, 'compact'); assert.equal(s.rows, 1); assert.equal(s.columns, 6); assert.equal(s.sort, 'modified');
  assert.equal(s.kind, 'folder'); assert.deepEqual(s.pinned, ['x']); assert.equal(s.remindDays, 30);
});
console.log(`${passed} проверок вида черновиков пройдено`);
