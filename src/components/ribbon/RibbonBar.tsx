/**
 * Полоса вкладок и лента под ней.
 *
 * Лента не переносится на вторую строку и не обрезается по краю окна: когда
 * места нет, группы схлопываются в кнопку с многоточием — справа налево, по
 * весу, заданному в описании вкладки. Нажатие раскрывает группу списком.
 * Вкладки, не влезшие в полосу, уходят под «▾» в её конце — так же, как кнопки
 * разделов на панели задач. Пропасть без следа не может ничего.
 *
 * Лента сворачивается по Ctrl+F1 и двойному нажатию по вкладке: вкладки
 * остаются, лента уходит целиком. В окне высотой 660 это возвращает листу 70
 * точек.
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  collapseGroups, fitTabs, GAP, GROUP_PAD, RIBBON_H, TABS_H,
  type RibbonGroup, type RibbonTab,
} from '../../lib/ribbon';
import Organ from './Organ';

export interface RibbonBarProps {
  tabs: RibbonTab[];
  active: string;
  onActive: (name: string) => void;
  /** Включённые переключатели и значения полей: ключ — команда органа */
  state?: Record<string, boolean | string>;
  /** Причины недоступности: ключ — команда, значение — почему нельзя */
  disabled?: Record<string, string>;
  /** Команды, просящие внимания (янтарные) */
  attention?: Record<string, boolean>;
  onCommand: (id: string, value?: string) => void;
  /** «Файл» — не вкладка, а экран: открывается отдельно */
  onFile?: () => void;
  /** Свёрнута ли лента; управляется снаружи, чтобы состояние переживало вкладки */
  folded: boolean;
  onFold: (v: boolean) => void;
  /**
   * Сведения о документе по краям полосы вкладок.
   *
   * Раньше под них была отведена своя полоса в 34 точки, и она повторяла
   * заголовок окна. Полоса вкладок при этом наполовину пустовала: вкладок у
   * редактора четыре-пять. Теперь обе живут в одной строке, и лист получает
   * эти 34 точки обратно.
   */
  docLeft?: React.ReactNode;
  docRight?: React.ReactNode;
}

/** Группа: органы в один ряд плюс подпись снизу */
function Group({ group, state, disabled, attention, onCommand }: {
  group: RibbonGroup;
  state?: Record<string, boolean | string>;
  disabled?: Record<string, string>;
  attention?: Record<string, boolean>;
  onCommand: (id: string, value?: string) => void;
}) {
  return (
    <div data-group={group.name}
      className="flex flex-col justify-between h-full shrink-0 border-r border-slate-150 dark:border-slate-850"
      style={{ paddingLeft: GROUP_PAD, paddingRight: GROUP_PAD }}>
      <div className="flex items-center flex-1" style={{ gap: GAP }}>
        {group.organs.map((o) => (
          <Organ key={o.id} organ={o} value={state?.[o.id]} disabled={disabled?.[o.id]}
            attention={attention?.[o.id]} onRun={onCommand} />
        ))}
      </div>
      <div className="text-[9px] uppercase tracking-[0.07em] text-slate-400 dark:text-slate-455 text-center font-mono">
        {group.name}
      </div>
    </div>
  );
}

