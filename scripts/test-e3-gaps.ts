/**
 * «Нет данных»: каждый вид пробела на синтетических данных (e3/gaps.ts).
 * Книги и позиции придуманы здесь; файлов владельца нет.
 *
 * Запуск: npx tsx scripts/test-e3-gaps.ts
 */
import { collectGaps, gapCount, type Gap, type GapKind, type GapPosition } from '../e3/gaps';
import type { E3Attribute, E3AttributeBook } from '../e3/attributes';
import type { E3IoRow, E3IoRule, E3Position, E3Solution, E3SolutionBook } from '../e3/solutions';
import { emptySolutionBook } from '../e3/solutions';

let failed = 0;
const ok = (name: string, value: boolean, detail?: unknown) => {
  if (value) return;
  failed++;
  console.error(`  ✗ ${name}${detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`);
};
const of = (gaps: Gap[], kind: GapKind) => gaps.filter((g) => g.kind === kind);

const attr = (name: string, o: Partial<E3Attribute> = {}): E3Attribute => ({
  name, title: name, carrier: 'Изделие', attrClass: 'Двигатели', service: false, fromFlux: true, script: '', comment: '',
  source: { kind: 'none' }, classes: [], conflict: 'flux', ...o,
});
const attrBook = (items: E3Attribute[]): E3AttributeBook => ({ version: 1, items, updatedAt: '' });

const io = (id: string, group: string, name: string, code: string, component?: string): E3IoRow =>
  ({ id, group, name, code, di: 1, do: 0, ai: 0, ao: 0, notes: { di: '', do: '', ai: '', ao: '' }, ...(component ? { component } : {}) });
const sol = (id: string, mainClass: string, o: Partial<E3Solution> = {}): E3Solution =>
  ({ id, mainClass, subclass: '', short: '', name: `Решение ${id}`, description: '', pdf: '', e3p: '', twoLevel: false, inCad: false, items: '', symbols: '', note: '', features: {}, featuresConfirmed: true, ...o });
const bookOf = (o: Partial<E3SolutionBook>): E3SolutionBook => ({ ...emptySolutionBook(), features: [], rules: [], ioRules: [], classMap: {}, ...o });
const rule = (id: string, o: Partial<E3IoRule> = {}): E3IoRule => ({ id, title: `Правило ${id}`, mainClass: 'Клапаны', when: [], role: 'Привод', row: { name: 'пружинный' }, count: { kind: 'one' }, ...o });

// ── Справочник атрибутов ────────────────────────────────────────────────────
{
  const book = attrBook([
    attr('MOTOR_POWER', { classes: ['ДВИГАТЕЛЬ'] }),
    attr('MOTOR_OK', { classes: ['ДВИГАТЕЛЬ'], source: { kind: 'param', name: 'Мощность' } }),
    attr('MOTOR_BY_TYPE', { classes: ['ДВИГАТЕЛЬ'], sourceByClass: { ДВИГАТЕЛЬ: { kind: 'const', value: '1' } } }),
    attr('NO_YES', { classes: ['ДВИГАТЕЛЬ'], fromFlux: false }),
    attr('GONE', { classes: ['ДВИГАТЕЛЬ'], removed: true }),
  ]);
  const gaps = collectGaps({ attributes: book });
  const g = of(gaps, 'attr-no-source');
  ok('атрибут «Да» без источника — один пробел', g.length === 1 && g[0].title === 'MOTOR_POWER', g.map((x) => x.title));
  ok('ссылка ведёт на «По типам» с типом и атрибутом', JSON.stringify(g[0]?.where) === JSON.stringify({ tab: 'book', section: 'byClass', id: 'MOTOR_POWER', cls: 'ДВИГАТЕЛЬ' }), g[0]?.where);
  ok('источник, заданный для типа, пробелом не считается', !g.some((x) => x.title === 'MOTOR_BY_TYPE'));
  // Тип, у которого источник свой, а у общего его нет — тоже закрыт; обратный случай — открыт для другого типа
  const two = collectGaps({ attributes: attrBook([attr('POWER', { classes: ['ДВИГАТЕЛЬ', 'НАСОС'], sourceByClass: { ДВИГАТЕЛЬ: { kind: 'const', value: '1' } } })]) });
  ok('источник по типу закрывает только свой тип', of(two, 'attr-no-source').length === 1 && (of(two, 'attr-no-source')[0].where as any).cls === 'НАСОС');
}

