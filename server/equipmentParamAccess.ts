import { bindingKey, sourceInfo } from './equipmentCatalog.js';
import { getPrisma } from './context.js';
import { VersionConflict, assertExpectedVersion } from './versionGuard.js';
import { staleElement } from './equipmentStale.js';

type CatalogState = { id: string; value: string } | null;
const conflict = () => Object.assign(new Error('Источник карточки изменился. Обновите данные перед правкой.'), { status: 409 });

/** Значения каталога изменяются в каталоге; карточка оборудования выбирает и применяет их. */
export async function assertEquipmentParamEditable(element: any, key: string, group?: string): Promise<CatalogState> {
  const info = await sourceInfo(element);
  if (info.effective.some(param => param.key === key && (group === undefined || param.group === group) && param.source === 'catalog')) {
    throw Object.assign(new Error('Это значение из каталога. Измените его в программе «Каталог», затем обновите снимок оборудования.'), { status: 403 });
  }
  const stored = await getPrisma().appSetting.findFirst({ where: { key: bindingKey(element.id), userId: null } });
  if (!stored) {
    if (info.binding) throw conflict();
    return null;
  }
  let binding: any;
  try { binding = JSON.parse(stored.value); } catch { throw conflict(); }
  if (!info.binding || binding?.revision !== info.binding.revision) throw conflict();
  return { id: stored.id, value: stored.value };
}

/**
 * Право на ручную правку относится к проверенному снимку, а не к любой будущей привязке.
 *
 * `expectedVersion` — версия позиции, которую видел клиент: не совпала с прочитанной —
 * `VersionConflict` (маршрут отвечает 409 с кодом и текущей записью). Без неё сверка
 * идёт только с собственным чтением маршрута: запись под `where version`, проигрыш
 * гонки — тот же отказ, а не 500.
 */
export async function writeEditableEquipmentParam(prisma: any, element: any, expected: CatalogState, update: { where: unknown; data: unknown }, expectedVersion?: number): Promise<any> {
  assertExpectedVersion(element, expectedVersion, staleElement);
  try {
    return await prisma.$transaction(async (tx: any) => {
      const current = await tx.appSetting.findFirst({ where: { key: bindingKey(element.id), userId: null } });
      if ((current?.id || null) !== (expected?.id || null) || (current?.value || null) !== (expected?.value || null)) throw conflict();
      if (expected) {
        // Условная запись блокирует строку до конца операции: параллельная смена
        // источника не может вклиниться между проверкой и правкой характеристики.
        const claim = await tx.appSetting.updateMany({ where: { id: expected.id, value: expected.value }, data: { value: expected.value } });
        if (claim.count !== 1) throw conflict();
      }
      return tx.componentElement.update({ where: { id: element.id, version: Number(element.version || 1) }, data: update.data });
    }, { isolationLevel: 'Serializable' });
  } catch (error: any) {
    if (error?.code === 'P2034') throw conflict();
    // Позицию успели изменить (или убрать) между чтением маршрута и записью: версия в условии не нашла строку
    if (error?.code === 'P2025') {
      const fresh = await prisma.componentElement.findUnique({ where: { id: element.id } }).catch(() => null);
      throw new VersionConflict(staleElement(fresh || element), fresh);
    }
    throw error;
  }
}
