import type { Catalog } from '../catalog/model.js';

const BATCH_SIZE = 100;
const batches = <T>(values: T[]): T[][] => Array.from({ length: Math.ceil(values.length / BATCH_SIZE) }, (_, i) => values.slice(i * BATCH_SIZE, (i + 1) * BATCH_SIZE));

/**
 * Обычный запуск пишет одним пакетом, а не делает SELECT+INSERT на карточку.
 * Если другой Flux вставил тот же id после снимка, upsert с пустой правкой
 * сохраняет его данные. INSERT IGNORE не используем: MariaDB скрывает им
 * не только дубликаты, но и обрезание значений и другие ошибки данных.
 */
async function insertMissing(model: any, rows: any[], existing: Set<string>): Promise<void> {
  for (const batch of batches(rows.filter(row => !existing.has(row.id)))) {
    try {
      await model.createMany({ data: batch });
    } catch (error: any) {
      if (error?.code !== 'P2002') throw error;
      for (const row of batch) await model.upsert({ where: { id: row.id }, create: row, update: {} });
    }
  }
}

/** Пользовательская правка защищена условием UPDATE, даже если пришла после чтения снимка. */
export async function syncCatalogSeed(prisma: any, seed: Catalog, version: number, template: any): Promise<void> {
  const [classes, manufacturers, families, components, rules, templateCount] = await Promise.all([
    prisma.catalogClass.findMany({ select: { id: true } }),
    prisma.catalogManufacturer.findMany({ select: { id: true } }),
    prisma.catalogFamily.findMany({ select: { id: true, edited: true, seedVersion: true } }),
    prisma.catalogComponent.findMany({ select: { id: true } }),
    prisma.catalogTagRule.findMany({ select: { id: true } }),
    prisma.blankTemplate.count(),
  ]);
  // Предметные данные загружаются только при первом заполнении. Новый EXE не публикует изменения.
  if (classes.length || manufacturers.length || families.length || components.length || rules.length) return;
  const ids = (rows: any[]): Set<string> => new Set(rows.map(row => row.id));
  await insertMissing(prisma.catalogClass, seed.classes.map(c => ({ id: c.id, code: c.code, dataJson: JSON.stringify(c), sort: c.sort || 0 })), ids(classes));
  await insertMissing(prisma.catalogManufacturer, seed.manufacturers.map(m => ({ id: m.id, name: m.name, dataJson: JSON.stringify(m) })), ids(manufacturers));
  const familyRows = seed.families.map(f => ({ id: f.id, classId: f.classId, manufacturerId: f.manufacturerId, code: f.code, dataJson: JSON.stringify(f), status: f.status, seedVersion: version, sort: f.sort || 0 }));
  await insertMissing(prisma.catalogFamily, familyRows, ids(families));
  await insertMissing(prisma.catalogComponent, seed.components.map(c => ({ id: c.id, classId: c.classId, kind: c.kind, code: c.code, dataJson: JSON.stringify(c) })), ids(components));
  await insertMissing(prisma.catalogTagRule, seed.tagRules.map(r => ({ id: r.id, classId: r.classId, code: r.code, dataJson: JSON.stringify(r) })), ids(rules));
  if (!templateCount) await prisma.blankTemplate.upsert({
    where: { id: 'tpl-veza-order' },
    create: { id: 'tpl-veza-order', name: template.name, scope: 'SHARED', layoutJson: JSON.stringify(template), isDefault: true },
    update: {},
  });
}
