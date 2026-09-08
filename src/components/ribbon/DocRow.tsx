/**
 * Сведения о документе — в полосе вкладок, а не отдельной строкой.
 *
 * Раньше это была своя полоса в 34 точки над лентой. Она повторяла заголовок
 * окна, который и так показывает имя документа, — то есть отбирала у листа
 * строку ради повтора. Теперь те же кнопки живут по краям полосы вкладок:
 * слева «куда я вернусь → что это», справа «в каком оно состоянии → кто ещё
 * тут → цело ли оно». Порядок вопросов прежний, и он одинаков во всех четырёх
 * редакторах — ради этого рама и общая.
 */
import React, { useState } from 'react';
import { ArrowLeft, MoreHorizontal, WifiOff } from 'lucide-react';
import { initial, peersLabel, extraPeers, MAX_AVATARS, type Peer } from '../../lib/collab';

export interface DocRowMenuItem {
  label: string;
  hint?: string;
  run: () => void;
}

/** Участник в шапке — тот же, что в комнате документа (src/lib/collab.ts) */
export type DocRowPeer = Peer;

export interface DocRowProps {
  icon: React.ReactNode;
  name: string;
  onRename: (v: string) => void;
  onClose: () => void;
  /** Стадия документа: чип того же цвета, что в Проводнике */
  stage?: { label: string; tone: 'draft' | 'check' | 'agreed' | 'issued' } | null;
  onStage?: () => void;
  revision?: string | null;
  onRevision?: () => void;
  scope?: 'SHARED' | 'PERSONAL';
  onScope?: (v: string) => void;
  /** К чему документ относится. Пусто — «Привязать» */
  tag?: string | null;
  onTag?: () => void;
  peers?: DocRowPeer[];
  /**
   * Что со связью, если с ней плохо (текст готовит collab.linkNote). Пусто —
   * связь есть. Молчать об обрыве нельзя: человек продолжает печатать, считая,
   * что коллеги это видят, — а они не видят.
   */
  link?: string;
  /** «сохранено» / «сохраняю…» / «не сохранено — разберите правку» */
  saveState: 'saved' | 'saving' | 'idle' | 'conflict';
  menu?: DocRowMenuItem[];
}

const STAGE_TONE: Record<string, string> = {
  draft: 'bg-slate-100 dark:bg-slate-850 text-slate-600 dark:text-slate-350',
  check: 'bg-amber-50 dark:bg-amber-950/40 text-amber-700 dark:text-amber-400',
  agreed: 'bg-sky-50 dark:bg-sky-950/40 text-sky-700 dark:text-sky-400',
  issued: 'bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-400',
};

/** Левый край полосы вкладок: возврат, значок и имя документа */
export function DocIdentity(p: DocRowProps) {
  return (
    <>
      <button type="button" onClick={p.onClose} title="Вернуться туда, откуда открыли"
        className="shrink-0 h-[26px] w-7 flex items-center justify-center rounded-md text-slate-500
                   hover:bg-slate-100 dark:hover:bg-slate-850 hover:text-slate-800
                   dark:hover:text-slate-150 cursor-pointer">
        <ArrowLeft className="w-3.5 h-3.5" />
      </button>
      <span className="shrink-0 flex items-center">{p.icon}</span>
      <input
        value={p.name}
        onChange={(e) => p.onRename(e.target.value)}
        title="Имя документа — то же, что на значке стола"
        className="shrink text-2xs font-bold text-slate-800 dark:text-slate-150 bg-transparent w-28 @[900px]:w-44
                   border-b border-transparent hover:border-slate-300 dark:hover:border-slate-700
                   focus:border-emerald-500 focus:outline-none px-1 py-0.5"
      />
    </>
  );
}

