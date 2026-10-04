/**
 * Focused business regressions for the engineering verification passport.
 * Run with: npx tsx scripts/test-verification-engineering.ts
 */
import { exportListXlsx, itemOps } from '../src/components/builder/useItemOps';
import { seedCatalog } from '../catalog/seed';
import type { SelectionItemData } from '../catalog/selection';
import { getOrderedItems } from '../src/lib/dictOrder';
import { emptyRules, resolveTemplate, type StageTemplate } from '../src/lib/procurementStages';

let failed = 0;
const eq = (name: string, got: unknown, want: unknown) => {
  if (JSON.stringify(got) === JSON.stringify(want)) console.log('  ✓', name);
  else { failed++; console.error('  ✗', name, '— получили', JSON.stringify(got), 'ждали', JSON.stringify(want)); }
};

async function main() {
console.log('1. Ручное исправление подбора не перезаписывается массовым повторным подбором');
{
  const edited: SelectionItemData = {
    id: 'fixture-edited', classId: 'cls-valve', tags: ['3700-B01-FD-004'], qty: 3,
    familyId: 'veza-fire', values: { W: 725, H: 410, fire: 'EI60' },
    designation: 'РУЧНАЯ-ЭТАЛОННАЯ-СТРОКА', status: 'matched', sort: 1,
    sourceText: 'Fire damper 700x400 EI 30, spring return', overrides: ['values'],
  };
  const writes: Array<{ title: string; rows: Array<Partial<SelectionItemData>> }> = [];
  const ops = itemOps(seedCatalog(), 'cls-valve', [edited], [], async (title, rows) => {
    writes.push({ title, rows });
    return rows as SelectionItemData[];
  });
  const result = await ops.rematch([edited.id]);
  eq('исправленная позиция пропущена, а не отправлена на запись', result, { done: 0, skipped: 1 });
  eq('повторный подбор не создаёт пакет записи', writes.length, 0);
  eq('значения и обозначение остаются ручным эталоном', [edited.values, edited.designation], [
    { W: 725, H: 410, fire: 'EI60' }, 'РУЧНАЯ-ЭТАЛОННАЯ-СТРОКА',
  ]);
}

console.log('2. Иерархический справочник сохраняет соседей и размещает потомков после родителя');
{
  const input = [
    { id: 'child-z', parentId: 'root-b', code: 'Z', name: 'Дочерний Z' },
    { id: 'root-b', code: 'B', name: 'Корень B' },
    { id: 'root-a', code: 'A', name: 'Корень A' },
    { id: 'child-c', parentId: 'root-b', code: 'C', name: 'Дочерний C' },
  ];
  const rows = getOrderedItems(input);
  eq('сортировка обхода не меняет переданный массив', input.map((x) => x.id), ['child-z', 'root-b', 'root-a', 'child-c']);
  eq('корни и дети отсортированы в своём уровне', rows.map((x) => [x.item.id, x.depth]), [
    ['root-a', 0], ['root-b', 0], ['child-c', 1], ['child-z', 1],
  ]);
}

console.log('3. Явный шаблон закупки сильнее совпадения по тегу, а стандартный сбрасывает выбор');
{
  const template = (id: string, identifierIncludes: string[]): StageTemplate => ({
    id, name: id, stages: [], rules: { ...emptyRules(), identifierIncludes },
  });
  const byCode = template('code-match', ['FD-']);
  const manual = template('manual-choice', []);
  const templates = [byCode, manual];
  const ctx = { identifier: '3700-B01-FD-004', department: 'ОВ', equipTypes: [], categories: [] };
  eq('без ручного выбора совпадает шаблон по обозначению', resolveTemplate(ctx, templates)?.id, 'code-match');
  eq('явный шаблон сохраняет выбранный пользователем процесс', resolveTemplate({ ...ctx, explicitTemplateId: 'manual-choice' }, templates)?.id, 'manual-choice');
  eq('явный стандартный процесс не подменяется совпадением', resolveTemplate({ ...ctx, explicitTemplateId: 'default' }, templates), null);
}

console.log('4. Выгруженная книга содержит заданные значения ячеек');
{
  const XLSX = await import('xlsx');
  const catalog = seedCatalog();
  const row: SelectionItemData = {
    id: 'fixture-xlsx', classId: catalog.classes[0].id,
    tags: ['3700-X01-DM-007', '3700-X01-DM-008'], qty: 2,
    values: { W: 800, H: 600 }, designation: 'ЭТАЛОН-КПУ', status: 'matched', sort: 1,
    match: { confidence: 0.86, reasons: [] }, sourceText: 'синтетическое описание', notes: 'заметка эталона',
  };
  const bytes = await exportListXlsx(catalog, [row], 'Эталон');
  const workbook = XLSX.read(bytes, { type: 'array' });
  const sheet = XLSX.utils.sheet_to_json<string[]>(workbook.Sheets['Эталон'], { header: 1, raw: false, defval: '' });
  eq('XLSX сохраняет строку, два тега и количество как задано', sheet[1]?.slice(0, 4), [
    '1', '3700-X01-DM-007, 3700-X01-DM-008', '2', '',
  ]);
  eq('XLSX сохраняет обозначение, размеры, уверенность и примечание', sheet[1]?.slice(4), [
    'ЭТАЛОН-КПУ', '800', '600', '', '86%', 'matched', 'синтетическое описание', 'заметка эталона',
  ]);
}

if (failed) process.exit(1);
console.log('\nВсе проверки инженерных контрактов пройдены');
}

main().catch((error) => { console.error(error); process.exit(1); });
