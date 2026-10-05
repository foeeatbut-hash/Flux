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
import { SECTIONS, sectionForPath, isKnownSection } from '../src/workspace/sections';
import { OFFICE_PATHS, OFFICE_TITLE, groupSections } from '../src/lib/startMenu';
import { openHref } from '../src/lib/fileTypes';

let failed = 0;
const check = (name: string, cond: boolean, got?: unknown) => {
  if (cond) { console.log('  ✓', name); return; }
  failed++;
  console.error(`  ✗ ${name}${got === undefined ? '' : ` — получили ${JSON.stringify(got)}`}`);
};

console.log('1. Файловые редакторы доступны по своим маршрутам, но не как программы');
{
  const filePaths = ['/doc', '/sheet', '/pdf', '/archives'];
  check('четыре файловых маршрута существуют', filePaths.every((p) => isKnownSection(p)), filePaths);
  check('Документ, Таблица, PDF и Архив помечены fileOnly',
    filePaths.every((p) => sectionForPath(p).fileOnly), filePaths.map((p) => [p, sectionForPath(p).fileOnly]));
  check('имена файловых окон сохранены',
    filePaths.map((p) => sectionForPath(p).title).join(',') === 'Документ,Таблица,PDF,Архив',
    filePaths.map((p) => sectionForPath(p).title));
  check('офисные адреса сохранены для совместимости',
    OFFICE_PATHS.join(',') === '/sheet,/doc,/notes,/pdf', OFFICE_PATHS);
  check('Блокнот остаётся обычным разделом',
    isKnownSection('/notes') && !sectionForPath('/notes').fileOnly && sectionForPath('/notes').title === 'Блокнот');
  check('Блокнот входит в Общее',
    groupSections(SECTIONS as any, true).some((g) => g.id === 'global' && g.items.some((s) => s.path === '/notes')));

  // Старого редактора «Конструктор» больше нет: если он остался, значит
  // переименование сделано наполовину и в Пуске будет два входа в одно и то же.
  // Имя «Конструктор» с тех пор носит другая программа — подбор оборудования
  // (/builder), — поэтому проверяется не слово, а старый путь и то, что под
  // этим именем не спрятан редактор книг
  check('старого пути /constructor не осталось', !SECTIONS.some((s) => s.path === '/constructor'), SECTIONS.map((s) => s.path));
  check('«Конструктор» — не редактор книг семьи Office',
    !SECTIONS.some((s) => s.title === 'Конструктор' && OFFICE_PATHS.includes(s.path)),
    SECTIONS.filter((s) => s.title === 'Конструктор').map((s) => s.path));
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

console.log('3. Файл и старые адреса открываются по сохранённым маршрутам');
{
  check('книга — Таблицей', openHref({ id: '1', name: 'Смета.xlsx' }).startsWith('/office-sheet?file='));
  check('документ Word — Документом', openHref({ id: '1', name: 'Записка.docx' }).startsWith('/office-doc?file='));
  check('PDF — редактор PDF', openHref({ id: '1', name: 'Чертёж.pdf' }).startsWith('/pdf?file='));
  check('архив — архивное окно', openHref({ id: '1', name: 'Данные.zip' }).startsWith('/archives?file='));
  check('заметка Markdown — Блокнотом', openHref({ id: '1', name: 'Заметка.md' }).startsWith('/notes?file='));
  check('ссылки на старые записи Конструктора (?doc=) не рождаются',
    !['Смета.xlsx', 'Записка.docx', 'Старая.xls'].some((n) => /[?&]doc=/.test(openHref({ id: '1', name: n, refId: 'x' }))));
}

console.log('4. Пуск не показывает fileOnly как самостоятельные программы');
{
  const src = SECTIONS.map((s) => ({
    path: s.path, title: s.title, scope: s.scope, adminOnly: s.adminOnly, feature: s.feature, fileOnly: s.fileOnly,
  }));
  const groups = groupSections(src as any, true);
  const filePaths = ['/doc', '/sheet', '/pdf', '/archives'];
  const allPaths = groups.flatMap((g) => g.items.map((i) => i.path));
  check('группа Flux Office исчезла', !groups.some((g) => g.id === 'office' || g.title === OFFICE_TITLE), groups.map((g) => g.title));
  check('четыре файловых раздела отсутствуют в группах', filePaths.every((p) => !allPaths.includes(p)), allPaths);
  check('поиск не находит самостоятельные файловые программы',
    filePaths.every((p) => !groupSections(src as any, true, sectionForPath(p).title).flatMap((g) => g.items).some((s) => s.path === p)));
  check('Блокнот показывается среди общих разделов',
    groups.some((g) => g.id === 'global' && g.items.some((s) => s.path === '/notes')));
}

console.log(failed === 0 ? '\nВсе проверки семьи Flux Office пройдены' : `\nПровалено: ${failed}`);
process.exit(failed === 0 ? 0 : 1);