/** Правый край полосы вкладок: стадия, ревизия, коллеги, состояние сохранения */
export function DocStatus(p: DocRowProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const saved = p.saveState === 'saving' ? 'сохраняю…'
    : p.saveState === 'conflict' ? 'не сохранено — разберите правку'
      : p.saveState === 'saved' ? 'сохранено' : '';

  return (
    <>
      {p.stage && (
        <button type="button" onClick={p.onStage} disabled={!p.onStage}
          title="Стадия документа"
          className={`shrink-0 px-2 h-5 rounded-full text-[10px] font-bold ${STAGE_TONE[p.stage.tone]}
                      ${p.onStage ? 'cursor-pointer' : 'cursor-default'}`}>
          {p.stage.label}
        </button>
      )}
      {p.revision && (
        <button type="button" onClick={p.onRevision} disabled={!p.onRevision}
          title="История версий этой ревизии и выпуск следующей"
          className={`shrink-0 text-[10px] font-mono font-bold text-slate-500 dark:text-slate-400
                      ${p.onRevision ? 'cursor-pointer hover:text-emerald-600' : 'cursor-default'}`}>
          ред. {p.revision}
        </button>
      )}
      {p.scope && p.onScope && (
        <select value={p.scope} onChange={(e) => p.onScope?.(e.target.value)}
          title="Общий — виден всем; Личный — только вам"
          className="shrink-0 h-5 text-[10px] font-semibold px-1.5 rounded-md border border-slate-200
                     dark:border-slate-800 bg-white dark:bg-slate-950 text-slate-600 dark:text-slate-350 cursor-pointer">
          <option value="SHARED">Общий</option>
          <option value="PERSONAL">Личный</option>
        </select>
      )}
      {p.onTag && (
        <button type="button" onClick={p.onTag}
          title="К чему относится документ. Отсюда он попадает в связи проекта"
          className="shrink-0 h-5 px-2 rounded-md text-[10px] font-bold text-emerald-700 dark:text-emerald-400
                     hover:bg-emerald-50 dark:hover:bg-emerald-950/40 cursor-pointer">
          ◆ {p.tag || 'Привязать'}
        </button>
      )}
      {!!p.peers?.length && (
        <div className="flex items-center shrink-0" title={peersLabel(p.peers)}>
          <div className="flex -space-x-1.5">
            {p.peers.slice(0, MAX_AVATARS).map((x) => (
              <div key={x.socketId} title={x.name}
                className="w-5 h-5 rounded-full flex items-center justify-center text-[9px] font-black text-white
                           ring-2 ring-white dark:ring-slate-900"
                style={{ background: x.color }}>
                {initial(x.name)}
              </div>
            ))}
          </div>
          {/* Шестой и дальше — числом: пять кружков помещаются, восемь съедают
              имя документа, а «кто ещё» отвечает и число */}
          {extraPeers(p.peers) > 0 && (
            <span className="ml-1 text-[10px] font-bold text-slate-500 dark:text-slate-400 tabular-nums">
              +{extraPeers(p.peers)}
            </span>
          )}
        </div>
      )}
      {!!p.link && (
        <span title="Пока связи нет, ваши правки не уходят коллегам, а их правки не приходят вам"
          className="shrink-0 flex items-center gap-1 text-[10px] font-semibold
                     text-amber-600 dark:text-amber-400">
          <WifiOff className="w-3 h-3" /> {p.link}
        </span>
      )}
      {/* Состояние сохранения прячется в узком окне: место нужнее вкладкам, а
          «сохранено» — это подтверждение, а не предупреждение. Тревожное
          «не сохранено» остаётся видно всегда */}
      <span className={`shrink-0 text-[10px] ${p.saveState === 'conflict'
        ? 'text-amber-600 dark:text-amber-400 font-semibold' : 'hidden @[760px]:inline text-slate-400 dark:text-slate-455'}`}>
        {saved}
      </span>
      {!!p.menu?.length && (
        <div className="relative shrink-0">
          <button type="button" onClick={() => setMenuOpen((v) => !v)} title="Ещё о документе"
            className="p-1 rounded-md text-slate-400 hover:text-slate-700 dark:hover:text-slate-150
                       hover:bg-slate-100 dark:hover:bg-slate-850 cursor-pointer">
            <MoreHorizontal className="w-3.5 h-3.5" />
          </button>
          {menuOpen && (
            <>
              <div className="fixed inset-0 z-40" onClick={() => setMenuOpen(false)} />
              <div className="absolute right-0 top-full mt-1 z-50 w-64 py-1 rounded-xl shadow-2xl
                              bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800">
                {p.menu.map((m) => (
                  <button key={m.label} type="button"
                    onClick={() => { setMenuOpen(false); m.run(); }}
                    className="w-full text-left px-3 py-1.5 hover:bg-slate-100 dark:hover:bg-slate-850 cursor-pointer">
                    <span className="block text-2xs font-bold text-slate-700 dark:text-slate-300">{m.label}</span>
                    {m.hint && <span className="block text-[10px] text-slate-400 dark:text-slate-455 leading-snug">{m.hint}</span>}
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
      )}
    </>
  );
}
