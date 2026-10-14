import React from 'react';
import { windowsFilesRequest, type WindowsFileRef, type WindowsLocationKeys } from '../../lib/windowsFiles';
import type { ProjectFolderBinding, ProjectFolderBindingView } from '../../lib/projectFolderBindings';

const CHUNK = 500;
const CACHE_LIMIT = 5000;
const refKey = (ref: WindowsFileRef) => `${ref.rootId}\0${ref.relativePath}`;

/** Цепочки ключей мест (сама папка → родители → корень ресурса) для ссылок; null — папка не сетевая или ключ не получен. */
export async function fetchLocationChains(refs: WindowsFileRef[]): Promise<Array<string[] | null> | null> {
  const out: Array<string[] | null> = [];
  for (let from = 0; from < refs.length; from += CHUNK) {
    const part = refs.slice(from, from + CHUNK).map(ref => ({ rootId: ref.rootId, relativePath: ref.relativePath, ...(ref.draftId ? { draftId: ref.draftId } : {}) }));
    const answer = await windowsFilesRequest<WindowsLocationKeys>({ action: 'locationKeys', refs: part });
    if (!answer.ok) return null;
    for (const chain of answer.data.chains) out.push(chain ? chain.map(index => answer.data.keys[index]) : null);
  }
  return out;
}

/** Общий журнал привязок: один на всех, поэтому грузится без корня и устройства. */
/** userId нужен только как признак смены сессии: при входе другого человека журнал читается заново. */
export function useBindingLedger(userId: string | undefined) {
  const [view, setView] = React.useState<ProjectFolderBindingView | null>(null);
  const [tick, setTick] = React.useState(0);
  React.useEffect(() => {
    let alive = true;
    // Без входа сервер ответит 401: тогда привязок нет и менять их нельзя.
    const load = () => { void fetch('/api/explorer/project-bindings').then(response => response.ok ? response.json() : null).then((body: ProjectFolderBindingView | null) => { if (alive) setView(body && Array.isArray(body.bindings) ? body : null); }).catch(() => undefined); };
    load();
    // Привязку мог поменять другой человек: при возвращении в окно журнал читается заново.
    let last = Date.now();
    const onFocus = () => { if (Date.now() - last > 15_000) { last = Date.now(); load(); } };
    window.addEventListener('focus', onFocus);
    return () => { alive = false; window.removeEventListener('focus', onFocus); };
  }, [userId, tick]);
  const bindings: ProjectFolderBinding[] = React.useMemo(() => view?.bindings || [], [view]);
  return { bindings, canManage: !!view?.canManage, refresh: React.useCallback(() => setTick(value => value + 1), []) };
}

/**
 * Цепочки ключей для видимых строк. Ключи считает main по строкам пути, без обращений к диску,
 * поэтому открытие корня с сотнями папок не порождает опросов SMB. Результат помнится по ссылке;
 * пока привязок нет вовсе, мост не вызывается совсем.
 */
export function useLocationChains(refs: WindowsFileRef[], enabled: boolean) {
  const cache = React.useRef(new Map<string, string[] | null>());
  const [version, setVersion] = React.useState(0);
  React.useEffect(() => {
    if (!enabled) return;
    const missing = refs.filter(ref => !ref.draftId && !cache.current.has(refKey(ref)));
    if (!missing.length) return;
    let alive = true;
    void fetchLocationChains(missing).then(chains => {
      if (!alive) return;
      if (cache.current.size > CACHE_LIMIT) cache.current.clear();
      // Отказ моста (браузер, старая сборка) запоминается как «нет ключа»: повторных запросов не будет.
      missing.forEach((ref, index) => cache.current.set(refKey(ref), chains ? chains[index] : null));
      setVersion(value => value + 1);
    });
    return () => { alive = false; };
  }, [refs, enabled]);
  const chainOf = React.useCallback((ref: WindowsFileRef) => cache.current.get(refKey(ref)) || null, [version]);
  return { chainOf, version };
}
