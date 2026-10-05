import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { manuals2026Pack, manualSources, manualsCoverage } from '../catalog/packs/manuals2026';
import { catalogDocumentProblem } from '../catalog/publication';
import { attachCatalogSource } from '../catalog/sources';
import { parseWithFamily } from '../catalog/designation';

const records = [...manuals2026Pack.families, ...manuals2026Pack.components];
assert.equal(manualsCoverage.reduce((n, d) => n + d.pages.length, 0), 212);
for (const source of manualSources) {
  const bytes = readFileSync(new URL(`../public/catalog-documents/${source.id}.pdf`, import.meta.url));
  assert.equal(bytes.byteLength, source.bytes);
  assert.equal(createHash('sha256').update(bytes).digest('hex'), source.sha256);
  const pages = new Set(records.flatMap(record => (record.sections || []).filter(section => section.source.file === source.file).map(section => section.source.physicalPage)));
  assert.deepEqual([...pages].sort((a,b) => a! - b!), Array.from({ length: source.pages }, (_, i) => i + 1), `Все разделы ${source.file} доступны через изделия`);
}
for (const family of manuals2026Pack.families) assert.equal(catalogDocumentProblem('family', family), '', family.code);
for (const component of manuals2026Pack.components) assert.equal(catalogDocumentProblem('component', component), '', component.code);
const osa = manuals2026Pack.families.find(f => f.id === 'veza-osa-300')!;
assert.equal(parseWithFamily(osa, 'ОСА300-050/Б-50-Н-00400/2-У1-02').complete, true);
assert.equal(osa.tables?.filter(table => table.id.startsWith('osa-performance')).length, 22);
assert.equal(osa.tables?.filter(table => table.id.startsWith('osa-performance')).flatMap(table => table.rows).length, 155);
assert.ok(osa.tables?.filter(table => table.id.startsWith('osa-performance')).every(table => table.rows.every(row => !row.verified)), 'Извлечение не выдаётся за сверку');
assert.ok(osa.tables?.find(table => table.id === 'osa-performance-040-2')?.rows.some(row => row.values.motorIndex === '00055'), 'Индекс мощности сохраняет ведущие нули');
const attached = attachCatalogSource(osa, osa.catalog, 'fixture-source');
assert.ok(attached.sections?.every(section => section.source.assetId === 'fixture-source'));
assert.ok(attached.tables?.every(table => table.source?.assetId === 'fixture-source'));
assert.ok(!osa.sections?.some(section => section.source.assetId), 'Пакет остаётся неизменным');
assert.equal(manuals2026Pack.families.filter(f => f.kind === 'accessory').length, 13);
assert.equal(new Set(records.map(record => record.id)).size, records.length);
assert.ok(manualsCoverage.find(d => d.source.file.includes('Воздушные'))?.pages.find(page => page.physicalPage === 115)?.text === 'encoding-review');
console.log('Проверены 212 страниц, оригиналы по SHA-256, 114 записей, 22 таблицы ОСА и безопасная привязка документации.');
