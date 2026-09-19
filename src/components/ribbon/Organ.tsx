/**
 * Один орган управления ленты. Семь видов, и больше никаких.
 *
 * Кнопка обязана отвечать, что с ней: «Ж» — не команда, а переключатель, по
 * нему читают, жирный ли текст под курсором. Поэтому у каждого органа четыре
 * состояния: обычное, наведение, включено, недоступно. Недоступная не
 * исчезает: она гаснет, остаётся на месте и объясняет подсказкой, почему её
 * нельзя нажать. Кнопка, которая исчезает, заставляет искать её заново.
 *
 * Флаксовые команды (те, что работают с данными проекта) помечены зелёным. Это
 * не украшение: в чужой программе такой кнопки не будет, и человеку полезно
 * видеть границу.
 */
import React, { useRef, useState } from 'react';
import { ORGAN_H, BIG_H, organWidth, type Organ as OrganModel } from '../../lib/ribbon';
import { ribbonIcon } from './icons';
import { colorName } from '../../lib/colorName';
import Popover from '../Popover';

export interface OrganProps {
  organ: OrganModel;
  /** Включён ли переключатель; для select и spin — текущее значение */
  value?: boolean | string;
  /** Причина недоступности. Пусто — доступен */
  disabled?: string;
  /** Просит внимания: янтарным. Например, данные под вставленным полем изменились */
  attention?: boolean;
  onRun: (id: string, value?: string) => void;
}

const titleOf = (o: OrganModel, disabled?: string) => {
  const head = o.label || o.hint || o.id;
  const parts = [disabled ? `${head} — ${disabled}` : head];
  if (!disabled && o.hint && o.label) parts.push(o.hint);
  if (o.keys) parts.push(o.keys);
  return parts.join('\n');
};

/** Общий вид кнопки: рамка, наведение, включено, недоступно, флаксовая */
function buttonClass(o: OrganModel, on: boolean, disabled: boolean, attention: boolean) {
  const base = 'inline-flex items-center gap-1.5 rounded-md border text-2xs font-semibold '
    + 'transition-ui select-none shrink-0';
  if (disabled) {
    return `${base} border-transparent text-slate-350 dark:text-slate-455 cursor-not-allowed`;
  }
  if (attention) {
    return `${base} border-amber-300 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/40 `
      + 'text-amber-700 dark:text-amber-400 hover:bg-amber-100 dark:hover:bg-amber-950/60 cursor-pointer';
  }
  if (on) {
    return `${base} border-emerald-300 dark:border-emerald-800 bg-emerald-50 dark:bg-emerald-950/40 `
      + 'text-emerald-700 dark:text-emerald-400 cursor-pointer';
  }
  if (o.flux) {
    return `${base} border-transparent text-emerald-700 dark:text-emerald-400 `
      + 'hover:bg-emerald-50 dark:hover:bg-emerald-950/40 cursor-pointer';
  }
  return `${base} border-transparent text-slate-600 dark:text-slate-350 `
    + 'hover:bg-slate-100 dark:hover:bg-slate-850 hover:border-slate-200 dark:hover:border-slate-800 cursor-pointer';
}

/**
 * Образец цвета в палитре.
 *
 * Отдельной кнопкой ради одной вещи: срабатывал он по `onMouseDown`, и это
 * значило «только мышью». Клавиатура шлёт `click` без `mousedown` — человек,
 * дошедший до образца табуляцией и нажавший пробел, не менял цвет ничем.
 *
 * Обычный `onClick` этого не ломает: `mousedown` гасил потерю выделения в
 * документе, но выделение теперь и так переживает раскрытие — палитра живёт
 * порталом и фокус у неё не отбирает.
 */
function Swatch({ colour, current, onPick }: { colour: string; current: boolean; onPick: () => void }) {
  const clear = colour === 'transparent';
  return (
    <button type="button" onClick={onPick} aria-label={colorName(colour)} aria-pressed={current}
      title={colorName(colour)}
      className={`w-5 h-5 rounded border cursor-pointer outline-none
        focus-visible:ring-2 focus-visible:ring-emerald-500
        ${current ? 'ring-2 ring-emerald-500 border-transparent' : 'border-slate-300 dark:border-slate-700'}`}
      style={{
        background: clear ? 'transparent' : colour,
        backgroundImage: clear
          ? 'linear-gradient(45deg, transparent 45%, #e11d48 45%, #e11d48 55%, transparent 55%)' : undefined,
      }} />
  );
}

