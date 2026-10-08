/**
 * Три стороны сравнения (docs/e3-integration.md, 9.2) и все случаи таблицы 9.3.
 * «Отправлено» (связь), «сейчас во Flux» (узел) и «сейчас в E3» (readBound)
 * показывают, кто что менял: без «отправлено» переподбор не отличить от
 * ручной правки в E3.
 *
 * Умолчание везде безопасное — не трогать чужое: правку инженера, блок, который
 * он удалил, решение по старым правилам. Что инженер может решить иначе, функция
 * возвращает вопросом (`questions`), а ответ приходит обратно в `decisions` —
 * тот же план пересчитывается с учётом ответа.
 */
import type { E3BoundBlock } from './bridgeTypes';
import { attrKey, type AttrConflict, type Binding, type Decisions, type ExportAttr, type ExportNode, type NodeAction, type PlanQuestion } from './exportTypes';

const same = (a: number, b: number): boolean => Math.abs(a - b) < 1e-6;

/** Можно ли писать атрибут: служебный — только если настройка каталога разрешает; пустой — нечего */
export const writable = (a: ExportAttr): boolean => !!a.name && (!a.service || !!a.allowService) && a.name !== 'Device Designation';

export interface CompareOptions {
  decisions?: Decisions;
  /** Внешние выводы блоков по именам решений */
  pins?: Map<string, string[]>;
  /** Старая связь и блок, если узел заменяет собой другую позицию (С6) */
  replaces?: { id: string; sent?: Binding; inE3?: E3BoundBlock };
  /** Другие копии блока с тем же `FLUX_BLOCK` (С12): главная выбрана, остальные отвязываются */
  unlink?: number[];
}

const q = (id: string, elementId: string, topic: PlanQuestion['topic'], text: string, options: PlanQuestion['options'], def: string, values?: PlanQuestion['values']): PlanQuestion =>
  ({ id, elementId, topic, text, options, default: def, ...(values ? { values } : {}) });

/** Провода, которые повиснут: выводы старого блока, к которым подведены провода, а у нового их нет */
export function danglingPins(old: E3BoundBlock | undefined, newPins: string[] | undefined): string[] {
  if (!old) return [];
  const wired = old.wiredPins?.length ? old.wiredPins : old.wired ? ['все выводы'] : [];
  if (!wired.length) return [];
  if (!newPins) return wired.map((p) => (p === 'все выводы' ? 'выводы нового блока неизвестны — проверьте провода' : p));
  return wired.filter((p) => !newPins.includes(p));
}

/**
 * Решение по одному атрибуту. Если инженер или скрипт E3 поменял значение после
 * выгрузки, пишет ли Flux своё, определяет правило из настройки атрибута (5.5):
 * «Flux главнее» — пишет, «скрипт главнее» и «Flux только первый раз» — оставляет
 * значение E3, «спросить» — оставляет и задаёт вопрос.
 */
function judge(a: ExportAttr, sent: string | undefined, e3: string | undefined, decision: string | undefined):
  { write: boolean; conflict?: AttrConflict; ask?: boolean } {
  const flux = a.value;
  if (sent === undefined || e3 === undefined || e3 === sent) return { write: sent !== flux };
  if (e3 === flux) return { write: false };
  const fluxChanged = flux !== sent;
  const conflict = (applied: 'e3' | 'flux'): AttrConflict => ({ key: attrKey(a), kind: a.script ? 'script' : fluxChanged ? 'both-changed' : 'edited-in-e3', e3, sent, flux, applied, ...(decision ? { decided: true } : {}) });
  if (decision === 'flux') return { write: true, conflict: conflict('flux') };
  if (decision === 'e3') return { write: false, conflict: conflict('e3') };
  const mode = a.conflict ?? 'ask';
  if (mode === 'flux') return { write: true, conflict: conflict('flux') };
  if (mode === 'ask') return { write: false, conflict: conflict('e3'), ask: true };
  return { write: false, conflict: conflict('e3') };
}

