/**
 * «Нет данных»: места, где E3Flux не хватает данных (docs/e3-integration.md,
 * этап B; слова владельца: классификатор и атрибуты обновляются постоянно, а
 * разделу с ошибками надо указывать места и вести сразу на них).
 *
 * Ничего не хранится: список каждый раз считается заново из текущих книг и
 * позиций проекта, поэтому он не может отстать от данных. Логика не
 * дублируется — источник атрибута даёт `sourceFor`, подбор — `selectSolution`,
 * состав блока — `buildRecipeFor`, строка IO — `findIoRow`; здесь они только
 * сведены в один список. Модуль чистый: без React, сервера и сети.
 */
import { attributesForClass, sourceFor, type E3AttributeBook } from './attributes';
import { findIoRow } from './ioTable';
import { buildRecipeFor } from './recipe';
import { normText } from './solutionDefaults';
import { selectSolution } from './solutionSelect';
import type { E3Position, E3Profile, E3SolutionBook } from './solutionTypes';
import { CLASSES, classTitle } from '../equipment/classes';

/** error — блок или подбор не работают; warn — работают, но не до конца; info — справка, чинить не нужно */
export type GapSeverity = 'error' | 'warn' | 'info';
export type GapGroup = 'attributes' | 'catalog' | 'project';
export type GapKind =
  | 'attr-no-source'
  | 'io-row-no-component' | 'solution-unconfirmed' | 'feature-no-rule' | 'class-no-type' | 'class-info' | 'rule-dangling'
  | 'position-no-solution' | 'position-unanswered' | 'position-recipe' | 'position-attr-missing';

export const GAP_GROUP: Record<GapKind, GapGroup> = {
  'attr-no-source': 'attributes',
  'io-row-no-component': 'catalog', 'solution-unconfirmed': 'catalog', 'feature-no-rule': 'catalog', 'class-no-type': 'catalog', 'class-info': 'catalog', 'rule-dangling': 'catalog',
  'position-no-solution': 'project', 'position-unanswered': 'project', 'position-recipe': 'project', 'position-attr-missing': 'project',
};
export const GAP_KIND_TITLES: Record<GapKind, string> = {
  'attr-no-source': 'Нет источника значения', 'io-row-no-component': 'Строка IO без изделия E3', 'solution-unconfirmed': 'Признаки не подтверждены',
  'feature-no-rule': 'Признак без правила', 'class-no-type': 'Класс без типа Flux', 'class-info': 'Справка: класс без типа', 'rule-dangling': 'Правило ссылается на несуществующее',
  'position-no-solution': 'Нет решения', 'position-unanswered': 'Нужен ответ на признак', 'position-recipe': 'Замечания к составу блока', 'position-attr-missing': 'Нет значений атрибутов',
};

/**
 * Куда вести. Каталог и справочник — вкладка, раздел и запись (`cls` — тип Flux
 * в виде «По типам»); позиция проекта — её id и вид, в котором её открыть.
 */
export type GapWhere =
  | { tab: 'book' | 'solutions'; section?: string; id?: string; cls?: string }
  | { positionId: string; view: 'selection' | 'attributes' };

export interface Gap {
  kind: GapKind;
  severity: GapSeverity;
  where: GapWhere;
  /** Что: запись, у которой не хватает данных */
  title: string;
  /** Почему и что сделать */
  detail: string;
  /** Где словами: «Справочник атрибутов · По типам · Двигатель» */
  place: string;
  /** Устойчивый ключ строки списка: одинаков при каждом пересчёте */
  key: string;
}

/** Позиция проекта с готовым подбором соседей и списком атрибутов «Да», у которых в проекте нет значения */
export interface GapPosition {
  id: string;
  label: string;
  position: E3Position;
  siblings: E3Position[];
  /** Имена атрибутов с «Да» без значения — их считает та же функция, что красит ячейки «Атрибутов проекта» */
  missingAttrs: string[];
}

export interface GapInput {
  attributes?: E3AttributeBook | null;
  solutionBook?: E3SolutionBook | null;
  positions?: GapPosition[];
  profile?: E3Profile;
}

/** Класс файла, у которого типа Flux нет по решению владельца: показывается справкой */
const NO_TYPE_BY_DESIGN = new Set(['воздуховод']);

const SEVERITY_ORDER: Record<GapSeverity, number> = { error: 0, warn: 1, info: 2 };

export function collectGaps(input: GapInput): Gap[] {
  const out: Gap[] = [];
  if (input.attributes) attributeGaps(input.attributes, out);
  const book = input.solutionBook;
  if (book) catalogGaps(book, out);
  if (input.positions?.length) projectGaps(input.positions, book || null, input.profile || {}, out);
  // Стабильный порядок: сперва тяжёлое, дальше как нашли (книги и позиции уже упорядочены)
  return out.map((g, i) => ({ g, i })).sort((a, b) => SEVERITY_ORDER[a.g.severity] - SEVERITY_ORDER[b.g.severity] || a.i - b.i).map((x) => x.g);
}

