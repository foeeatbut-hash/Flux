import { useTagNavigationStore } from '../store/tagNavigationStore';

/** Редактор передаёт адрес, а не данные: проверяем тег и проект на сервере. */
export async function openEditorTag(projectId: string, target: { tagId?: string; identifier?: string } | undefined): Promise<void> {
  if (!projectId || !target || (!target.tagId && !target.identifier)) return;
  const r = await fetch(`/api/projects/${encodeURIComponent(projectId)}/tags`);
  if (!r.ok) return;
  const data = await r.json();
  const wanted = String(target.identifier || '').replace(/^#/, '').toLocaleLowerCase('ru');
  const tags = data.tags || [];
  const matches = tags.filter((t: any) => target.tagId ? t.id === target.tagId : String(t.identifier).toLocaleLowerCase('ru') === wanted);
  if (matches.length === 1) useTagNavigationStore.getState().open({ projectId, tagId: matches[0].id, identifier: matches[0].identifier });
}
