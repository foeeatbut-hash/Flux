/**
 * Клиентский разбор отказа записи по предпросмотру оборудования (src/components/equipment/planRefusal.ts):
 * без React и без сети, на голых объектах — то, что приходит с сервера (`changed` / `gone`) и что видел экран.
 *
 *  • `planConflictOf` узнаёт отказ ровно по коду и по наличию перечня: чужой 409 (занятый тег, устаревшая ревизия
 *    привязок) перечнем не считается;
 *  • `pickSeen` отправляет версии только тех позиций, которых коснётся запись, и только целые ≥ 1;
 *  • `planRefusalOf`: изменённая позиция — «было → стало» по полям, которые видит человек; удалённая — «есть → удалена»;
 *    позиция, которой предпросмотр не видел, — «появилась после»; правка нечитаемых полей — «Другие сведения»;
 *  • `xmlPlanRefusalOf`: сравниваются только строки сравнения XML, как их видел экран, и название позиции.
 */
import assert from 'node:assert/strict';
import { VERSION_CONFLICT, RECORD_GONE } from '../src/lib/refusalTexts';
import { pickSeen, planConflictOf, planRefusalOf, recordTitle, xmlPlanRefusalOf } from '../src/components/equipment/planRefusal';

let checks = 0;
const check = (label: string, ok: unknown, detail?: unknown) => { assert.ok(ok, `${label}${detail === undefined ? '' : `: ${JSON.stringify(detail).slice(0, 500)}`}`); checks++; console.log(`✓ ${label}`); };

const specs = (value: string, unit = 'м³/ч') => JSON.stringify({ groups: [{ title: 'Параметры', params: [{ key: 'Расход', value, unit }] }] });
const row = (extra: Record<string, unknown> = {}) => ({ name: 'Вентилятор', itemCode: 'FAN-1', status: 'OK', equipClass: null, equipKind: null, instanceNo: null, instanceCount: null, specs: specs('100'), overrides: null, ...extra });

// ── Узнавание отказа ──
check('409 с кодом и перечнем — отказ по версиям', planConflictOf(409, { code: VERSION_CONFLICT, changed: [], gone: ['a'] }));
check('409 с кодом, но без перечня — не наш (одиночная запись)', !planConflictOf(409, { code: VERSION_CONFLICT, error: 'x', current: {} }));
check('409 без кода (занятый тег, ревизия привязок) — не отказ по версиям', !planConflictOf(409, { error: 'Список привязок изменился', changed: [] }));
check('404 `RECORD_GONE` — не отказ по версиям', !planConflictOf(404, { code: RECORD_GONE, changed: [] }));
check('успех и пустое тело — не отказ', !planConflictOf(200, {}) && !planConflictOf(409, null));

// ── Версии для запроса ──
const plan = { a: 3, b: 1, c: 7 };
check('`pickSeen` берёт только названные позиции', JSON.stringify(pickSeen(plan, ['a', 'c'])) === JSON.stringify({ a: 3, c: 7 }));
check('`pickSeen` не выдумывает версию позиции, которой нет в плане', JSON.stringify(pickSeen(plan, ['zzz'])) === '{}');
check('`pickSeen` пропускает негодные версии (0, дробь, строка)', JSON.stringify(pickSeen({ a: 0, b: 1.5, c: '2' as any, d: 4 }, ['a', 'b', 'c', 'd'])) === JSON.stringify({ d: 4 }));
check('`pickSeen` без плана — пусто (старый ответ службы без `seen`)', JSON.stringify(pickSeen(undefined, ['a'])) === '{}');

// ── Перечень по позициям ──
const shown = { rows: { A: row(), B: row({ name: 'Клапан', itemCode: 'VLV-1' }), C: row({ name: 'Двигатель', itemCode: 'MOT-1' }) }, titleOf: (id: string, rec: any) => `Установка · ${recordTitle(id, rec)}` };
const data = {
  error: 'Пока вы смотрели предпросмотр, часть записей изменили. Ничего не записано.', code: VERSION_CONFLICT,
  changed: [
    { id: 'A', current: row({ specs: specs('250'), status: 'CONFLICT' }) },
    { id: 'C', current: row({ name: 'Двигатель', itemCode: 'MOT-1', equipClass: 'ДВИГАТЕЛЬ', equipKind: 'Асинхронный' }) },
    { id: 'NEW', current: row({ name: 'Новая', itemCode: 'NEW-1' }) },
  ],
  gone: ['B'],
};
const refusal = planRefusalOf(data, shown);
const byTitle = (t: string) => refusal.groups.find((g) => g.title.includes(t));
check('текст отказа — тот, что прислала служба', refusal.message === data.error);
check('позиция A: «Параметры · Расход» и «Состояние»: было → стало и «Состояние»', JSON.stringify(byTitle('FAN-1')!.changes.map((c) => [c.label, c.was, c.now]))
  === JSON.stringify([['Состояние', 'OK', 'CONFLICT'], ['Параметры · Расход', '100 м³/ч', '250 м³/ч']]), byTitle('FAN-1'));
