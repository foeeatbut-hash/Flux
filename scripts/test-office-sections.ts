/**
 * Переименование не должно ничего отнимать у сотрудника.
 *
 * «Конструктор» разделён на две программы семьи Flux Office — «Таблицу» и
 * «Документ», — а путь раздела записан у каждого человека в его открытых
 * окнах, в значках стола и в закреплённых кнопках панели задач. Неизвестный
 * путь реестр молча уводит на Главную: если бы перевода не было, у людей
 * после обновления пропали бы окна и значки, и виноватым выглядело бы
 * обновление.
 *
 * Разбором кода это не ловится — там всё выглядит правильным, пока не
 * прочитаешь чужой localStorage.
 *
 * Запуск: npx tsx scripts/test-office-sections.ts
 */
import { resolveSectionPath, resolveSectionHref } from '../src/lib/sectionAliases';
import { SECTIONS, sectionForPath, isKnownSection, scopeForPath } from '../src/workspace/sections';
import { OFFICE_PATHS, OFFICE_TITLE, groupSections } from '../src/lib/startMenu';
import { officePathForKind, officeKindForPath, officePathOf, officePathForName } from '../src/lib/fileTypes';

let failed = 0;
const check = (name: string, cond: boolean, got?: unknown) => {
  if (cond) { console.log('  ✓', name); return; }
  failed++;
  console.error(`  ✗ ${name}${got === undefined ? '' : ` — получили ${JSON.stringify(got)}`}`);
};

console.log('1. Семья Flux Office собрана из четырёх программ');
{
  const titles = OFFICE_PATHS.map((p) => sectionForPath(p).title);
  check('в семье четыре программы', OFFICE_PATHS.length === 4, OFFICE_PATHS);
  check('и все они существуют', OFFICE_PATHS.every((p) => isKnownSection(p)), titles);
  check('имена в одно слово', titles.join(', ') === 'Таблица, Документ, Блокнот, Просмотр', titles);
  check('семья названа латиницей', OFFICE_TITLE === 'Flux Office', OFFICE_TITLE);

  const sheet = sectionForPath('/sheet');
  const doc = sectionForPath('/doc');
  check('«Таблица» заводит книги', sheet.docKind === 'DOC', sheet.docKind);
  check('«Документ» заводит тексты', doc.docKind === 'TEXT', doc.docKind);
  check('у программ разные значки', sheet.icon !== doc.icon);
  check('обе открываются несколькими окнами', !!sheet.multi && !!doc.multi);
  check('обе — про данные проекта', scopeForPath('/sheet') === 'project' && scopeForPath('/doc') === 'project');

  // Раздела «Конструктор» больше нет: если он остался, значит переименование
  // сделано наполовину и в Пуске будет два входа в одно и то же
  check('раздела «Конструктор» не осталось',
    !SECTIONS.some((s) => s.title === 'Конструктор' || s.path === '/constructor'),
    SECTIONS.map((s) => s.path));
}

console.log('2. Старый путь переводится, а не выбрасывается');
{
  check('старый раздел ведёт в «Таблицу»', resolveSectionPath('/constructor') === '/sheet');
  check('чужой путь не трогаем', resolveSectionPath('/registry') === '/registry');
  check('неизвестный путь остаётся собой', resolveSectionPath('/wat') === '/wat');

  // Окно помнит АДРЕС, а не раздел: документ должен доехать вместе с ним
  check('адрес документа переезжает целиком',
    resolveSectionHref('/constructor?doc=42') === '/sheet?doc=42',
    resolveSectionHref('/constructor?doc=42'));
  check('и с решёткой тоже',
    resolveSectionHref('/constructor#низ') === '/sheet#низ', resolveSectionHref('/constructor#низ'));
  check('адрес чужого раздела не портится',
    resolveSectionHref('/explorer?folder=x') === '/explorer?folder=x');

  // Ровно та поломка, ради которой перевод и заведён
  check('сохранённое окно открывает «Таблицу», а не Главную',
    sectionForPath('/constructor').title === 'Таблица', sectionForPath('/constructor').title);
  check('и считается известным разделом', isKnownSection('/constructor'));
}

console.log('3. Документ открывается СВОЕЙ программой');
{
  check('книга — Таблицей', officePathForKind('DOC') === '/sheet');
  check('шаблон книги — тоже Таблицей', officePathForKind('TEMPLATE') === '/sheet');
  check('текст — Документом', officePathForKind('TEXT') === '/doc');
  check('заметка — Документом', officePathForKind('NOTE') === '/doc');
  check('вид неизвестен — открываем Таблицей', officePathForKind(undefined) === '/sheet');

  check('зеркало текста ведёт в «Документ»',
    officePathOf({ id: '1', filePath: '/doc/abc' }) === '/doc');
  check('зеркало книги ведёт в «Таблицу»',
    officePathOf({ id: '1', filePath: '/sheet/abc' }) === '/sheet');
  check('зеркало прежних версий ведёт в «Таблицу»',
    officePathOf({ id: '1', filePath: '/constructor/abc' }) === '/sheet');

  check('принесённый xlsx открывает Таблица', officePathForName('Смета.xlsx') === '/sheet');
  check('принесённый docx открывает Документ', officePathForName('Записка.docx') === '/doc');

  check('программа знает, что заводит', officeKindForPath('/sheet') === 'DOC');
  check('и вторая тоже', officeKindForPath('/doc') === 'TEXT');
  check('с параметрами в адресе — так же', officeKindForPath('/doc?doc=7') === 'TEXT');
}

console.log('4. Пуск показывает семью одной группой');
{
  const src = SECTIONS.map((s) => ({
    path: s.path, title: s.title, scope: s.scope, adminOnly: s.adminOnly, feature: s.feature,
  }));
  const groups = groupSections(src as any, true);
  const office = groups.find((g) => g.id === 'office');
  check('группа семьи есть', !!office);
  check('и называется Flux Office', office?.title === 'Flux Office', office?.title);
  check('в ней те же четыре программы',
    office?.items.map((i) => i.path).join(',') === OFFICE_PATHS.join(','),
    office?.items.map((i) => i.path));
  // Программа не должна попасть и в семью, и в «Проект»: два входа в одно
  const rest = groups.filter((g) => g.id !== 'office').flatMap((g) => g.items.map((i) => i.path));
  check('и ни одна не задвоилась в других группах',
    OFFICE_PATHS.every((p) => !rest.includes(p)), rest);
}

console.log(failed === 0 ? '\nВсе проверки семьи Flux Office пройдены' : `\nПровалено: ${failed}`);
process.exit(failed === 0 ? 0 : 1);
