import React from 'react';
import type { DocflowConfig } from '../../../shared/docflow/config';
import { linkLookupKey, type DocLinkDto, type IssueDto, type LinkedItemBrief } from '../../../shared/docflow/links';
import { getLinks, getSettings } from '../../lib/docflowApi';

/**
 * Настройки проекта и его связи файлов со строками ВДР — для Проводника и ДО.
 * Грузятся один раз на проект и перечитываются, когда сервер сообщает
 * `vdr:changed` (связали, отвязали, правка строки на другом компьютере).
 */
export interface ProjectDocs {
  projectId: string;
  config: DocflowConfig;
  links: DocLinkDto[];
  items: Record<string, LinkedItemBrief>;
  /** Выпущенные ревизии строк (действующие записи выпуска). */
  issues: IssueDto[];
  /** Действующие связи по «папка + путь»: так Проводник находит связь файла за одно обращение. */
  byPath: Map<string, DocLinkDto>;
}

export const indexLinks = (links: DocLinkDto[]): Map<string, DocLinkDto> =>
  new Map(links.filter((l) => !l.unlinkedAt).map((l) => [linkLookupKey(l.folderKey, l.relativePath), l]));

export function useProjectDocs(projectIds: string[], enabled = true) {
  const [docs, setDocs] = React.useState<Record<string, ProjectDocs>>({});
  const asked = React.useRef(new Set<string>());
  const wanted = [...new Set(projectIds.filter(Boolean))].sort().join('|');

  const load = React.useCallback(async (projectId: string) => {
    const [settings, links] = await Promise.all([getSettings(projectId), getLinks(projectId)]);
    if (!settings.ok) return;
    setDocs((current) => ({
      ...current,
      [projectId]: { projectId, config: settings.data.config, links: links.ok ? links.data.links : [], items: links.ok ? links.data.items : {}, issues: links.ok ? links.data.issues || [] : [], byPath: indexLinks(links.ok ? links.data.links : []) },
    }));
  }, []);

  React.useEffect(() => {
    if (!enabled) return;
    for (const id of wanted.split('|').filter(Boolean)) {
      if (asked.current.has(id)) continue;
      asked.current.add(id);
      void load(id);
    }
  }, [wanted, enabled, load]);

  React.useEffect(() => {
    if (!enabled) return;
    let timer = 0;
    const onChanged = (event: Event) => {
      const projectId = (event as CustomEvent).detail?.projectId as string | undefined;
      window.clearTimeout(timer);
      // Несколько событий подряд (пачка связей) — одно перечитывание
      timer = window.setTimeout(() => { for (const id of asked.current) if (!projectId || projectId === id) void load(id); }, 250);
    };
    window.addEventListener('socket:vdr:changed', onChanged);
    return () => { window.clearTimeout(timer); window.removeEventListener('socket:vdr:changed', onChanged); };
  }, [enabled, load]);

  return { docs, reload: load };
}