/** Схлопнутая группа: многоточие, по нажатию — та же группа списком */
function Collapsed({ group, ...rest }: {
  group: RibbonGroup;
  state?: Record<string, boolean | string>;
  disabled?: Record<string, string>;
  attention?: Record<string, boolean>;
  onCommand: (id: string, value?: string) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div data-group={group.name} data-collapsed="1"
      className="relative flex flex-col justify-between h-full shrink-0 border-r border-slate-150 dark:border-slate-850"
      style={{ paddingLeft: GROUP_PAD, paddingRight: GROUP_PAD }}>
      <button type="button" onClick={() => setOpen((v) => !v)}
        title={`${group.name}: раскрыть группу`} aria-expanded={open}
        className="flex-1 w-7 flex items-center justify-center rounded-md text-slate-500 dark:text-slate-400
                   hover:bg-slate-100 dark:hover:bg-slate-850 cursor-pointer transition-ui">
        ⋯
      </button>
      <div className="text-[9px] uppercase tracking-[0.07em] text-slate-400 dark:text-slate-455 text-center font-mono">
        {group.name}
      </div>
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute left-0 top-full z-50 mt-1 p-2 rounded-xl shadow-2xl
                          bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800"
            onClick={() => setOpen(false)}>
            <div className="flex flex-wrap gap-1 max-w-72">
              {group.organs.map((o) => (
                <Organ key={o.id} organ={o} value={rest.state?.[o.id]} disabled={rest.disabled?.[o.id]}
                  attention={rest.attention?.[o.id]} onRun={rest.onCommand} />
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

export default function RibbonBar({
  tabs, active, onActive, state, disabled, attention, onCommand, onFile, folded, onFold,
  docLeft, docRight,
}: RibbonBarProps) {
  const barRef = useRef<HTMLDivElement>(null);
  const tabsRef = useRef<HTMLDivElement>(null);
  const [barW, setBarW] = useState(1200);
  const [tabsW, setTabsW] = useState(1200);
  const [moreTabs, setMoreTabs] = useState(false);

  // Ширины меряем живьём: окно тянут мышью, и раскладка обязана поспевать
  useEffect(() => {
    const measure = () => {
      if (barRef.current) setBarW(barRef.current.clientWidth);
      if (tabsRef.current) setTabsW(tabsRef.current.clientWidth);
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    if (barRef.current) ro.observe(barRef.current);
    if (tabsRef.current) ro.observe(tabsRef.current);
    return () => ro.disconnect();
  }, []);

  const names = useMemo(() => tabs.map((t) => t.name), [tabs]);
  const { shown, hidden } = useMemo(
    () => fitTabs(names, tabsW, active), [names, tabsW, active],
  );
  const tab = tabs.find((t) => t.name === active) || tabs[0];
  const collapsed = useMemo(
    () => (tab ? collapseGroups(tab.groups, barW - 2) : new Set<string>()),
    [tab, barW],
  );

  // Ctrl+F1 — свернуть ленту. Сочетание то же, что в Ворде: менять привычное
  // в этом месте не находка, а препятствие
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.key === 'F1') { e.preventDefault(); onFold(!folded); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [folded, onFold]);

  if (!tab) return null;

  return (
    <div className="shrink-0 bg-white dark:bg-slate-900">
      {/* Полоса вкладок */}
      <div className="flex items-center gap-1 px-2 border-b border-slate-200 dark:border-slate-800"
        style={{ height: TABS_H }}>
        {docLeft}
        {docLeft && <span className="shrink-0 w-px h-4 bg-slate-200 dark:bg-slate-800" />}
        {onFile && (
          <button type="button" onClick={onFile}
            className="h-[26px] px-3 rounded-t-md text-2xs font-bold text-white bg-emerald-600
                       hover:bg-emerald-700 cursor-pointer transition-ui">
            Файл
          </button>
        )}
        <div ref={tabsRef} className="flex items-center gap-0.5 flex-1 min-w-0 overflow-hidden">
          {shown.map((n) => {
            const t = tabs.find((x) => x.name === n);
            const isOn = n === active;
            return (
              <button key={n} type="button" role="tab" aria-selected={isOn}
                onClick={() => onActive(n)}
                onDoubleClick={() => onFold(!folded)}
                className={`h-[26px] px-2.5 rounded-t-md text-2xs font-bold whitespace-nowrap cursor-pointer transition-ui
                  ${isOn
                    ? 'bg-slate-50 dark:bg-slate-950 text-slate-800 dark:text-slate-150 border border-b-0 border-slate-200 dark:border-slate-800'
                    : 'text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-850'}
                  ${t?.context ? 'border-t-2 border-t-sky-500' : ''}`}>
                {n}
              </button>
            );
          })}
        </div>
        {hidden.length > 0 && (
          <div className="relative shrink-0">
            <button type="button" onClick={() => setMoreTabs((v) => !v)}
              title="Вкладки, не поместившиеся в полосу"
              className="h-[26px] px-2 text-2xs text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-850 rounded-t-md cursor-pointer">
              ▾
            </button>
            {moreTabs && (
              <>
                <div className="fixed inset-0 z-40" onClick={() => setMoreTabs(false)} />
                <div className="absolute right-0 top-full z-50 mt-1 py-1 w-52 rounded-xl shadow-2xl
                                bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800">
                  {hidden.map((n) => (
                    <button key={n} type="button"
                      onClick={() => { setMoreTabs(false); onActive(n); }}
                      className="w-full text-left px-3 py-1.5 text-2xs font-semibold text-slate-700 dark:text-slate-300
                                 hover:bg-slate-100 dark:hover:bg-slate-850 cursor-pointer">
                      {n}
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>
        )}
        {docRight && (
          <div className="flex items-center gap-1.5 shrink-0 pl-1">{docRight}</div>
        )}
        <button type="button" onClick={() => onFold(!folded)}
          title={folded ? 'Развернуть ленту (Ctrl+F1)' : 'Свернуть ленту (Ctrl+F1)'}
          className="shrink-0 h-[26px] px-2 text-2xs text-slate-400 hover:text-slate-700 dark:hover:text-slate-150 cursor-pointer">
          {folded ? '▾' : '▴'}
        </button>
      </div>

      {/* Лента. Прокрутка, а не обрезка: у схлопывания есть предел — шесть
          групп даже многоточиями занимают 323 точки, и в панели шириной 250
          лента всё равно не помещается. Обрезанная по краю она теряет группы
          без следа, прокручиваемая — не теряет ничего (так же сделаны кнопки
          на панели задач). Полоса появляется только там, где это случилось */}
      {!folded && (
        <div ref={barRef} className="flex items-stretch overflow-x-auto overflow-y-hidden scrollbar-thin
                                     border-b border-slate-200 dark:border-slate-800
                                     bg-slate-50 dark:bg-slate-950 py-1.5"
          style={{ height: RIBBON_H }}>
          {tab.groups.map((g) => (collapsed.has(g.name)
            ? <Collapsed key={g.name} group={g} state={state} disabled={disabled} attention={attention} onCommand={onCommand} />
            : <Group key={g.name} group={g} state={state} disabled={disabled} attention={attention} onCommand={onCommand} />
          ))}
        </div>
      )}
    </div>
  );
}
