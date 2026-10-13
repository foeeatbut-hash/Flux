import { useCallback, useEffect, useState } from 'react';
import { officeDataApi, type OfficeState, type OfficeTemplate } from './fluxData';

/**
 * Шаблоны шапки: список, закрепление и записи на сервере. Права проверяет
 * сервер (создатель правит и удаляет, остальные используют или копируют);
 * здесь только вызовы и сообщение об ошибке для окна шаблонов.
 */
export function useOfficeTemplates() {
  const [templates, setTemplates] = useState<OfficeTemplate[]>([]);
  const [pinned, setPinned] = useState<string[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const reload = useCallback(async () => {
    const result = await officeDataApi.templates();
    setTemplates(result.templates || []); setPinned(result.pinned || []);
  }, []);
  useEffect(() => {
    let alive = true;
    officeDataApi.templates().then((result) => { if (alive) { setTemplates(result.templates || []); setPinned(result.pinned || []); } })
      .catch((reason) => { if (alive) setError(String(reason?.message || reason)); });
    return () => { alive = false; };
  }, []);

  /** Выполнить действие над шаблонами: ошибка остаётся в окне, а не пропадает. */
  const act = useCallback(async <T,>(action: () => Promise<T>): Promise<T | undefined> => {
    setError(''); setBusy(true);
    try { return await action(); }
    catch (reason: any) { setError(String(reason?.message || reason)); return undefined; }
    finally { setBusy(false); }
  }, []);

  const upsert = (template: OfficeTemplate) => setTemplates((items) => [template, ...items.filter((item) => item.id !== template.id)]);

  const create = useCallback((input: { name: string; description?: string; scope: OfficeTemplate['scope']; schema: OfficeState['schema']; query: Record<string, unknown>; pin?: boolean }) => act(async () => {
    const { template } = await officeDataApi.saveTemplate({ name: input.name, ...(input.description ? { description: input.description } : {}), scope: input.scope, schema: input.schema, query: input.query });
    upsert(template);
    if (input.pin) setPinned((await officeDataApi.pinTemplate(template.id, true)).pinned || []);
    return template;
  }), [act]);

  const update = useCallback((template: OfficeTemplate, body: { schema: OfficeState['schema']; query: Record<string, unknown> }) => act(async () => {
    const { template: updated } = await officeDataApi.updateTemplate(template.id, body);
    upsert(updated);
    return updated;
  }), [act]);

  const copy = useCallback((template: OfficeTemplate) => act(async () => {
    const { template: made } = await officeDataApi.saveTemplate({ name: `${template.name} (копия)`, scope: 'PERSONAL', schema: template.schema as OfficeState['schema'], query: template.query || {}, ...(template.description ? { description: template.description } : {}) });
    upsert(made);
    return made;
  }), [act]);

  const remove = useCallback((template: OfficeTemplate) => act(async () => {
    await officeDataApi.deleteTemplate(template.id);
    setTemplates((items) => items.filter((item) => item.id !== template.id));
    setPinned((ids) => ids.filter((id) => id !== template.id));
  }), [act]);

  const togglePin = useCallback((template: OfficeTemplate) => act(async () => {
    setPinned((await officeDataApi.pinTemplate(template.id, !pinned.includes(template.id))).pinned || []);
  }), [act, pinned]);

  return { templates, pinned, error, busy, setError, reload, create, update, copy, remove, togglePin };
}
