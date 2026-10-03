import { validateCatalogDataIssue as validateContract, type CatalogDataIssueContext } from '../../../feedback/catalogDataIssue';

export type { CatalogDataIssue, CatalogDataIssueContext } from '../../../feedback/catalogDataIssue';

/** Заголовок обращения остаётся полезным, даже если имя отсутствует в старых данных. */
export function catalogDataIssueTitle(context: CatalogDataIssueContext): string {
  const entity = context.entityTitle.trim() || context.entityId.trim() || 'элемент каталога';
  return `Неточность в данных: ${entity}`.slice(0, 160);
}

export function validateCatalogDataIssue(
  context: CatalogDataIssueContext,
  description: string,
  proposedValue: string,
  sourceText: string,
): string {
  if (description.trim().length < 2) return 'Опишите, в чём неточность';
  if (description.trim().length > 20000) return 'Описание не длиннее 20000 знаков';
  const checked = validateContract({
    namespace: 'catalogDataIssue', context,
    ...(proposedValue.trim() ? { proposedValue: proposedValue.trim() } : {}),
    ...(sourceText.trim() ? { sourceText: sourceText.trim() } : {}),
  });
  return checked.ok ? '' : checked.error || 'Проверьте сведения об элементе';
}