// ── Каталог решений ─────────────────────────────────────────────────────────
{
  const table = [io('r1', 'Приводы', 'Клапан пружинный, с бк', '', 'клапан_1'), io('r2', 'Приводы', 'Клапан трёхпозиционный', ''), io('r3', 'Прочее', 'Лишняя строка', '')];
  const feat = (id: string, mainClass: string, kind: 'ov' | 'profile') => ({ id, mainClass, title: id, values: ['а', 'б'], kind, hint: '' });
  const book = bookOf({
    ioTable: table,
    ioRules: [
      rule('ok', { row: { name: 'пружинный' } }),
      rule('noname', { row: { name: 'трёхпозиционный' }, when: [{ feature: 'valve.drive', values: ['а'] }] }),
      rule('norow', { row: { name: 'нет такой' } }),
      rule('nofeature', { row: { name: 'пружинный' }, when: [{ feature: 'valve.ghost', values: ['а'] }] }),
      rule('nocount', { row: { name: 'пружинный' }, count: { kind: 'feature', feature: 'valve.ghost2' } }),
    ],
    features: [feat('valve.drive', 'Клапаны', 'ov'), feat('valve.box', 'Клапаны', 'profile'), feat('valve.limit', 'Клапаны', 'ov')],
    rules: [
      { mainClass: 'Клапаны', featureId: 'valve.drive', source: { kind: 'param', name: 'x' }, table: [] },
      { mainClass: 'Клапаны', featureId: 'valve.lost', source: { kind: 'param', name: 'x' }, table: [] },
      { mainClass: 'Вентилятор', featureId: '@class', source: { kind: 'param', name: 'x' }, table: [] },
    ],
    solutions: [
      sol('1', 'Клапаны', { featuresConfirmed: false, recipeOverride: [{ role: 'Привод', row: { name: 'призрак' }, count: 1 }] }),
      sol('2', 'Клапаны'), sol('3', 'Воздуховод'), sol('4', 'Странный класс'), sol('6', 'Воздуховод', { name: '  ' }), sol('5', 'Клапаны', { removed: true, featuresConfirmed: false }),
    ],
    classMap: { КЛАПАН: ['Клапаны'] },
  });
  const gaps = collectGaps({ solutionBook: book });

  const rows = of(gaps, 'solution-no-name');
  ok('решение без названия схемы — ошибка со ссылкой на решение', rows.length === 1 && rows[0].severity === 'error' && (rows[0].where as any).id === '6', rows.map((x) => x.where));
  ok('строка IO без изделия E3 пробелом больше не считается', !gaps.some((x) => (x.kind as string) === 'io-row-no-component') && !gaps.some((x) => x.detail.includes('имя изделия')));

  const unconfirmed = of(gaps, 'solution-unconfirmed');
  ok('неподтверждённое решение — одно, снятое не считается', unconfirmed.length === 1 && (unconfirmed[0].where as any).id === '1', unconfirmed.map((x) => x.where));

  const noRule = of(gaps, 'feature-no-rule');
  ok('признак ov без правила — только valve.limit', noRule.length === 1 && (noRule[0].where as any).id === 'valve.limit', noRule.map((x) => x.where));
  ok('признак profile без правила пробелом не считается', !noRule.some((x) => (x.where as any).id === 'valve.box'));

  const noType = of(gaps, 'class-no-type');
  ok('класс файла без типа Flux — предупреждение', noType.length === 1 && noType[0].title === 'Странный класс' && noType[0].severity === 'warn', noType.map((x) => x.title));
  const info = of(gaps, 'class-info');
  ok('«Воздуховод» — справка, не ошибка', info.length === 1 && info[0].title === 'Воздуховод' && info[0].severity === 'info', info);
  ok('справка не входит в счётчик вкладки', gapCount(gaps) === gaps.length - 1, [gapCount(gaps), gaps.length]);

  const dangling = of(gaps, 'rule-dangling');
  const keys = dangling.map((x) => x.key).sort();
  ok('правило со строкой IO, которой нет', keys.includes('io-rule-row:norow'), keys);
  ok('правило с несуществующим признаком условия', keys.includes('io-rule-feature:nofeature:valve.ghost'), keys);
  ok('правило с несуществующим признаком числа', keys.includes('io-rule-feature:nocount:valve.ghost2'), keys);
  ok('правило подбора ОВ на несуществующий признак', keys.includes('rule:Клапаны|valve.lost'), keys);
  ok('служебный признак @class не считается несуществующим', !keys.some((k) => k.includes('@class')), keys);
  ok('ручной состав со строкой, которой нет', keys.includes('override:1:Привод'), keys);
  ok('ссылка правила ведёт в «Правила состава» на правило', dangling.find((x) => x.key === 'io-rule-row:norow')?.where.hasOwnProperty('section') === true
    && (dangling.find((x) => x.key === 'io-rule-row:norow')!.where as any).section === 'io-rules' && (dangling.find((x) => x.key === 'io-rule-row:norow')!.where as any).id === 'norow');
  ok('тяжёлое идёт первым', gaps[0].severity === 'error' && gaps[gaps.length - 1].severity === 'info', gaps.map((x) => x.severity));

  const empty = collectGaps({ solutionBook: bookOf({ ioRules: [rule('a')], ioTable: [] }) });
  ok('таблица IO не загружена — один пробел, а не по правилу', of(empty, 'rule-dangling').length === 1 && empty[0].key === 'io-table-empty', empty);
}