/** Сколько ошибок и предупреждений (справка не считается): число в названии вкладки */
export const gapCount = (gaps: Gap[]): number => gaps.filter((g) => g.severity !== 'info').length;

// ── Справочник атрибутов ────────────────────────────────────────────────────

function attributeGaps(book: E3AttributeBook, out: Gap[]): void {
  const items = (book.items || []).filter((a) => !a.removed);
  for (const c of CLASSES) {
    for (const a of attributesForClass(items, c.id)) {
      if (!a.fromFlux || sourceFor(a, c.id).kind !== 'none') continue;
      out.push({
        kind: 'attr-no-source', severity: 'warn', key: `attr:${c.id}:${a.name}`,
        where: { tab: 'book', section: 'byClass', id: a.name, cls: c.id },
        title: a.name, place: `Справочник атрибутов · По типам · ${c.title}`,
        detail: `Для типа «${c.title}» нет источника значения: задайте характеристику или поле позиции, иначе значение вводит инженер КИП`,
      });
    }
  }
}

// ── Каталог решений ─────────────────────────────────────────────────────────

function catalogGaps(book: E3SolutionBook, out: Gap[]): void {
  const live = (book.solutions || []).filter((s) => !s.removed);
  const features = book.features || [];
  const table = book.ioTable || [];
  const hasFeature = (mainClass: string, id: string) => features.some((f) => f.mainClass === mainClass && f.id === id);
  const featureTitle = (id: string) => features.find((f) => f.id === id)?.title || id;

  // Строки IO, которые берут правила состава и ручной состав, и кто именно их берёт
  const usedBy = new Map<string, Set<string>>();
  const use = (rowId: string, who: string) => { if (!usedBy.has(rowId)) usedBy.set(rowId, new Set()); usedBy.get(rowId)!.add(who); };

  if ((book.ioRules || []).length && !table.length) {
    out.push({
      kind: 'rule-dangling', severity: 'error', key: 'io-table-empty', where: { tab: 'solutions', section: 'io' },
      title: 'Таблица IO', place: 'Типовые решения · Таблица IO',
      detail: `Таблица IO не загружена, а правил состава ${book.ioRules.length}: сигналов блока не посчитать. Загрузите лист «Таблица IO»`,
    });
  } else {
    for (const r of book.ioRules || []) {
      const found = findIoRow(table, r.row);
      if (found.row) use(found.row.id, r.title);
      else out.push({
        kind: 'rule-dangling', severity: 'error', key: `io-rule-row:${r.id}`, where: { tab: 'solutions', section: 'io-rules', id: r.id },
        title: r.title, place: 'Типовые решения · Таблица IO · Правила состава', detail: found.issue || 'Строка таблицы IO не найдена',
      });
      const missing = [...r.when.map((c) => c.feature), ...(r.count.kind === 'feature' ? [r.count.feature] : [])].filter((f) => !hasFeature(r.mainClass, f));
      for (const f of [...new Set(missing)]) {
        out.push({
          kind: 'rule-dangling', severity: 'error', key: `io-rule-feature:${r.id}:${f}`, where: { tab: 'solutions', section: 'io-rules', id: r.id },
          title: r.title, place: 'Типовые решения · Таблица IO · Правила состава',
          detail: `Правило ссылается на признак «${f}», которого нет у класса «${r.mainClass}»: условие никогда не выполнится`,
        });
      }
    }
  }
  for (const s of live) {
    for (const l of s.recipeOverride || []) {
      const found = findIoRow(table, l.row);
      if (found.row) use(found.row.id, `ручной состав ${s.id}`);
      else out.push({
        kind: 'rule-dangling', severity: 'error', key: `override:${s.id}:${l.role}`, where: { tab: 'solutions', section: 'solutions', id: s.id },
        title: `${s.id} · ${s.name}`, place: 'Типовые решения · Решения · Состав блока вручную', detail: `${l.role}: ${found.issue || 'строка таблицы IO не найдена'}`,
      });
    }
  }
  for (const r of book.rules || []) {
    if (r.featureId !== '@class' && !hasFeature(r.mainClass, r.featureId)) {
      out.push({
        kind: 'rule-dangling', severity: 'error', key: `rule:${r.mainClass}|${r.featureId}`, where: { tab: 'solutions', section: 'rules', id: `${r.mainClass}|${r.featureId}` },
        title: `${r.mainClass} · ${r.featureId}`, place: 'Типовые решения · Правила',
        detail: `Правило подбора ОВ даёт ответ на признак «${r.featureId}», которого нет у класса «${r.mainClass}»`,
      });
    }
  }

  for (const row of table) {
    const who = usedBy.get(row.id);
    if (who && !row.component?.trim()) {
      out.push({
        kind: 'io-row-no-component', severity: 'error', key: `io-row:${row.id}`, where: { tab: 'solutions', section: 'io', id: row.id },
        title: row.name, place: `Типовые решения · Таблица IO · ${row.group || 'Строки'}`,
        detail: `Не задано имя изделия E3, а строку берёт состав блока (${[...who].slice(0, 3).join('; ')}${who.size > 3 ? `; ещё ${who.size - 3}` : ''}): блок соберётся без изделия`,
      });
    }
  }

  for (const s of live) {
    if (!s.featuresConfirmed) {
      out.push({
        kind: 'solution-unconfirmed', severity: 'warn', key: `sol:${s.id}`, where: { tab: 'solutions', section: 'solutions', id: s.id },
        title: `${s.id} · ${s.name}`, place: `Типовые решения · Решения · ${s.mainClass}`,
        detail: 'Признаки решения разобраны по названию и не подтверждены: проверьте разбор и подтвердите его в карточке',
      });
    }
  }

  for (const f of features) {
    if (f.kind === 'ov' && !(book.rules || []).some((r) => r.mainClass === f.mainClass && r.featureId === f.id)) {
      out.push({
        kind: 'feature-no-rule', severity: 'warn', key: `feat:${f.mainClass}|${f.id}`, where: { tab: 'solutions', section: 'features', id: f.id },
        title: `${f.title || f.id}`, place: `Типовые решения · Признаки · ${f.mainClass}`,
        detail: `Признак «${featureTitle(f.id)}» берётся из подбора ОВ, но правила для него нет: ответ придётся давать вручную у каждой позиции`,
      });
    }
  }

  const mapped = new Set(Object.values(book.classMap || {}).flat().map(normText));
  const fileClasses = [...new Set([...live.map((s) => s.mainClass), ...features.map((f) => f.mainClass)].filter(Boolean))];
  for (const c of fileClasses) {
    if (mapped.has(normText(c))) continue;
    const byDesign = NO_TYPE_BY_DESIGN.has(normText(c));
    out.push({
      kind: byDesign ? 'class-info' : 'class-no-type', severity: byDesign ? 'info' : 'warn', key: `class:${c}`, where: { tab: 'solutions', section: 'classmap' },
      title: c, place: 'Типовые решения · Типы и классы',
      detail: byDesign ? 'У этого класса нет типа Flux — так решено: решения класса позициям проекта не подбираются' : 'Ни один тип Flux не связан с этим классом файла: его решения не подбираются ни одной позиции',
    });
  }
}