check('позиция C: поправили тип — «Тип: определяется сам → …»', byTitle('MOT-1')!.changes.length === 1 && byTitle('MOT-1')!.changes[0].label === 'Тип'
  && byTitle('MOT-1')!.changes[0].was === 'определяется сам', byTitle('MOT-1'));
check('удалённая позиция B: «есть → удалена», название взято из показанного', byTitle('VLV-1')!.changes[0].was === 'есть' && byTitle('VLV-1')!.changes[0].now === 'удалена');
check('позиция, которой предпросмотр не видел, — «не было → появилась после предпросмотра»', byTitle('NEW-1')!.changes[0].was === 'не было');
const same = planRefusalOf({ changed: [{ id: 'A', current: row() }], gone: [] }, shown);
check('показанные поля те же, а версия выросла — «Другие сведения», а не пустая группа', same.groups.length === 1 && same.groups[0].changes[0].label === 'Другие сведения', same);
check('без текста от службы — запасной, и тоже «ничего не записано»', /Ничего не записано/.test(planRefusalOf({ changed: [], gone: [] }, shown).message));
check('`recordTitle`: название и обозначение; одно из двух; ничего — идентификатор', recordTitle('i', row()) === 'Вентилятор (FAN-1)' && recordTitle('i', { name: 'X' }) === 'X' && recordTitle('i', {}) === 'i');

// ── XML: сравниваются строки, которые видел экран ──
const xmlShown = [
  { targetId: 'E1', targetLabel: 'Вентилятор А', group: 'Параметры', key: 'Расход', current: { value: '100', unit: 'м³/ч' } },
  { targetId: 'E1', targetLabel: 'Вентилятор А', group: 'Параметры', key: 'Давление', current: { value: '5', unit: 'Па' } },
  { targetId: 'E2', targetLabel: 'Клапан Б', group: 'Параметры', key: 'Расход', current: { value: '100', unit: 'м³/ч' } },
];
const live = row({ specs: JSON.stringify({ groups: [{ title: 'Параметры', params: [{ key: 'Расход', value: '300', unit: 'м³/ч' }, { key: 'Давление', value: '5', unit: 'Па' }, { key: 'Скрытая', value: '1', unit: '' }] }] }), name: 'Вентилятор А (поправлен)' });
const xmlRefusal = xmlPlanRefusalOf({ changed: [{ id: 'E1', current: live }, { id: 'E2', current: row({ name: 'Клапан Б', specs: specs('100') }) }], gone: ['E3'] }, xmlShown);
const g1 = xmlRefusal.groups.find((g) => g.title === 'Вентилятор А')!;
check('XML: изменённое значение показано «было → стало»; не изменённое и не показанное экраном — нет', JSON.stringify(g1.changes.filter((c) => c.label.includes('·')).map((c) => [c.label, c.was, c.now]))
  === JSON.stringify([['Параметры · Расход', '100 м³/ч', '300 м³/ч']]), g1);
check('XML: переименование позиции — «Название: было → стало»', g1.changes.some((c) => c.label === 'Название' && c.was === 'Вентилятор А' && c.now === 'Вентилятор А (поправлен)'));
check('XML: позиция, показанные значения которой те же, — «Другие сведения»', xmlRefusal.groups.find((g) => g.title === 'Клапан Б')!.changes[0].label === 'Другие сведения');
check('XML: удалённая позиция — «есть → удалена», без названия — по идентификатору', xmlRefusal.groups.find((g) => g.title === 'E3')!.changes[0].now === 'удалена');

console.log(`\nВСЕ ТЕСТЫ ПРОЙДЕНЫ (${checks})`);
