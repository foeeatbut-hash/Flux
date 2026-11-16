/**
 * Журнал изменений на клиенте: строка «Изменил» в отказе и строка «Создал» в карточке записи.
 *
 * Без браузера и службы. Четыре половины:
 *   1. Разбор `changedBy` из тела отказа 409 (`conflictOf`, `changedByOf`): автор есть — доходит; нет имени,
 *      `null`, не объект — `null`; код отказа по-прежнему решает, что это отказ по версии.
 *   2. `changedBy` проходит по всем общим путям разбора отказа до того, что рисует окно: проекты,
 *      оборудование, теги, справочник, стол, ВДР (у массового ВДР автора нет — записей несколько).
 *   3. `ConflictNotice`: строка «Изменил: …» между текстом и перечнем; нет автора — строки нет; имя без даты — без даты.
 *   4. «Создал»: разбор ответа `record-origin` (автор и дата, только дата, ничего), сбой запроса — молча `null`,
 *      подставной `fetch` получает модель и id в адресе; карточки пяти программ содержат `RecordOrigin` с нужной моделью.
 *
 * Мутации, которыми набор проверен: не рисовать строку «Изменил» в `ConflictNotice`; не передавать `changedBy`
 * из `conflictOf`; не рисовать «Создал» (`createdByText` отдаёт пустую строку) — набор падает.
 *
 * Запуск: npx tsx scripts/test-record-origin-client.ts
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ConflictNotice from '../src/components/ui/ConflictNotice';
import { changedByOf, conflictOf, VERSION_CONFLICT, type WriteResult } from '../src/components/equipment/versionedWrite';
import { refusalOf as equipmentRefusalOf } from '../src/components/equipment/conflictView';
import { resultOfRefusal, projectRefusalOf } from '../src/components/projects/projectWrite';
import { refusalOf as dictRefusalOf } from '../src/components/dictionary/dictWrite';
import { refusalOf as vdrRefusalOf } from '../src/components/vdr/vdrWrite';
import { refusalOf as tagRefusalOf } from '../src/components/registry/tagRefusal';
import { fileRefusalOf } from '../src/components/desktop/desktopWrite';
import { createdByText, fetchRecordOrigin, originOf } from '../src/lib/recordOrigin';

const root = path.resolve(__dirname, '..');
let passed = 0;
const ok = (name: string, value: unknown) => { assert.ok(value, name); passed++; console.log(`  ✓ ${name}`); };
const same = (name: string, actual: unknown, expected: unknown) => { assert.deepEqual(actual, expected, name); passed++; console.log(`  ✓ ${name}`); };
const html = (props: React.ComponentProps<typeof ConflictNotice>) => renderToStaticMarkup(React.createElement(ConflictNotice, props));
const text = (s: string) => s.replace(/<[^>]+>/g, '');
const dmy = (iso: string) => { const d = new Date(iso); const p = (n: number) => String(n).padStart(2, '0'); return `${p(d.getDate())}.${p(d.getMonth() + 1)}.${d.getFullYear()}`; };
const dmyhm = (iso: string) => { const d = new Date(iso); const p = (n: number) => String(n).padStart(2, '0'); return `${dmy(iso)} ${p(d.getHours())}:${p(d.getMinutes())}`; };

const AT = '2026-11-16T09:30:00.000Z';
const body = (over: Record<string, unknown> = {}) => ({ code: VERSION_CONFLICT, error: 'Проект «Школа №7» изменили.', current: { id: 'p1', name: 'Школа №7', version: 2 }, changedBy: { userId: 'u1', name: 'Иванов И. И.', at: AT }, ...over });

(async () => {
  console.log('1. Разбор changedBy');
  {
    same('автор из тела отказа', changedByOf(body()), { userId: 'u1', name: 'Иванов И. И.', at: AT });
    same('имя без даты — без даты', changedByOf({ changedBy: { name: 'Иванов И. И.' } }), { name: 'Иванов И. И.' });
    for (const [label, b] of [['null', { changedBy: null }], ['нет поля', {}], ['пустое имя', { changedBy: { name: '  ' } }], ['не объект', { changedBy: 'Иванов' }], ['нет тела', null]] as const) {
      same(`${label} — автора нет`, changedByOf(b), null);
    }
    const c = conflictOf(409, body());
    ok('conflictOf несёт автора', c?.changedBy?.name === 'Иванов И. И.' && c.message === 'Проект «Школа №7» изменили.');
    same('conflictOf без автора — null, отказ тот же', conflictOf(409, body({ changedBy: null }))?.changedBy, null);
    ok('без кода отказ по версии не узнаётся, автор не спасает', conflictOf(409, { error: 'x', changedBy: { name: 'Иванов' } }) === null);
  }

  console.log('2. changedBy проходит до окна по всем путям');
  {
    const conflict: WriteResult = { kind: 'conflict', message: 'Изменили.', current: { id: 'x', name: 'N', version: 2 }, changedBy: { name: 'Иванов И. И.', at: AT }, data: {} };
    const name = (r: any) => r?.changedBy?.name;
    ok('оборудование', name(equipmentRefusalOf(conflict, 'component' as any, { id: 'x', name: 'M' }, 'сбой')) === 'Иванов И. И.');
    ok('справочник', name(dictRefusalOf(conflict, { id: 'x', code: 'A', nameRu: 'M' }, { parentName: () => '' } as any, 'сбой')) === 'Иванов И. И.');
    ok('ВДР', name(vdrRefusalOf(conflict, () => [], 'сбой')) === 'Иванов И. И.');
    ok('теги', name(tagRefusalOf(conflict as any, { id: 'x' }, {} as any, 'сбой')) === 'Иванов И. И.');
    ok('стол', name(fileRefusalOf(conflict, { id: 'x', name: 'M' }, { folders: [], name: () => '' } as any, 'сбой')) === 'Иванов И. И.');
    // Проект — через настоящий разбор WriteRefusal: статус и тело целиком
    const viaProject = projectRefusalOf(resultOfRefusal(409, body(), 'сбой'), { id: 'p1', name: 'Школа №5', version: 1 }, 'сбой');
    ok('проект: из тела WriteRefusal до отказа экрана', viaProject?.kind === 'conflict' && viaProject.changedBy?.name === 'Иванов И. И.' && viaProject.changedBy.at === AT);
    same('проект: автора нет — null', (projectRefusalOf(resultOfRefusal(409, body({ changedBy: null }), 'сбой'), { id: 'p1' }, 'сбой') as any).changedBy, null);
  }

  console.log('3. ConflictNotice: строка «Изменил»');
  {
    const out = html({ message: 'Проект изменили.', changedBy: { name: 'Иванов И. И.', at: AT }, changes: [{ label: 'Наименование', was: 'А', now: 'Б' }] });
    ok('строка есть и называет автора с датой и временем', text(out).includes(`Изменил: Иванов И. И., ${dmyhm(AT)}`));
    ok('помечена для проверок', out.includes('data-conflict-changed-by'));
    ok('стоит между текстом отказа и перечнем', out.indexOf('Проект изменили.') < out.indexOf('Изменил:') && out.indexOf('Изменил:') < out.indexOf('data-conflict-changes'));
    ok('оформлена как пояснение (fx-hint), своих цветов нет', /fx-hint[^>]*data-conflict-changed-by/.test(out) && !/style=/.test(out));
    ok('имя без даты — без даты', text(html({ message: 'x', changedBy: { name: 'Иванов И. И.' } })).includes('Изменил: Иванов И. И.') && !/Изменил: Иванов И\. И\.,/.test(text(html({ message: 'x', changedBy: { name: 'Иванов И. И.' } }))));
    for (const [label, v] of [['null', null], ['не передан', undefined], ['пустое имя', { name: ' ' }]] as const) {
      ok(`${label} — строки нет`, !html({ message: 'x', changedBy: v as any }).includes('data-conflict-changed-by'));
    }
    ok('имя — не разметка', !html({ message: 'x', changedBy: { name: '<i>Х</i>' } }).includes('<i>Х</i>'));
  }

  console.log('4. «Создал»: разбор, текст, запрос');
  {
    const full = originOf({ createdBy: { userId: 'u1', name: 'Иванов И. И.' }, createdAt: AT });
    same('автор и дата', createdByText(full), `Создал: Иванов И. И., ${dmy(AT)}`);
    same('нет автора — только дата', createdByText(originOf({ createdBy: null, createdAt: AT })), `Создано: ${dmy(AT)}`);
    same('нет даты — только автор', createdByText(originOf({ createdBy: { userId: 'u1', name: 'Иванов И. И.' }, createdAt: null })), 'Создал: Иванов И. И.');
    same('нет ничего — null и пустая строка', [originOf({ createdBy: null, createdAt: null }), createdByText(originOf({ createdBy: null, createdAt: null }))], [null, '']);
    same('мусор вместо ответа — null', [originOf(null), originOf('x'), originOf({ createdAt: 'не дата' })], [null, null, null]);

    let asked = '';
    const good = await fetchRecordOrigin('Project', 'p 1', async (u) => { asked = u; return new Response(JSON.stringify({ createdBy: { userId: 'u1', name: 'Иванов И. И.' }, createdAt: AT }), { status: 200 }); });
    same('запрос несёт модель и id, закодированные', asked, '/api/record-origin?model=Project&id=p%201');
    same('ответ разобран', good && createdByText(good), `Создал: Иванов И. И., ${dmy(AT)}`);
    same('404 — молча null', await fetchRecordOrigin('Project', 'p1', async () => new Response('{}', { status: 404 })), null);
    same('400 — молча null', await fetchRecordOrigin('Nope', 'p1', async () => new Response('{}', { status: 400 })), null);
    same('сеть оборвалась — молча null, без исключения', await fetchRecordOrigin('Project', 'p1', async () => { throw new Error('net'); }), null);
    same('не JSON — молча null', await fetchRecordOrigin('Project', 'p1', async () => new Response('<html>', { status: 200 })), null);
    same('пустой id — запроса нет', await fetchRecordOrigin('Project', '', async () => { throw new Error('не должен вызываться'); }), null);
  }

  console.log('5. Карточки содержат RecordOrigin');
  {
    const src = (f: string) => fs.readFileSync(path.join(root, f), 'utf8');
    for (const [file, model] of [
      ['src/screens/ProjectsManagement.tsx', 'Project'],
      ['src/components/registry/TagCardModal.tsx', 'Tag'],
      ['src/components/equipment/BlockCard.tsx', 'ComponentElement'],
      ['src/components/vdr/VdrPanel.tsx', 'DocRegisterItem'],
      ['src/screens/DictionaryEditor.tsx', 'DictionaryItem'],
    ] as const) {
      ok(`${file}: <RecordOrigin model="${model}">`, new RegExp(`<RecordOrigin model="${model}" id=\\{`).test(src(file)));
    }
    ok('компонент ничего не рисует без текста', /if \(!text\) return null;/.test(src('src/components/ui/RecordOrigin.tsx')));
  }

  console.log(`record-origin-client: ${passed} проверок прошли`);
})().catch((e) => { console.error(e); process.exitCode = 1; });
