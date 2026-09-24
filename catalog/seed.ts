/**
 * Затравка Каталога: то, с чем программа приходит в первый раз.
 *
 * Сервер кладёт затравку в базу, если каталог пуст, и докладывает новые
 * семейства при обновлении программы — но никогда не перезаписывает то, что
 * инженер уже поправил руками (сверяется по версии записи, см.
 * server/routes/catalog.ts). Каталог с этого момента живёт в базе, а не здесь.
 *
 * Новый класс оборудования добавляется так же: папка catalog/<класс>/ с
 * классом, семействами и комплектующими — и строка в этом файле.
 */
import type { Catalog, Manufacturer } from './model';
import { VALVE_CLASS, VALVE_TAG_RULES, VALVE_DETECTORS } from './valve/class';
import { FIRE_FAMILIES, VEZA } from './valve/seedFire';
import { AIR_FAMILIES } from './valve/seedAir';
import { CHECK_FAMILIES } from './valve/seedCheck';
import { VALVE_COMPONENTS } from './valve/components';
import type { Detector } from './describe';

/** Версия затравки. Поднимается, когда семейства в коде изменились */
export const SEED_VERSION = 1;

export const SEED_MANUFACTURERS: Manufacturer[] = [
  {
    id: VEZA, name: 'ООО «ВЕЗА»', shortName: 'ВЕЗА', country: 'Россия',
    standard: 'ТУ 4863-135-40149153-2009',
    notes: 'Каталоги: «Противопожарные клапаны» (ред. 03.2026), «Воздушные клапаны» (ред. 17.10.2025), КПУ-3, КПУ-60, КЭД, КПУ-2Н МЕТРО, КЛАБ',
  },
];

export function seedCatalog(): Catalog {
  return {
    classes: [VALVE_CLASS],
    manufacturers: SEED_MANUFACTURERS,
    families: [...FIRE_FAMILIES, ...AIR_FAMILIES, ...CHECK_FAMILIES].map((f) => ({ ...f, version: SEED_VERSION })),
    components: VALVE_COMPONENTS,
    tagRules: VALVE_TAG_RULES,
  };
}

/**
 * Словарь примет по классу. Приметы — код, а не данные: это регулярные
 * выражения, и править их в окне значило бы дать сломать разбор одной опечаткой.
 * Синонимы, которые инженер добавляет кодам в Каталоге, работают отдельно —
 * подбор ищет их в тексте напрямую (catalog/match.ts, inferValues).
 */
export const DETECTORS: Record<string, Detector[]> = {
  valve: VALVE_DETECTORS,
};

export function detectorsFor(classCode: string): Detector[] {
  return DETECTORS[classCode] || [];
}
