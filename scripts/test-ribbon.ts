/**
 * Проверка состава лент.
 *
 * Лента объявляется данными (src/lib/ribbon*.ts), и это даёт возможность,
 * которой нет у разметки: состав можно проверить скриптом. Проверяем то, что
 * глазом не удержишь, — что органы не повторяются, что у каждой группы задан
 * вес, что в группе не больше семи органов, что имя значка существует, что
 * «Данные проекта» есть у всех четверых и что схлопывание в узком окне идёт по
 * весу, а не по случайности.
 *
 * Запуск: npx tsx scripts/test-ribbon.ts
 */
import {
  collapseGroups, collapsedWidth, fitTabs, groupWidth, organsOf,
  type RibbonGroup, type RibbonTab,
} from '../src/lib/ribbon';
import { docRibbon } from '../src/lib/ribbonDoc';
import { sheetRibbon } from '../src/lib/ribbonSheet';
import { pdfRibbon } from '../src/lib/ribbonPdf';
import { RIBBON_ICON_NAMES } from '../src/components/ribbon/icons';

let f = 0;
const ok = (n: string, c: boolean, d?: any) =>
  c ? console.log('  ✓', n) : (f++, console.error('  ✗', n, d !== undefined ? JSON.stringify(d) : ''));

const ICONS = new Set(RIBBON_ICON_NAMES);

/** Ленты всех редакторов: имя → вкладки. Пополняется по мере переезда */
const RIBBONS: Record<string, RibbonTab[]> = {
  'Документ': docRibbon(),
  'Таблица': sheetRibbon(),
  'ПДФ': pdfRibbon(),
};

console.log('1. Общие правила состава');
for (const [editor, tabs] of Object.entries(RIBBONS)) {
  const ids = new Set<string>();
  const labels = new Map<string, string>();
  for (const tab of tabs) {
    ok(`${editor} · ${tab.name}: есть группы`, tab.groups.length > 0);
    for (const g of tab.groups) {
      ok(`${editor} · ${tab.name} · ${g.name}: задан вес`, Number.isFinite(g.weight) && g.weight > 0, g.weight);
      ok(`${editor} · ${tab.name} · ${g.name}: не больше семи органов`, g.organs.length <= 7, g.organs.length);
      ok(`${editor} · ${tab.name} · ${g.name}: подпись строчными`, g.name === g.name.toLowerCase(), g.name);
      for (const o of g.organs) {
        if (ids.has(o.id)) ok(`${editor}: команда ${o.id} не повторяется`, false);
        ids.add(o.id);
        if (o.icon) ok(`${editor}: значок «${o.icon}» существует`, ICONS.has(o.icon), o.id);
        // Подпись обязательна там, где орган без неё безымянен: label, big,
        // select. Значок, разделённая кнопка, счётчик и палитра узнаются по
        // виду — им хватает подсказки, но она обязана быть: немых кнопок нет
        if (o.kind === 'label' || o.kind === 'big' || o.kind === 'select') {
          ok(`${editor}: у органа ${o.id} есть подпись`, !!o.label, o.kind);
        } else {
          ok(`${editor}: у органа ${o.id} есть подсказка`, !!o.hint, o.kind);
        }
        if (o.kind === 'select') ok(`${editor}: у списка ${o.id} есть значения`, !!o.options?.length);
        if (o.kind === 'split' || o.kind === 'palette') {
          ok(`${editor}: у палитры ${o.id} есть цвета`, !!o.colors?.length);
        }
      }
      // Крупных кнопок не больше двух подряд: иначе пропадает смысл выделения
      const bigs = g.organs.filter((o) => o.kind === 'big').length;
      ok(`${editor} · ${g.name}: крупных кнопок не больше двух`, bigs <= 2, bigs);
    }
    // Подписи внутри вкладки не повторяются: две «Вставить» рядом — это ловушка
    for (const o of organsOf(tab)) {
      if (!o.label) continue;
      const key = `${tab.name}·${o.label}`;
      if (labels.has(key)) ok(`${editor} · ${tab.name}: подпись «${o.label}» одна`, false, [labels.get(key), o.id]);
      labels.set(key, o.id);
    }
  }
  ok(`${editor}: вкладка «Данные проекта» на месте`, tabs.some((t) => t.name === 'Данные проекта'));
  ok(`${editor}: первая вкладка — «Главная»`, tabs[0]?.name === 'Главная', tabs[0]?.name);
}

console.log('2. Узкое окно: схлопывание идёт по весу');
// По четыре органа в группе: схлопывание должно давать выигрыш, иначе оно
// бессмысленно, и проверять на нём порядок жертв нечего
const four = (p: string) => [0, 1, 2, 3].map((i) => ({
  id: `${p}${i}`, kind: 'icon' as const, icon: 'bold', hint: `${p}${i}`,
}));
const groups: RibbonGroup[] = [
  { name: 'важная', weight: 100, organs: four('a') },
  { name: 'средняя', weight: 50, organs: four('b') },
  { name: 'мелочь', weight: 10, organs: four('c') },
];
const full = groups.reduce((s, g) => s + groupWidth(g), 0);
ok('при достатке места ничего не схлопывается', collapseGroups(groups, full).size === 0);
const one = collapseGroups(groups, full - 1);
ok('первой уходит самая лёгкая', one.has('мелочь') && !one.has('важная'), [...one]);
const two = collapseGroups(groups, collapsedWidth(groups[1]) + collapsedWidth(groups[2]) + groupWidth(groups[0]));
ok('следующей — средняя, важная держится', two.has('средняя') && !two.has('важная'), [...two]);
ok('в нуле ширины схлопывается всё', collapseGroups(groups, 1).size === 3);

console.log('3. Вкладки, не влезшие в полосу');
const names = ['Главная', 'Вставка', 'Разметка', 'Данные проекта', 'Рецензирование', 'Вид'];
const wide = fitTabs(names, 900, 'Главная');
ok('в широком окне видны все', wide.hidden.length === 0, wide.hidden);
const narrow = fitTabs(names, 260, 'Главная');
ok('в узком часть уходит под «▾»', narrow.hidden.length > 0 && narrow.shown.length > 0, narrow);
const chosen = fitTabs(names, 260, 'Рецензирование');
ok('выбранная вкладка остаётся видимой', chosen.shown.includes('Рецензирование'), chosen);
ok('ни одна вкладка не потерялась',
  chosen.shown.length + chosen.hidden.length === names.length,
  [chosen.shown.length, chosen.hidden.length]);

console.log(f === 0 ? '\nВсё сошлось' : `\nОтказов: ${f}`);
process.exit(f === 0 ? 0 : 1);