// ── Проект ──────────────────────────────────────────────────────────────────
{
  const feat = (id: string, mainClass: string) => ({ id, mainClass, title: `Признак ${id}`, values: ['а', 'б'], kind: 'profile' as const, hint: '' });
  const book = bookOf({
    features: [feat('valve.drive', 'Клапаны')],
    classMap: { КЛАПАН: ['Клапаны'] },
    ioTable: [io('r1', 'Приводы', 'Клапан пружинный', '')],
    ioRules: [rule('r', { row: { name: 'пружинный' } })],
    solutions: [sol('A', 'Клапаны', { features: { 'valve.drive': 'а' } }), sol('B', 'Клапаны', { features: { 'valve.drive': 'б' } })],
  });
  const pos = (id: string, cls: string): E3Position => ({ id, cls, tag: id, read: () => '' });
  const gp = (id: string, cls: string, missingAttrs: string[] = []): GapPosition => { const p = pos(id, cls); return { id, label: id, position: p, siblings: [p], missingAttrs }; };

  // Без профиля подходят оба решения: нужен ответ; с профилем «в» решения нет; с «а» — подобрано, но состав с замечанием
  const many = collectGaps({ solutionBook: book, positions: [gp('K-1', 'КЛАПАН')] });
  ok('несколько решений — «нужен ответ» с названием признака', of(many, 'position-unanswered').length === 1 && of(many, 'position-unanswered')[0].detail.includes('Признак valve.drive'), many);
  ok('ссылка позиции ведёт в подбор', JSON.stringify(of(many, 'position-unanswered')[0].where) === JSON.stringify({ positionId: 'K-1', view: 'selection' }));

  const none = collectGaps({ solutionBook: book, positions: [gp('K-2', 'КЛАПАН')], profile: { 'valve.drive': 'в' } });
  ok('нет решения — ошибка', of(none, 'position-no-solution').length === 1 && of(none, 'position-no-solution')[0].severity === 'error', none);

  const one = collectGaps({ solutionBook: book, positions: [gp('K-3', 'КЛАПАН')], profile: { 'valve.drive': 'а' } });
  const recipe = of(one, 'position-recipe');
  ok('решение подобрано, имя блока — название схемы: замечаний об имени изделия нет', recipe.every((g) => !g.detail.includes('имя изделия')), one);
  ok('подобранная позиция без замечаний пробела не даёт', collectGaps({ solutionBook: book, positions: [gp('K-4', 'КЛАПАН')], profile: { 'valve.drive': 'а' } }).filter((g) => g.kind.startsWith('position')).length === 0);

  const skipped = collectGaps({ solutionBook: book, positions: [gp('S-1', 'ШУМОГЛУШИТЕЛЬ')] }).filter((g) => g.kind.startsWith('position'));
  ok('тип без решений по природе пробелов подбора не даёт', skipped.length === 0, skipped);

  const attrs = collectGaps({ solutionBook: book, positions: [gp('S-2', 'ШУМОГЛУШИТЕЛЬ', ['A', 'B', 'C', 'D', 'E'])] }).filter((g) => g.kind.startsWith('position'));
  ok('атрибуты «Да» без значения — один пробел на позицию', attrs.length === 1 && attrs[0].kind === 'position-attr-missing' && attrs[0].detail.includes('и ещё 1') && (attrs[0].where as any).view === 'attributes', attrs);

  ok('без проекта (нет позиций) пробелов проекта нет', collectGaps({ solutionBook: book }).every((g) => !g.kind.startsWith('position')));
  ok('без книг — пустой список', collectGaps({}).length === 0);
  const again = collectGaps({ solutionBook: book, positions: [gp('K-1', 'КЛАПАН')] });
  ok('пересчёт даёт тот же список (ничего не хранится)', JSON.stringify(again) === JSON.stringify(many));
}

if (failed) { console.error(`\n✗ Провалено: ${failed}`); process.exit(1); }
console.log('✓ test-e3-gaps: все проверки пройдены');
