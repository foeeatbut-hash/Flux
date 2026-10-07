/**
 * Три стороны сравнения (docs/e3-integration.md, 9.2): «отправлено» (связь),
 * «сейчас во Flux» (узел) и «сейчас в E3» (readBound). Из них видно, кто что
 * менял: без «отправлено» нельзя отличить переподбор от ручной правки в E3.
 *
 * Покрыты случаи С1, С2, С5, С7, С10 и С16; значение, которое правили в E3,
 * сейчас просто не перезаписывается (умолчание С8 — «оставить значение E3»), а
 * вопрос «оставить или записать» — задача этапа G. Остальные случаи (С3, С4,
 * С11–С15, С19, С20) здесь только узнаются как «замена» или «пропуск».
 */
import type { E3BoundBlock } from './bridgeTypes';
import { attrKey, type Binding, type ExportAttr, type ExportNode, type NodeAction } from './exportTypes';

const same = (a: number, b: number): boolean => Math.abs(a - b) < 1e-6;

/** Можно ли писать атрибут: служебный — только если настройка каталога разрешает; пустой — нечего */
export const writable = (a: ExportAttr): boolean => !!a.name && (!a.service || !!a.allowService) && a.name !== 'Device Designation';

export function compareNode(sent: Binding | undefined, now: ExportNode, inE3: E3BoundBlock | undefined): NodeAction {
  const base = { elementId: now.elementId, attrs: [] as ExportAttr[], rect: now.rect, keptE3: [] as string[] };
  const attrs = now.attrs.filter(writable).filter((a) => a.value !== '');

  // С16: выбрать одно решение нельзя — узел пропускается, остальные выгружаются
  if (now.status === 'many') return { ...base, kind: 'skip', reason: 'need-answer' };
  if (now.status === 'none') return { ...base, kind: 'skip', reason: 'blocked' };
  if (!now.checked) return { ...base, kind: 'skip', reason: 'not-checked' };

  // С5: новой позиции в выгруженной установке — выгрузка только по отметке (она уже стоит)
  if (!sent || sent.state === 'DETACHED') return { ...base, kind: 'place', attrs, designation: now.designation };

  // Связь есть, а блока в E3 нет: инженер удалил его. По умолчанию не восстанавливаем (С11)
  if (!inE3) return { ...base, kind: 'skip', reason: 'deleted-in-e3' };

  if (sent.solutionId !== now.solutionId) {
    return { ...base, kind: 'replace', attrs, designation: now.designation, rect: inE3.rect, note: 'Другое решение: блок ставится на место старого' };
  }

  // С10: положение берётся из E3, блок не двигаем
  const movedInE3 = !same(inE3.rect.x, sent.x) || !same(inE3.rect.y, sent.y);
  const keptE3: string[] = [];
  const changed: ExportAttr[] = [];
  // С1 и С2: изменилось значение у блока или у изделия внутри него — пишем только изменившееся
  for (const a of attrs) {
    const key = attrKey(a);
    const was = sent.sentAttrs[key];
    if (was === a.value) continue;
    const inE3Value = inE3.attrs?.[key];
    // Значение в E3 уже не то, что отправляли: его правил инженер — не перезаписываем
    if (inE3Value !== undefined && was !== undefined && inE3Value !== was) { keptE3.push(key); continue; }
    changed.push(a);
  }
  // С7: тег изменился — обозначение меняется, если инженер его не правил в E3
  const designationChanged = now.designation !== sent.designation && (inE3.designation === sent.designation || inE3.designation === '');
  if (now.designation !== sent.designation && !designationChanged) keptE3.push('Device Designation');

  if (!changed.length && !designationChanged) return { ...base, kind: 'keep', rect: inE3.rect, movedInE3, keptE3 };
  return { ...base, kind: 'update', attrs: changed, ...(designationChanged ? { designation: now.designation } : {}), rect: inE3.rect, movedInE3, keptE3 };
}