// ── Проект ──────────────────────────────────────────────────────────────────

function projectGaps(positions: GapPosition[], book: E3SolutionBook | null, profile: E3Profile, out: Gap[]): void {
  for (const gp of positions) {
    const label = gp.label || '—';
    const type = classTitle(gp.position.cls);
    const sel = book && ((book.classMap || {})[gp.position.cls] || []).length ? selectSolution(gp.position, gp.siblings, book, profile) : null;
    if (book && sel) {
      if (sel.status === 'none') {
        out.push({
          kind: 'position-no-solution', severity: 'error', key: `pos-none:${gp.id}`, where: { positionId: gp.id, view: 'selection' },
          title: label, place: `Подбор по проекту · ${type}`,
          detail: sel.nearest.length ? `Типового решения нет; ближайшее — ${sel.nearest[0].solution.id} (${sel.nearest[0].diff.length} отличий)` : 'Типового решения нет: в каталоге нет решений для этих ответов',
        });
      } else if (sel.status === 'many') {
        const f = (book.features || []).find((x) => x.id === sel.missingFeature);
        out.push({
          kind: 'position-unanswered', severity: 'warn', key: `pos-many:${gp.id}`, where: { positionId: gp.id, view: 'selection' },
          title: label, place: `Подбор по проекту · ${type}`,
          detail: `Подходит ${sel.candidates.length} решений, не хватает ответа на признак «${sel.missingFeature === '@class' ? 'класс' : f?.title || sel.missingFeature || '?'}»`,
        });
      } else if (sel.solution) {
        const recipe = buildRecipeFor(sel.solution, gp.position, gp.siblings, book);
        if (recipe.issues.length) {
          out.push({
            kind: 'position-recipe', severity: 'warn', key: `pos-recipe:${gp.id}`, where: { positionId: gp.id, view: 'selection' },
            title: label, place: `Подбор по проекту · ${type} · ${sel.solution.id}`, detail: recipe.issues.join('; '),
          });
        }
      }
    }
    if (gp.missingAttrs.length) {
      out.push({
        kind: 'position-attr-missing', severity: 'warn', key: `pos-attr:${gp.id}`, where: { positionId: gp.id, view: 'attributes' },
        title: label, place: `Атрибуты проекта · ${type}`,
        detail: `Нет значений: ${gp.missingAttrs.slice(0, 4).join(', ')}${gp.missingAttrs.length > 4 ? ` и ещё ${gp.missingAttrs.length - 4}` : ''} (${gp.missingAttrs.length})`,
      });
    }
  }
}
