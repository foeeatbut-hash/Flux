/**
 * Один смонтированный экземпляр раздела: keep-alive и «замороженный» роутер.
 *
 * Скрытый раздел остаётся в дереве (display:none) и не должен реагировать на
 * смену общего адреса — иначе, уйдя в Теги и вернувшись, человек нашёл бы
 * Конструктор с закрытым документом. Поэтому у каждого экземпляра свои
 * контексты react-router с застывшим location, а у живого — общий.
 *
 * Вынесено из Workspace отдельным файлом: тем же механизмом живут и окна.
 * Две копии keep-alive однажды разошлись бы, и разошлись бы незаметно.
 */
import React, { Suspense } from 'react';
import {
  Navigate, NavigationType, UNSAFE_LocationContext, UNSAFE_NavigationContext,
} from 'react-router-dom';
import type { Location, To } from 'react-router-dom';
import { useWorkspaceStore } from '../store/workspaceStore';
import { useWindowStore } from '../store/windowStore';
import { sectionForPath } from '../workspace/sections';
import { useStore } from '../store/store';
import SectionErrorBoundary from './SectionErrorBoundary';
import { PaneContext } from '../lib/paneTitle';
import { can, featureById } from '../lib/permissions';

export const asHref = (l: Location | { pathname: string; search?: string; hash?: string }) =>
  `${l.pathname}${l.search || ''}${l.hash || ''}`;

export function makeLocation(to: To, state: any = null): Location {
  if (typeof to === 'string') {
    const url = new URL(to, 'http://x');
    return { pathname: url.pathname, search: url.search, hash: url.hash, state, key: Math.random().toString(36).slice(2) };
  }
  return { pathname: to.pathname || '/', search: to.search || '', hash: to.hash || '', state, key: Math.random().toString(36).slice(2) };
}

