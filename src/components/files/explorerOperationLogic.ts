import type { WindowsFileChoice, WindowsPublishPlan, WindowsPublishChoices, WindowsPublishPlanItem, WindowsFileRef } from '../../lib/windowsFiles';

/** Для каждого конфликта выбирается действие явно; заблокированные объекты не отправляются как решения. */
export function choicesForPlan(plan: WindowsPublishPlan, chosen: WindowsFileChoice | WindowsPublishChoices): WindowsPublishChoices {
  const choices = typeof chosen === 'string' ? Object.fromEntries(plan.items.map((item) => [item.draftId, chosen])) : chosen;
  return Object.fromEntries(plan.items.filter((item) => item.status === 'collision' && choices[item.draftId] && (choices[item.draftId] !== 'replace' || item.replaceable !== false)).map((item) => [item.draftId, choices[item.draftId]]));
}

export function publishRequestFor(plan: WindowsPublishPlan): 'publishDraft' | 'publishDraftTree' {
  return plan.items.some((item) => item.kind === 'directory') ? 'publishDraftTree' : 'publishDraft';
}

export function clipboardAction(ref: WindowsFileRef, parent: WindowsFileRef, copyModifier: boolean): 'copy' | 'move' {
  return copyModifier || ref.rootId !== parent.rootId ? 'copy' : 'move';
}

export function planSummary(items: WindowsPublishPlanItem[]) {
  return {
    collisions: items.filter((item) => item.status === 'collision').length,
    blocked: items.filter((item) => item.status === 'blocked').length,
    free: items.filter((item) => item.status === 'free').length,
  };
}
