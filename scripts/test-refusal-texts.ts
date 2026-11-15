/**
 * Словарь отказов (src/lib/refusalTexts.ts): каждая строка таблицы решения —
 * точный текст, код в текст не попадает, слово «компания» не пишется, любое
 * существительное словаря даёт целые тексты без дыр.
 *
 * Мутации, которыми набор проверен (каждая роняет его):
 *  • убрать случай — функция текста возвращает пустую строку;
 *  • вставить код отказа в текст.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  VERSION_CONFLICT, RECORD_GONE, RECORD_OPEN, NOUNS,
  editChangedText, deleteChangedText, createInsideChangedText, bulkChangedText,
  editGoneText, createInsideGoneText, deleteGoneText, deleteOpenText, deleteOpenNestedText,
  racedText, nothingChangedText, openCheckUnavailableText, type RefusalNoun,
} from '../src/lib/refusalTexts.js';

let checks = 0;
const same = (label: string, actual: unknown, expected: unknown) => {
  assert.deepEqual(actual, expected, label);
  checks++;
  console.log(`✓ ${label}`);
};
const check = (label: string, ok: unknown, detail?: unknown) => {
  assert.ok(ok, `${label}${detail === undefined ? '' : `: ${JSON.stringify(detail)}`}`);
  checks++;
  console.log(`✓ ${label}`);
};

const ivanov = [{ userId: 'u1', name: 'Иванов И. И.' }];

// Коды — те, что клиент и сервер договорились слать
same('коды отказов', [VERSION_CONFLICT, RECORD_GONE, RECORD_OPEN], ['VERSION_CONFLICT', 'RECORD_GONE', 'RECORD_OPEN']);

// Таблица раздела 3 решения, строка за строкой
same('правка изменённой', editChangedText('position', 'X'),
  'Позицию «X» изменили, пока вы её правили. Ваша правка не записана и осталась на месте. Ниже — что изменилось.');
same('удаление изменённой', deleteChangedText('position', 'X'),
  'Позицию «X» изменили после того, как вы её открыли, поэтому она не удалена. Ниже — что изменилось. Если удалить всё равно нужно — повторите.');
same('создание внутри изменённого', createInsideChangedText('system', 'X'),
  'Установку «X», в которую вы добавляете, изменили. Новая запись не создана, введённое осталось в окне. Ниже — что изменилось.');
same('массовое действие', bulkChangedText(),
  'Пока вы смотрели предпросмотр, часть записей изменили. Ничего не записано. Ниже — что изменилось; проверьте и подтвердите заново.');
same('правка удалённой', editGoneText('position', 'X'), 'Позицию «X» уже удалили. Ваша правка не записана.');
same('создание внутри удалённого', createInsideGoneText('system'), 'Установку, в которую вы добавляете, уже удалили. Новая запись не создана.');
same('удаление удалённой', deleteGoneText('position'), 'Позиция уже удалена.');
same('удаление открытой', deleteOpenText('position', 'X', ivanov),
  'Позиция «X» сейчас открыта у сотрудника: Иванов И. И. Удалить её нельзя, пока запись открыта.');
same('удаление, открыто вложенное', deleteOpenNestedText({ noun: 'system', name: 'X' }, { noun: 'position', name: 'Y' }, ivanov),
  'В установке «X» сейчас открыта позиция «Y» у сотрудника: Иванов И. И. Удалить установку нельзя, пока запись открыта.');
same('одновременная запись без версии', racedText(), 'Запись меняют одновременно, повторите действие.');
same('не удалось проверить открытые записи', openCheckUnavailableText(),
  'Не удалось проверить, открыта ли запись у других сотрудников. Ничего не удалено — повторите позже.');
same('различий в показанном нет', nothingChangedText(), 'Изменения не затронули то, что показано на экране.');

// Мужской род: блок — «открыт», «его», «не удалён», «в который»
same('блок: удаление открытого', deleteOpenText('block', 'B1', ivanov),
  'Блок «B1» сейчас открыт у сотрудника: Иванов И. И. Удалить его нельзя, пока запись открыта.');
same('блок: удаление изменённого', deleteChangedText('block', 'B1'),
  'Блок «B1» изменили после того, как вы его открыли, поэтому он не удалён. Ниже — что изменилось. Если удалить всё равно нужно — повторите.');
same('блок: создание внутри изменённого', createInsideChangedText('block', 'B1'),
  'Блок «B1», в который вы добавляете, изменили. Новая запись не создана, введённое осталось в окне. Ниже — что изменилось.');
same('блок: удаление удалённого', deleteGoneText('block'), 'Блок уже удалён.');

// Несколько человек, никого, пустое название
same('открыта у нескольких', deleteOpenText('position', 'X', [{ name: 'Иванов И. И.' }, { name: 'Петрова А. А.' }, { name: 'Иванов И. И.' }]),
  'Позиция «X» сейчас открыта у сотрудников: Иванов И. И., Петрова А. А. Удалить её нельзя, пока запись открыта.');
same('открыта, имён нет', deleteOpenText('position', 'X', [{ name: '  ' }]),
  'Позиция «X» сейчас открыта у другого сотрудника. Удалить её нельзя, пока запись открыта.');
same('без названия — без пустых кавычек', editChangedText('position', '  '),
  'Позицию изменили, пока вы её правили. Ваша правка не записана и осталась на месте. Ниже — что изменилось.');
check('нет названия — нет кавычек', !editChangedText('position', undefined).includes('«'));

// Любое слово словаря даёт целые тексты: следующая программа добавляет строку в NOUNS и ничего больше
const FORBIDDEN = /VERSION_CONFLICT|RECORD_GONE|RECORD_OPEN|компани|undefined|NaN|\[object/i;
for (const noun of Object.keys(NOUNS) as RefusalNoun[]) {
  const texts = [
    editChangedText(noun, 'N'), deleteChangedText(noun, 'N'), createInsideChangedText(noun, 'N'),
    editGoneText(noun, 'N'), createInsideGoneText(noun), deleteGoneText(noun),
    deleteOpenText(noun, 'N', ivanov), deleteOpenNestedText({ noun, name: 'N' }, { noun, name: 'M' }, ivanov),
    bulkChangedText(), racedText(), nothingChangedText(), openCheckUnavailableText(),
  ];
  check(`«${noun}»: тексты целые, непустые и без кода`, texts.every((t) => t.length > 12 && !FORBIDDEN.test(t)), texts.filter((t) => t.length <= 12 || FORBIDDEN.test(t)));
  check(`«${noun}»: тексты начинаются с большой буквы и кончаются точкой`, texts.every((t) => /^[А-ЯЁ]/.test(t) && /[.]$/.test(t)), texts);
}

// Слово «компания» не пишется нигде в словаре (владелец: программа ещё не внедрена)
check('в словаре нет слова «компания»', !/компани/i.test(fs.readFileSync('src/lib/refusalTexts.ts', 'utf8')));

console.log(`\nПроверок: ${checks}`);