export function compareNode(sent: Binding | undefined, now: ExportNode, inE3: E3BoundBlock | undefined, opts: CompareOptions = {}): NodeAction {
  const d = opts.decisions || {};
  const id = now.elementId;
  const base = { elementId: id, attrs: [] as ExportAttr[], rect: now.rect, keptE3: [] as string[] };
  const attrs = now.attrs.filter(writable).filter((a) => a.value !== '');
  const label = now.tag || id;

  // С4: позиция снята во Flux. В E3 молча не удаляем; по умолчанию — оставить и пометить FLUX_STATUS = снята
  if (now.removed) {
    if (!sent || sent.state === 'DETACHED' || sent.state === 'REMOVED_IN_FLUX') return { ...base, kind: 'skip', reason: 'removed-handled' };
    if (!inE3) return { ...base, kind: 'detach', reason: 'removed-gone' };
    const choice = d[`${id}|removed`] || 'mark';
    const question = q(`${id}|removed`, id, 'removed', `${label}: снята во Flux, а в схеме стоит`, [
      { value: 'mark', label: 'оставить и пометить «снята»' }, { value: 'detach', label: 'оставить и отвязать' }, { value: 'delete', label: 'удалить из E3' }, { value: 'keep', label: 'оставить как есть' }], 'mark');
    if (choice === 'delete') return { ...base, kind: 'remove', rect: inE3.rect, questions: [question] };
    if (choice === 'detach') return { ...base, kind: 'detach', questions: [question] };
    if (choice === 'keep') return { ...base, kind: 'skip', reason: 'removed-kept', questions: [question] };
    return { ...base, kind: 'mark-removed', attrs: [{ name: 'FLUX_STATUS', value: 'снята', owner: '' }], questions: [question] };
  }

  // С16: выбрать одно решение нельзя — узел пропускается, остальные выгружаются
  if (now.status === 'many') return { ...base, kind: 'skip', reason: 'need-answer' };
  if (now.status === 'none') return { ...base, kind: 'skip', reason: 'blocked' };
  if (!now.checked) return { ...base, kind: 'skip', reason: 'not-checked' };

  const place = (extra: Partial<NodeAction> = {}): NodeAction => {
    // С20: решение убрали из каталога — новые блоки с ним запрещены, стоящие не трогаем
    if (now.solutionRemoved) return { ...base, kind: 'skip', reason: 'solution-removed' };
    return { ...base, kind: 'place', attrs, designation: now.designation, ...extra };
  };

  // С6: новая позиция заменяет старую (`replacedBy`): блок меняется на том же месте
  if (opts.replaces) {
    const old = opts.replaces.inE3;
    if (now.solutionRemoved) return { ...base, kind: 'skip', reason: 'solution-removed' };
    if (!old) return place({ replaces: opts.replaces.id, note: 'Старого блока в E3 уже нет: новый ставится на холсте' });
    return { ...base, kind: 'replace', attrs, designation: now.designation, rect: old.rect, replaces: opts.replaces.id, dangling: danglingPins(old, opts.pins?.get(now.solutionName)), note: 'Заменяет прежнюю позицию на том же месте' };
  }

  // С5: новая позиция — ставится, если отмечена (отметка проверена выше)
  if (!sent) return place();
  // Отвязанное (С4, С11) больше не предлагается, пока инженер не скажет «выгрузить снова»
  if (sent.state === 'DETACHED') return d[`${id}|deleted`] === 'redo' ? place() : { ...base, kind: 'skip', reason: 'detached' };

  // С11: инженер удалил устройство в E3
  if (!inE3) {
    const question = q(`${id}|deleted`, id, 'deleted', `${label}: удалён в E3`, [
      { value: 'skip', label: 'не восстанавливать сейчас' }, { value: 'redo', label: 'выгрузить снова' }, { value: 'detach', label: 'на схеме не нужно — отвязать' }], 'skip');
    const choice = d[`${id}|deleted`];
    if (choice === 'redo') return { ...place(), questions: [question] };
    if (choice === 'detach') return { ...base, kind: 'detach', reason: 'deleted-in-e3', questions: [question] };
    return { ...base, kind: 'skip', reason: 'deleted-in-e3', questions: [question] };
  }

  if (sent.solutionId !== now.solutionId) {
    // С14: решение сменилось из-за классификатора или профиля — по умолчанию не меняем, показываем «по новым правилам»
    if (now.rulesChanged) {
      const question = q(`${id}|rules`, id, 'rules', `${label}: по новым правилам: ${now.solutionName} (в схеме ${inE3.solutionId})`, [{ value: 'keep', label: 'оставить как есть' }, { value: 'apply', label: 'заменить по новым правилам' }], 'keep');
      if (d[`${id}|rules`] !== 'apply') return { ...base, kind: 'keep', rect: inE3.rect, proposal: { solutionId: now.solutionId, solutionName: now.solutionName }, questions: [question] };
      return { ...base, kind: 'replace', attrs, designation: now.designation, rect: inE3.rect, dangling: danglingPins(inE3, opts.pins?.get(now.solutionName)), questions: [question], note: 'Заменено по новым правилам с согласия инженера' };
    }
    // С3: ответ на признак изменился — ставим новый блок на место старого, висящие провода — в отчёт
    if (now.solutionRemoved) return { ...base, kind: 'skip', reason: 'solution-removed' };
    return { ...base, kind: 'replace', attrs, designation: now.designation, rect: inE3.rect, dangling: danglingPins(inE3, opts.pins?.get(now.solutionName)), note: 'Другое решение: блок ставится на место старого' };
  }

  // С10: положение берётся из E3, блок не двигаем
  const movedInE3 = !same(inE3.rect.x, sent.x) || !same(inE3.rect.y, sent.y);
  const keptE3: string[] = [];
  const changed: ExportAttr[] = [];
  const conflicts: AttrConflict[] = [];
  const questions: PlanQuestion[] = [];
  // С1 и С2: изменилось значение у блока или изделия — пишем только изменившееся. С8, С9, С19: значение правили и в E3
  for (const a of attrs) {
    const key = attrKey(a);
    const j = judge(a, sent.sentAttrs[key], inE3.attrs?.[key], d[`${id}|attr:${key}`]);
    if (j.conflict) {
      conflicts.push(j.conflict);
      if (j.ask) questions.push(q(`${id}|attr:${key}`, id, 'attr', `${label}: ${a.name} — значение правили в E3`, [{ value: 'e3', label: 'оставить значение E3' }, { value: 'flux', label: 'записать значение Flux' }], 'e3', { e3: j.conflict.e3, sent: j.conflict.sent, flux: j.conflict.flux }));
    }
    if (j.write) changed.push(a); else if (j.conflict) keptE3.push(key);
  }
  // С7: тег изменился — обозначение меняется, если инженер его не правил в E3
  const designationChanged = now.designation !== sent.designation && (inE3.designation === sent.designation || inE3.designation === '');
  if (now.designation !== sent.designation && !designationChanged) keptE3.push('Device Designation');

  const extra = { movedInE3, keptE3, ...(conflicts.length ? { conflicts } : {}), ...(questions.length ? { questions } : {}), ...(opts.unlink?.length ? { unlink: opts.unlink } : {}) };
  if (!changed.length && !designationChanged) return { ...base, kind: 'keep', rect: inE3.rect, ...extra };
  return { ...base, kind: 'update', attrs: changed, ...(designationChanged ? { designation: now.designation } : {}), rect: inE3.rect, ...extra };
}

/**
 * С15: ручной выбор решения держится, пока у позиции тот же тип. Сменился тип —
 * ручной выбор снимается и показывается новый подбор.
 */
export function resolveManualChoice(manual: { solutionId: string; cls: string } | undefined, nowCls: string, auto: string): { solutionId: string; dropped: boolean } {
  if (manual && manual.cls === nowCls) return { solutionId: manual.solutionId, dropped: false };
  return { solutionId: auto, dropped: !!manual };
}

/** С20: где стоят блоки решения, которого больше нет в каталоге или в базе E3 */
export const whereStands = (solutionId: string, bindings: Binding[]): string[] => bindings.filter((b) => b.solutionId === solutionId && b.state === 'PLACED').map((b) => b.elementId);
