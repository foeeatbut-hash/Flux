/**
 * Рецепт блока: какие изделия E3 стоят в типовом решении и сколько сигналов
 * DI/DO/AI/AO они дают (docs/e3-integration.md, 5.4 и 5.9).
 *
 * Готовых блоков (.e3p) по классификатору нет, поэтому блок Flux собирает сам:
 * правила связи (`book.ioRules`) переводят ответы решения на признаки в строки
 * таблицы IO, а те дают счёт сигналов. Вставляется один блок: его имя в базе
 * E3 — название схемы решения (`E3Solution.name`), отдельного имени изделия
 * нет. Ничего не выдумывается: нет подходящей строки, не задан признак —
 * это замечание в `issues`, а не молчаливая догадка. Ручной состав у решения
 * (`recipeOverride`) сильнее правил.
 *
 * Модуль чистый: без React, без сервера, без сети.
 */
import { addSignals, emptySignals, findIoRow, refIsEmpty, signalsText } from './ioTable';
import { normText } from './solutionDefaults';
import type {
  E3IoCond, E3IoRow, E3IoRowRef, E3IoRule, E3IoSignals, E3Position, E3Recipe, E3RecipeItem, E3RecipeLine, E3Selection, E3Solution, E3SolutionBook,
} from './solutionTypes';

const isNum = (s: string): boolean => String(s).trim() !== '' && Number.isFinite(Number(String(s).replace(',', '.')));
const sameValue = (a: string, b: string): boolean => (isNum(a) && isNum(b) ? Number(String(a).replace(',', '.')) === Number(String(b).replace(',', '.')) : normText(a) === normText(b));

const noRecipe = (solutionId: string, issues: string[], block = ''): E3Recipe => ({ solutionId, block, items: [], total: emptySignals(), issues });
const signalsOf = (r: E3IoRow): E3IoSignals => ({ di: r.di, do: r.do, ai: r.ai, ao: r.ao });

/** Подпозиции роли у позиции: те же, что видит подбор решения (по тегу владельца) */
function childrenOf(position: E3Position, siblings: E3Position[], role: string): E3Position[] {
  return position.tag ? siblings.filter((s) => s.id !== position.id && s.parentTag === position.tag && s.role === role) : [];
}

/** Рецепт по подобранному решению. Решение не выбрано — рецепта нет, и в замечании сказано, чего не хватает */
export function buildRecipe(selection: E3Selection, position: E3Position, siblings: E3Position[], book: E3SolutionBook): E3Recipe {
  if (selection.status === 'one' && selection.solution) return buildRecipeFor(selection.solution, position, siblings, book);
  return noRecipe('', [selection.status === 'many'
    ? 'Решение ещё не выбрано: подходит несколько, нужен ответ на признак — состав блока посчитать нельзя'
    : 'Решения нет: состав блока посчитать нельзя']);
}

export function buildRecipeFor(solution: E3Solution, position: E3Position, siblings: E3Position[], book: E3SolutionBook): E3Recipe {
  const issues: string[] = [];
  const table = book.ioTable || [];
  const title = (id: string) => (book.features || []).find((f) => f.id === id)?.title || id;
  const out: E3RecipeItem[] = [];

  const override = solution.recipeOverride?.length ? solution.recipeOverride : null;
  const block = solution.name.trim();
  if (!block) issues.push('У решения нет названия схемы: оно служит именем блока в E3, вставлять нечего');
  const rules = (book.ioRules || []).filter((r) => r.mainClass === solution.mainClass);
  if (!table.length) return noRecipe(solution.id, ['Таблица IO не загружена: сигналов блока не посчитать. Загрузите лист «Таблица IO» в разделе «Таблица IO»'].concat(issues), block);
  if (!override && !rules.length) return noRecipe(solution.id, [`Правил состава для класса «${solution.mainClass}» нет: добавьте правило в разделе «Таблица IO» или задайте состав вручную в карточке решения`].concat(issues), block);

  const put = (role: string, ref: E3IoRowRef, n: number, fromRole: string | undefined, why: (i: number) => string) => {
    const found = findIoRow(table, ref);
    if (found.issue) issues.push(`${role}: ${found.issue}`);
    const row = found.row;
    if (!row) return;
    const kids = fromRole ? childrenOf(position, siblings, fromRole) : [];
    if (fromRole && kids.length && kids.length !== n) issues.push(`${role}: в Flux у позиции подпозиций «${fromRole}» — ${kids.length}, а блоку нужно ${n}`);
    for (let i = 0; i < n; i++) {
      out.push({
        role, ioRowId: row.id, ...(row.component?.trim() ? { component: row.component.trim() } : {}),
        ...(fromRole && i < kids.length ? { fromPosition: { role: fromRole, index: i } } : {}), signals: signalsOf(row), why: why(i),
      });
    }
  };

  if (override) {
    override.forEach((l: E3RecipeLine) => put(l.role, l.row, l.count, l.fromRole, (i) => `Задано вручную в карточке решения${l.count > 1 ? `, ${i + 1} из ${l.count}` : ''}`));
  } else {
    let fired = 0;
    for (const rule of rules) {
      const verdict = condsHold(rule.when, solution, title);
      if (verdict.issue) { issues.push(`${rule.title}: ${verdict.issue}`); continue; }
      if (!verdict.ok) continue;
      const n = countOf(rule, solution, position, siblings, title);
      if (n.issue) { issues.push(`${rule.title}: ${n.issue}`); continue; }
      if (n.value <= 0) continue;
      fired++;
      const because = [...rule.when.map((c) => `${title(c.feature)} ${c.not ? '≠' : '='} ${c.values.join('/')}`), ...(n.why ? [n.why] : [])].join(', ');
      put(rule.role, rule.row, n.value, rule.fromRole, (i) => `${rule.title}${because ? ` (${because})` : ''}${n.value > 1 ? `, ${i + 1} из ${n.value}` : ''}`);
    }
    if (!fired && !issues.length) issues.push(`Ни одно правило состава не подошло к ответам решения (${rules.length} правил для класса «${solution.mainClass}»)`);
  }

  let total = emptySignals();
  for (const it of out) total = addSignals(total, it.signals);
  return { solutionId: solution.id, block, items: out, total, issues: [...new Set(issues)] };
}

