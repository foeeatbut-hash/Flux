import { bindingKey, sourceInfo } from './equipmentCatalog.js';
import { getPrisma } from './context.js';

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

/** Право на ручную правку относится к проверенному снимку, а не к любой будущей привязке. */
export async function writeEditableEquipmentParam(prisma: any, element: any, expected: CatalogState, update: { where: unknown; data: unknown }): Promise<any> {
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
    throw error;
  }
}
