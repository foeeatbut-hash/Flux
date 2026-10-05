/** Пакет редактора: извлечение не является публикацией и не меняет seed. */
import type { CatalogSection, Family, CatalogDocument } from '../model';
import { NEMAN_COMPONENTS, NEMAN_MANUFACTURER } from '../actuator/neman';
import { veza2026Pack } from './veza2026';
import hemah from './source-data/hemah.json';
import osa from './source-data/osa.json';
import valves from './source-data/valves.json';
import candidates from './source-data/table-candidates.json';
import type { CatalogTable } from '../model';

export const manualSources = [
  { id: 'hemah', ...hemah.source }, { id: 'osa', ...osa.source }, { id: 'valves', ...valves.source },
];
const kinds = (title: string): CatalogSection['kind'] => /габарит|размер/i.test(title) ? 'dimensions'
  : /маркиров/i.test(title) ? 'marking' : /схема|электр|нагрев/i.test(title) ? 'wiring'
  : /монтаж/i.test(title) ? 'installation' : /типоразмер|характеристик|подбор/i.test(title) ? 'selection' : 'description';
type Page = typeof osa.pages[number];
const sections = (pages: Page[], range: number[], prefix = ''): CatalogSection[] => range.map(n => pages[n - 1]).filter(Boolean).map(page => ({
  id: page.id, title: prefix ? `${prefix}: ${page.title}` : page.title,
  text: page.text, kind: kinds(page.title), source: page.source,
}));
const range = (a: number, b: number) => Array.from({ length: b - a + 1 }, (_, i) => a + i);
const documents = (parts: CatalogSection[]): CatalogDocument[] => parts.map(part => ({
  id: part.id, label: part.title, kind: part.kind === 'wiring' ? 'drawing' : part.kind === 'selection' ? 'curve' : 'manual', ...part.source,
}));
const valveRanges: Record<string, number[]> = {
  'РЕГУЛЯР': range(8,18), 'РЕГУЛЯР-Л': range(13,18), 'РЕГЛАН': range(19,21),
  'КЕДР': range(22,29), 'КЕДР-С': range(22,29), 'ГЕРМИК-П': range(30,31),
  'ГЕРМИК-Р': range(32,33), 'ГЕРМИК-С': range(34,39), 'ГЕРМИКх2П': range(40,41),
  'ГЕРМИКх2С': range(42,46), 'НЕРПА': range(47,53), 'КЛАБ': range(54,56),
  'ГЕК': range(57,61), 'ГАЗОХОД': range(62,67), 'КЛАРА': range(68,74),
  'КЛАРА-КРОС': range(68,74), 'ТЮЛЬПАН-1': range(75,84), 'ТЮЛЬПАН-2': range(75,84),
  'ТЮЛЬПАН-3': range(75,84), 'КОЛ': range(85,86), 'УКОЛ': range(87,96),
  'НЕРПА-КО': range(97,102), 'КИД': range(103,109),
};
const families: Family[] = veza2026Pack.families.map(family => {
  const isFan = family.id.startsWith('veza-osa-');
  const parts = isFan ? sections(osa.pages, range(1,49))
    : sections(valves.pages, [...(valveRanges[family.code] || []), ...range(1,7), ...range(110,116)]);
  const performance = (candidates as unknown as CatalogTable[]).filter(table => table.id.startsWith('osa-performance'));
  const params = isFan ? family.params.map(param => {
    if (!['motorIndex', 'wheelMod', 'wheelIndex'].includes(param.key)) return param;
    const values = new Map((param.values || []).map(value => [value.code, value]));
    for (const table of performance) for (const row of table.rows) {
      const code = String(row.values[param.key] || '');
      if (!code || values.has(code)) continue;
      values.set(code, { code, label: { ru: param.key === 'motorIndex' ? `${code} — ${row.values.nominalPower} кВт` : code } });
    }
    return { ...param, values: [...values.values()] };
  }) : family.params;
  return { ...family, params, sections: parts, documents: documents(parts),
    catalog: { ...(isFan ? osa.source : valves.source), pages: undefined },
    tables: [...(family.tables || []).map(table => ({ ...table,
      source: table.source ? { ...table.source, file: isFan ? osa.source.file : valves.source.file } : undefined,
      rows: table.rows.map(row => ({ ...row, source: row.source ? { ...row.source, file: isFan ? osa.source.file : valves.source.file } : undefined })),
    })), ...(candidates as unknown as CatalogTable[]).filter(table => parts.some(part => part.source.file === table.source?.file && part.source.physicalPage === table.source.physicalPage))],
  };
});
const accessories: Array<[string, number, number]> = [
  ['ВКО-ОСА',35,35], ['ЗОНТ-ОСА',36,36], ['МОП-ОСА',37,37], ['МОБ-ОСА',37,37],
  ['ПЕК-ОСА',38,38], ['ПЕП-ОСА',39,39], ['ПЕТ-ОСА',40,40], ['ПУВ-ОСА',41,41],
  ['СОМ',42,42], ['СЕП',43,43], ['ФОВ',44,44], ['ШУМ-АК',45,46], ['ШУМ-ОСА',47,48],
];
for (const [code, first, last] of accessories) {
  const parts = sections(osa.pages, range(first,last));
  families.push({ id: `veza-osa-accessory-${first}-${code === 'МОБ-ОСА' ? 'mobile' : 'fixed'}`, classId: 'fan', manufacturerId: 'mf-veza', code,
    title: { ru: code }, description: { ru: parts[0]?.text.split('Маркировка')[0] || code },
    kind: 'accessory', typeLabel: { ru: 'Комплектующее вентилятора' }, shapes: [], params: [], positions: [],
    designationMode: 'free', rules: [], match: { kinds: ['accessory'], keywords: [code] }, specs: [],
    sections: parts, documents: documents(parts), catalog: { file: osa.source.file, edition: osa.source.edition, physicalPage: first },
    tables: (candidates as unknown as CatalogTable[]).filter(table => table.source?.file === osa.source.file && (table.source.physicalPage || 0) >= first && (table.source.physicalPage || 0) <= last),
    status: 'partial', todo: ['Сверить извлечённый текст и таблицы; структура маркировки комплектующего требует отдельной проверки.'],
    componentRoles: ['fan-accessory'],
  });
}
const components = NEMAN_COMPONENTS.map(component => {
  const page = component.sourcePdfPage || component.catalog?.physicalPage;
  const common = page && page >= 23 && page <= 33 ? [21,22] : page && page >= 35 && page <= 42 ? [34] : page && page >= 44 ? [43] : [3,4];
  const parts = sections(hemah.pages, [...(page ? [page] : []), ...common, 1,2,47]);
  return { ...component, manufacturerId: 'mf-neman', equipmentType: 'Электропривод', sections: parts, documents: documents(parts) };
});
export const manuals2026Pack = { ...veza2026Pack, manufacturers: [...veza2026Pack.manufacturers, NEMAN_MANUFACTURER], families, components };

/** Только редактору: индекс не означает сверку всех численных ячеек. */
export const manualsCoverage = [hemah, osa, valves].map(document => ({ source: document.source,
  models: [...families, ...components].filter(record => record.sections?.some(section => section.source.file === document.source.file)).map(record => ({ id: record.id, code: record.code })),
  pages: document.pages.map(page => ({ id: page.id, title: page.title, ...page.source, ...page.review, inventory: page.inventory })),
}));
