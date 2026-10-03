import type { Family, CatalogRef } from './model';

/** Один загруженный PDF обслуживает все ссылки на тот же файл и редакцию в модели. */
export function attachCatalogSource(family: Family, source: CatalogRef | undefined, assetId: string): Family {
  if (!source?.file) return family;
  const attach = <T extends CatalogRef>(ref: T | undefined): T | undefined => ref && ref.file === source.file && (ref.edition || '') === (source.edition || '') ? { ...ref, assetId } : ref;
  return {
    ...family, catalog: attach(family.catalog),
    documents: family.documents?.map(doc => attach(doc)!),
    tables: family.tables?.map(table => ({ ...table, source: attach(table.source), rows: table.rows.map(row => ({ ...row, source: attach(row.source) })) })),
  };
}

/** В браузерном PDF используются физические страницы, печатные номера остаются пояснением. */
export function sourcePhysicalPage(source: CatalogRef): number | undefined {
  if (Number.isInteger(source.physicalPage) && source.physicalPage! > 0) return source.physicalPage;
  // В старых данных pages может быть печатным номером: не угадываем физический.
  return undefined;
}