export default function SectionFrame({
  paneId,
  path,
  href,
  isLive,
  visible,
  liveLocation,
  globalNavigate,
}: {
  paneId: string;
  path: string;
  /**
   * Адрес этого экземпляра, если он известен раме (у окон — да).
   *
   * Нужен потому, что окно опознаётся адресом: только что открытое окно
   * обязано сразу показать свой документ, а не библиотеку раздела.
   */
  href?: string;
  isLive: boolean;
  visible: boolean;
  liveLocation: Location;
  globalNavigate: (to: To, opts?: any) => void;
}) {
  const def = sectionForPath(path);
  const user = useStore((s) => s.user);
  const setFrozenHref = useWorkspaceStore((s) => s.setFrozenHref);
  const dropFrozen = useWorkspaceStore((s) => s.dropFrozen);
  const initialHref = useWorkspaceStore.getState().frozenHrefs[`${paneId}::${path}`];
  const [frozenLoc, setFrozenLoc] = React.useState<Location>(() => makeLocation(href || initialHref || path));

  /**
   * Рама сказала, что у этого экземпляра другой адрес, — принимаем.
   *
   * Так единичный раздел переезжает на новый документ в том же окне: окон у
   * него не бывает двух, и открыть письмо ему больше негде.
   */
  React.useEffect(() => {
    if (href && href !== asHref(frozenLoc)) setFrozenLoc(makeLocation(href));
  }, [href]);

  // Пока раздел живой — запоминаем его location, чтобы при возврате открыть там же
  React.useEffect(() => {
    if (isLive && liveLocation.pathname === path) {
      // Окно принимает только собственный переход. Чужой адрес ему сейчас
      // показывают на один кадр, пока оболочка решает, какое окно его откроет;
      // запомнив его, окно забрало бы себе чужой документ — и два окна начали
      // бы спорить автосохранением за одну книгу
      const from = (liveLocation.state as any)?.__pane;
      if (paneId.startsWith('win:') && from !== paneId) return;
      setFrozenLoc(liveLocation);
      setFrozenHref(paneId, path, asHref(liveLocation));
    }
  }, [isLive, liveLocation, path, paneId, setFrozenHref]);

  /**
   * Живой экземпляр обычно показывает общий адрес программы. Но в оболочке окон
   * общий адрес на мгновение бывает чужим — это тот кадр, в котором оболочка
   * ещё не открыла нужное окно. Показывать в этот момент чужой документ нельзя:
   * движок таблицы успевает загрузить книгу, и человек видит мигание.
   */
  const foreign = paneId.startsWith('win:')
    && !!href
    && asHref(liveLocation) !== href
    && (liveLocation.state as any)?.__pane !== paneId;
  const location = isLive && !foreign ? liveLocation : frozenLoc;

  const navigator = React.useMemo(
    () => ({
      createHref: (to: To) => (typeof to === 'string' ? to : asHref({ pathname: to.pathname || '/', search: to.search, hash: to.hash })),
      encodeLocation: (to: To) => makeLocation(to),
      go: () => {},
      // Кто перешёл — важно оболочке: переход внутри окна оставляет человека в
      // этом же окне, а тот же адрес, пришедший снаружи (значок стола, ссылка,
      // помощник), открывает своё окно. По самому адресу это неразличимо
      push: (to: To, state?: any) => (isLive
        ? globalNavigate(to, { state: { ...(state || {}), __pane: paneId } })
        : setFrozenLoc(makeLocation(to, state))),
      replace: (to: To, state?: any) => (isLive
        ? globalNavigate(to, { state: { ...(state || {}), __pane: paneId }, replace: true })
        : setFrozenLoc(makeLocation(to, state))),
    }),
    [isLive, globalNavigate, paneId],
  );

  if (def.adminOnly && user?.role !== 'ADMIN') {
    return visible ? <Navigate to="/" replace /> : null;
  }

  // Раздел, закрытый правом, отвечает словами, а не пустотой и не уводом на
  // Главную: человек должен понять, что дело в праве, а не в поломке
  if (def.feature && user?.role !== 'ADMIN' && !can(user as any, def.feature)) {
    if (!visible) return null;
    const what = featureById(def.feature)?.label || def.feature;
    return (
      <div className="h-full flex items-center justify-center p-8">
        <div className="max-w-sm text-center">
          <div className="text-sm font-bold text-slate-800 dark:text-white mb-1">Раздел закрыт</div>
          <div className="text-xs text-slate-500 dark:text-slate-400 leading-relaxed">
            «{def.title}» доступен по праву «{what}». Его выдаёт администратор — в разделе «Сотрудники».
          </div>
        </div>
      </div>
    );
  }

  const Comp = def.Component;
  // Собственный контекст роутера для этого экземпляра раздела: нельзя вкладывать
  // <Router> в <Router>, поэтому подменяем location/navigator напрямую через
  // контексты react-router (ровно то, что делает <Router> внутри, но без запрета
  // на вложенность). Так скрытый раздел «заморожен» и не реагирует на смену URL.
  const navContext = React.useMemo<any>(() => ({ basename: '', navigator: navigator as any, static: false }), [navigator]);
  const locContext = React.useMemo(() => ({ location, navigationType: NavigationType.Pop }), [location]);
  return (
    <div
      /* Отступ уменьшен с 24 до 10 px: раздел — лист, а не карточка,
         плавающая в сером поле. Поле шириной в палец вокруг каждого
         экрана съедало место и выглядело одинаково в любой программе */
      className={`absolute inset-0 ${def.pad ? 'p-2.5' : ''} ${def.scroll === 'fixed' ? 'overflow-hidden' : 'overflow-y-auto'}`}
      style={{ display: visible ? 'block' : 'none' }}
      aria-hidden={!visible}
    >
      <PaneContext.Provider value={paneId}>
      <UNSAFE_NavigationContext.Provider value={navContext}>
        <UNSAFE_LocationContext.Provider value={locContext}>
          {/* Граница внутри окна: сбой одного раздела не должен уносить
              соседние — они смонтированы рядом и держат несохранённые правки.
              «Закрыть» закрывает ОКНО: раньше здесь звали закрытие вкладки
              панели с ключом вида `win:<id>`, которого среди панелей не было
              никогда, и кнопка тихо не делала ничего */}
          <SectionErrorBoundary title={def.title} onClose={() => {
            dropFrozen(paneId, path);
            const id = paneId.startsWith('win:') ? paneId.slice(4) : '';
            if (id) useWindowStore.getState().close(id);
          }}>
            <Suspense fallback={<div className="w-full h-full flex items-center justify-center py-24"><div className="w-8 h-8 rounded-full border-2 border-emerald-500 border-t-transparent animate-spin" /></div>}>
              <Comp />
            </Suspense>
          </SectionErrorBoundary>
        </UNSAFE_LocationContext.Provider>
      </UNSAFE_NavigationContext.Provider>
      </PaneContext.Provider>
    </div>
  );
}
