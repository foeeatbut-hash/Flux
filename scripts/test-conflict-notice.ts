/**
 * Общий показ отказа «Поле: было → стало» (src/components/ui/ConflictNotice.tsx).
 *
 * Без браузера: разметка собирается настоящим React на сервере и читается разбором строки.
 * Проверяется: текст отказа, role="alert", по строке на каждое изменение, «было» и «стало» на своих местах,
 * особые случаи (нет перечня, различий в показанном нет), вариант по записям для массовых действий,
 * экранирование (имя записи — не разметка), оформление через токены проекта без своих цветов.
 *
 * Запуск: npx tsx scripts/test-conflict-notice.ts
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ConflictNotice, { NO_SHOWN_CHANGES } from '../src/components/ui/ConflictNotice';

let passed = 0;
const ok = (name: string, value: unknown) => { assert.ok(value, name); passed++; console.log(`  ✓ ${name}`); };
const same = (name: string, actual: unknown, expected: unknown) => { assert.deepEqual(actual, expected, name); passed++; console.log(`  ✓ ${name}`); };
const html = (props: React.ComponentProps<typeof ConflictNotice>) => renderToStaticMarkup(React.createElement(ConflictNotice, props));
const count = (s: string, needle: string) => s.split(needle).length - 1;

console.log('1. Одна запись');
{
  const out = html({ message: 'Позицию «Вентилятор А» изменили, пока вы её правили.', changes: [
    { label: 'Тип', was: '—', now: 'Фильтр · Карманный' }, { label: 'Основные · Расход', was: '1000 м3/ч', now: '2000 м3/ч' },
  ] });
  ok('role="alert"', out.includes('role="alert"'));
  ok('текст отказа показан', out.includes('Позицию «Вентилятор А» изменили, пока вы её правили.'));
  same('по строке на каждое изменение', count(out, '<li '), 2);
  ok('поле, было и стало — каждое на своём месте', /fx-conflict-field">Тип:<\/span><span class="fx-conflict-was">—<\/span>.*?fx-conflict-now">Фильтр · Карманный</.test(out));
  ok('было стоит раньше, чем стало', out.indexOf('1000 м3/ч') < out.indexOf('2000 м3/ч'));
  ok('стрелка не читается диктором, вместо неё слово «стало»', out.includes('aria-hidden="true">→') && out.includes('>стало<'));
  ok('группы нет', !out.includes('data-conflict-group'));
}

console.log('2. Особые случаи');
{
  const none = html({ message: 'Позицию изменили.' });
  ok('перечня нет вовсе (запись удалена, открыта у коллеги) — только текст', none.includes('data-conflict-message') && !none.includes('data-conflict-changes') && !none.includes('data-conflict-empty'));
  const empty = html({ message: 'Позицию изменили.', changes: [] });
  ok('различий в показанном нет — об этом сказано', empty.includes('data-conflict-empty') && empty.includes(NO_SHOWN_CHANGES) && !empty.includes('data-conflict-changes'));
  ok('своя фраза о пустом перечне', html({ message: 'x', changes: [], emptyText: 'Ничего нового.' }).includes('Ничего нового.'));
  const escaped = html({ message: 'x', changes: [{ label: 'Название', was: '<b>А</b>', now: '"Б" & В' }] });
  ok('значения экранируются, разметки из данных нет', !escaped.includes('<b>А</b>') && escaped.includes('&lt;b&gt;А&lt;/b&gt;') && escaped.includes('&amp; В'));
}

console.log('3. По записям (массовые действия)');
{
  const out = html({ message: 'Пока вы смотрели предпросмотр, часть записей изменили.', groups: [
    { title: 'Вентилятор А', changes: [{ label: 'Название', was: 'А', now: 'Б' }, { label: 'Состояние', was: 'OK', now: 'CONFLICT' }] },
    { title: 'Клапан Б', changes: [] },
    { title: 'Фильтр В', changes: [{ label: 'Тег В1', was: '—', now: 'привязан' }] },
  ] });
  same('по группе на запись с различиями, без различий пропускается', count(out, '<section'), 2);
  same('строки внутри групп', count(out, '<li '), 3);
  ok('название записи — заголовок группы', out.includes('>Вентилятор А</h4>') && out.includes('>Фильтр В</h4>') && !out.includes('Клапан Б'));
  ok('ни у одной записи различий нет — об этом сказано', html({ message: 'x', groups: [{ title: 'А', changes: [] }] }).includes(NO_SHOWN_CHANGES));
}

console.log('4. Оформление: токены проекта, обе темы');
{
  const css = fs.readFileSync(path.resolve(__dirname, '../src/index.css'), 'utf8');
  const rules = [...css.matchAll(/\.fx-conflict[a-z-]*[^{]*\{[^}]*\}/g)].map((m) => m[0]).join('\n');
  ok('правила отказа в index.css есть', rules.includes('.fx-conflict {') && rules.includes('.fx-conflict-was'));
  ok('цвета — только токены (var(--flux-…)), своих hex/oklch нет', !/#[0-9a-f]{3,8}\b|oklch\(|rgb\(/i.test(rules));
  ok('кегль не мельче 12 px, жирного нет', !/font-size:\s*(?:[0-9]|1[01])px/.test(rules) && !/font-weight:\s*(?:6|7|8|9)\d\d|bold/.test(rules.replace(/font-weight: 500/g, '')));
}

console.log(`\nПройдено проверок: ${passed}`);