/** Все условия выполнены? Признак решения не задан — условие не проверить, и это замечание, а не «нет» */
function condsHold(when: E3IoCond[], solution: E3Solution, title: (id: string) => string): { ok: boolean; issue?: string } {
  for (const c of when) {
    const have = solution.features?.[c.feature];
    if (have === undefined || have === '') return { ok: false, issue: `у решения не задан признак «${title(c.feature)}» — правило не применено` };
    const hit = c.values.some((v) => sameValue(have, v));
    if (hit === !!c.not) return { ok: false };
  }
  return { ok: true };
}

function countOf(rule: E3IoRule, solution: E3Solution, position: E3Position, siblings: E3Position[], title: (id: string) => string): { value: number; why?: string; issue?: string } {
  const c = rule.count;
  if (c.kind === 'one') return { value: 1 };
  if (c.kind === 'children') { const n = childrenOf(position, siblings, c.role).length; return { value: n, why: `${c.role} в Flux: ${n}` }; }
  const raw = solution.features?.[c.feature];
  if (raw === undefined || raw === '' || !isNum(raw)) return { value: 0, issue: `у решения нет числа в признаке «${title(c.feature)}» — сколько изделий, неизвестно` };
  const v = Math.max(0, Number(String(raw).replace(',', '.')) + (c.offset || 0));
  return { value: Math.floor(c.cap !== undefined ? Math.min(c.cap, v) : v), why: `${title(c.feature)} = ${raw}` };
}

// ── Ручной состав: текст ↔ строки ───────────────────────────────────────────

/** «роль | наименование (или код:TS) | число | группа | подпозиция Flux» — по строке на изделие, хвостовые пустые поля опускаются */
export function recipeLinesText(lines: E3RecipeLine[] | undefined): string {
  return (lines || []).map((l) => {
    const parts = [l.role, l.row.code && !l.row.name ? `код:${l.row.code}` : l.row.name || '', String(l.count), l.row.group || '', l.fromRole || ''];
    while (parts.length > 3 && !parts[parts.length - 1]) parts.pop();
    return parts.join(' | ');
  }).join('\n');
}

export function parseRecipeLines(textValue: string): { lines: E3RecipeLine[]; errors: string[] } {
  const lines: E3RecipeLine[] = [];
  const errors: string[] = [];
  String(textValue || '').split('\n').forEach((raw, i) => {
    const line = raw.trim();
    if (!line) return;
    const [role = '', what = '', countText = '', group = '', fromRole = ''] = line.split('|').map((p) => p.trim());
    const row: E3IoRowRef = {};
    const code = what.match(/^(?:код|code)\s*[:=]\s*(.+)$/i);
    if (code) row.code = code[1].trim(); else if (what) row.name = what;
    if (group) row.group = group;
    const count = countText === '' ? 1 : Number(countText);
    if (!role) errors.push(`Строка ${i + 1}: не названа роль изделия («Привод | пружинный, с бк | 2»)`);
    else if (refIsEmpty(row)) errors.push(`Строка ${i + 1}: не названа строка таблицы IO — часть наименования или «код:TS»`);
    else if (!Number.isInteger(count) || count < 1 || count > 50) errors.push(`Строка ${i + 1}: число изделий — целое от 1 до 50`);
    else lines.push({ role, row, count, ...(fromRole ? { fromRole } : {}) });
  });
  return { lines, errors };
}

export { signalsText };
