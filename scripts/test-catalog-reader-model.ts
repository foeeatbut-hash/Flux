/** Модель читателя Каталога: записи, фильтры, счётчики соседних фильтров, главные характеристики. На данных затравки и пакета ВЕЗА. */
import { seedCatalog } from '../catalog/seed';
import { veza2026Pack } from '../catalog/packs/veza2026';
import { cleanDescription } from '../src/components/catalog/reader/ModelTabs';
import { buildEntries, matches, navCounts, sortEntries, keyFacts, documentCount, EMPTY_FILTERS } from '../src/components/catalog/reader/readerModel';

let failed = false;
const check = (name: string, ok: boolean, detail?: unknown) => {
  if (!ok) { failed = true; console.error(`✗ ${name}`, detail ?? ''); } else console.log(`✓ ${name}`);
};

const catalog = seedCatalog();
const merge = <T extends { id: string }>(cur: T[], inc: T[]) => { const m = new Map(cur.map((r) => [r.id, r])); inc.forEach((r) => m.set(r.id, { ...m.get(r.id), ...r })); return [...m.values()]; };
for (const key of ['classes', 'manufacturers', 'families', 'components'] as const) (catalog[key] as any) = merge(catalog[key] as any, veza2026Pack[key] as any);

const entries = buildEntries(catalog);
const cleaned = cleanDescription('ДОПОЛНИТЕЛЬНАЯ КОМПЛЕКТАЦИЯ\n\nВходной коллектор ВКО-ОСА\n\nНазначение\n  Коллектор служит для правиль-\nного формирования поля\nскоростей.\n\nВторой абзац.', ['ВКО-ОСА', 'Входной коллектор ВКО-ОСА']);
check('описание не повторяет шапку и склеивает строки PDF', cleaned === 'Коллектор служит для правильного формирования поля скоростей.\n\nВторой абзац.', cleaned);
check('одна запись на модель и на комплектующее', entries.length === catalog.families.length + catalog.components.length, entries.length);
check('комплектующее помечено и получает идентичность component:', entries.filter((e) => e.isComponent).every((e) => e.family.id.startsWith('component:')));

const fans = { ...EMPTY_FILTERS, classId: 'fan' };
const fanEntries = entries.filter((e) => matches(e, fans));
check('фильтр по типу оставляет только вентиляторы', fanEntries.length > 0 && fanEntries.every((e) => e.classIds.includes('fan')));

const counts = navCounts(entries, fans);
check('счётчик типа считается при остальных фильтрах, но без самого типа', (counts.classes.get('cls-valve') || 0) === entries.filter((e) => matches(e, EMPTY_FILTERS) && e.classIds.includes('cls-valve')).length);
check('счётчик изготовителя учитывает выбранный тип', [...counts.makers.values()].reduce((s, m) => s + m.count, 0) === fanEntries.filter((e) => e.makerKey).length);

const q = entries.find((e) => !e.isComponent)!;
const found = entries.filter((e) => matches(e, { ...EMPTY_FILTERS, query: q.family.code.toLowerCase() }));
check('поиск по коду без учёта регистра находит модель', found.some((e) => e.family.id === q.family.id));
check('поиск по несуществующему слову пуст', !entries.some((e) => matches(e, { ...EMPTY_FILTERS, query: 'zzqq-нет-такого' })));

const onlyModels = entries.filter((e) => matches(e, { ...EMPTY_FILTERS, scope: 'models' }));
check('охват «модели» не пропускает комплектующие', onlyModels.every((e) => !e.isComponent) && onlyModels.length === catalog.families.length);

const byData = sortEntries(entries.filter((e) => !e.isComponent), 'data');
const rank = (s: string) => ({ full: 0, partial: 1, draft: 2 }[s] ?? 3);
check('сортировка «по полноте данных» ставит сверенное выше черновиков', byData.every((e, i) => i === 0 || rank(byData[i - 1].family.status) <= rank(e.family.status)));

const withFacts = entries.find((e) => !e.isComponent && Object.keys(e.family.facts || {}).length > 1)!;
const facts = keyFacts(withFacts, catalog, 3);
check('главные характеристики: не больше лимита, подписи словами', facts.length > 0 && facts.length <= 3 && facts.every((f) => f.label && f.value && !/^[a-z_]+$/.test(f.label)), facts);
check('число документов считает файл один раз', documentCount({ ...q.family, documents: [{ id: 'a', label: 'x', kind: 'manual', file: 'f.pdf' }, { id: 'b', label: 'y', kind: 'manual', file: 'f.pdf' }], catalog: undefined, sections: [] }) === 1);

process.exit(failed ? 1 : 0);