export default function Organ({ organ: o, value, disabled, attention, onRun }: OrganProps) {
  // Палитра разделённой кнопки живёт внутри самого органа: только он знает,
  // где стоит, — и список раскрывается точно под ним, а не «примерно там»
  const [palette, setPalette] = useState(false);
  const arrow = useRef<HTMLButtonElement>(null);
  const on = value === true;
  const off = !!disabled;
  const title = titleOf(o, disabled);
  const Icon = ribbonIcon(o.icon);
  const run = (v?: string) => { if (!off) onRun(o.id, v); };

  if (o.kind === 'big') {
    return (
      <button type="button" title={title} disabled={off} aria-pressed={o.toggle ? on : undefined}
        onClick={() => run()} data-organ={o.id}
        className={`${buttonClass(o, on, off, !!attention)} flex-col justify-center gap-0.5 px-2 leading-tight`}
        style={{ height: BIG_H, minWidth: organWidth(o) }}>
        <Icon className="w-4 h-4" />
        <span className="whitespace-nowrap">{o.label}</span>
      </button>
    );
  }

  if (o.kind === 'select') {
    const current = typeof value === 'string' ? value : '';
    const shown = o.options?.find((x) => x.value === current)?.label || o.label || '';
    return (
      <span className="relative inline-flex shrink-0" style={{ height: ORGAN_H }}>
        <select
          value={current} title={title} disabled={off} data-organ={o.id}
          onChange={(e) => run(e.target.value)}
          className={`appearance-none rounded-md border px-2 pr-5 text-2xs font-semibold transition-ui outline-none
            ${off
              ? 'border-slate-200 dark:border-slate-800 text-slate-350 dark:text-slate-455 cursor-not-allowed'
              : 'border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-950 text-slate-700 dark:text-slate-300 hover:border-slate-300 dark:hover:border-slate-700 cursor-pointer'}`}
          style={{ height: ORGAN_H, width: organWidth(o) }}
        >
          {!o.options?.some((x) => x.value === current) && <option value={current}>{shown}</option>}
          {o.options?.map((x) => <option key={x.value} value={x.value}>{x.label}</option>)}
        </select>
        <span className="pointer-events-none absolute right-1.5 top-1/2 -translate-y-1/2 text-2xs text-slate-400">▾</span>
      </span>
    );
  }

  if (o.kind === 'spin') {
    const shown = typeof value === 'string' ? value : o.label || '';
    return (
      <span className={`inline-flex items-center rounded-md border shrink-0 overflow-hidden
        ${off ? 'border-slate-200 dark:border-slate-800' : 'border-slate-200 dark:border-slate-800'}`}
        style={{ height: ORGAN_H }} title={title}>
        <button type="button" disabled={off} onClick={() => run('-')} aria-label={`${o.label || o.id}: меньше`}
          className="w-5 h-full text-xs text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-850 cursor-pointer disabled:cursor-not-allowed">−</button>
        <span data-organ={o.id} className="px-1.5 text-2xs font-semibold text-slate-700 dark:text-slate-300 tabular-nums min-w-10 text-center">{shown}</span>
        <button type="button" disabled={off} onClick={() => run('+')} aria-label={`${o.label || o.id}: больше`}
          className="w-5 h-full text-xs text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-850 cursor-pointer disabled:cursor-not-allowed">+</button>
      </span>
    );
  }

  if (o.kind === 'split') {
    const colour = typeof value === 'string' ? value : (o.colors?.[0] || '');
    return (
      <span className="inline-flex items-stretch rounded-md border border-slate-200 dark:border-slate-800 shrink-0"
        style={{ height: ORGAN_H }} title={title}>
        <button type="button" disabled={off} onClick={() => run(colour)} data-organ={o.id}
          className="flex flex-col items-center justify-center px-1.5 rounded-l-md hover:bg-slate-100 dark:hover:bg-slate-850 cursor-pointer disabled:cursor-not-allowed">
          <Icon className="w-3.5 h-3.5 text-slate-600 dark:text-slate-350" />
          {colour && <span className="w-4 h-1 rounded-sm mt-0.5" style={{ background: colour === 'transparent' ? '#94a3b8' : colour }} />}
        </button>
        <button ref={arrow} type="button" disabled={off} onClick={() => setPalette((v) => !v)} aria-expanded={palette}
          aria-haspopup="menu" aria-label={`${o.label || o.hint || o.id}: выбрать`}
          /* Двадцать точек в ширину — не украшение: в четырнадцать мышью
             попадают через раз, а за этой стрелкой вся палитра цветов */
          className="w-5 shrink-0 text-2xs text-slate-400 border-l border-slate-200 dark:border-slate-800 rounded-r-md
                     hover:bg-slate-100 dark:hover:bg-slate-850 cursor-pointer disabled:cursor-not-allowed">▾</button>
        {/* Порталом: полоса ленты обрезает по высоте, и раскрытая палитра
            оказывалась целиком под её нижним краем */}
        {palette && (
          <Popover anchor={arrow.current} onClose={() => setPalette(false)}
            label={o.label || o.hint || 'Палитра'} className="p-1.5">
            <div className="flex gap-1">
              {(o.colors || []).map((c) => (
                <Swatch key={c} colour={c} current={colour === c}
                  onPick={() => { setPalette(false); run(c); }} />
              ))}
            </div>
          </Popover>
        )}
      </span>
    );
  }

  if (o.kind === 'palette') {
    return (
      <span className="inline-flex items-center gap-1 rounded-md border border-slate-200 dark:border-slate-800 px-1.5 shrink-0"
        style={{ height: ORGAN_H }} title={title}>
        {(o.colors || []).map((c) => (
          <button key={c} type="button" disabled={off} onClick={() => run(c)}
            aria-label={colorName(c)} aria-pressed={value === c} title={colorName(c)}
            className={`w-3.5 h-3.5 rounded-sm border cursor-pointer disabled:cursor-not-allowed
              ${value === c ? 'ring-2 ring-emerald-500 border-transparent' : 'border-slate-300 dark:border-slate-700'}`}
            style={{ background: c }} />
        ))}
      </span>
    );
  }

  // icon и label — одна кнопка, разница только в подписи
  return (
    <button type="button" title={title} disabled={off} aria-pressed={o.toggle ? on : undefined}
      onClick={() => run()} data-organ={o.id}
      className={`${buttonClass(o, on, off, !!attention)} justify-center px-1.5`}
      style={{ height: ORGAN_H, minWidth: o.kind === 'icon' ? ORGAN_H : undefined }}>
      <Icon className="w-3.5 h-3.5 shrink-0" />
      {o.kind === 'label' && <span className="whitespace-nowrap pr-0.5">{o.label}</span>}
    </button>
  );
}
