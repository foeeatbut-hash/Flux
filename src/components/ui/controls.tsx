/**
 * Общие элементы интерфейса Flux.
 *
 * Правила — docs/methodology/01-design.md, раздел 5; вид задают классы fx-* в
 * src/index.css. Компоненты здесь тонкие нарочно: смысл в том, чтобы каждый
 * экран брал кнопку, поле и шапку отсюда, а не рисовал свою — до этого в
 * программе было 63 разных строки классов у одной и той же главной кнопки.
 *
 * Начало положили элементы Каталога и Конструктора (components/catalog/ui):
 * они были самыми ровными. Там остались только вещи предметной области —
 * уверенность подбора, статус семейства, обозначение.
 */
import React from 'react';

type BtnTone = 'primary' | 'ghost' | 'danger' | 'plain';

/** Кнопка. Главная (`primary`) — одна на панель; `ghost` — тихая кнопка панели инструментов */
export function Btn({ tone = 'plain', size, className = '', ...p }: React.ButtonHTMLAttributes<HTMLButtonElement> & { tone?: BtnTone; size?: 'sm' | 'lg' }) {
  const tones: Record<BtnTone, string> = { primary: 'fx-btn-primary', ghost: 'fx-btn-quiet', danger: 'fx-btn-danger', plain: '' };
  return <button type="button" {...p} className={`fx-btn ${tones[tone]} ${size ? `fx-btn-${size}` : ''} ${className}`} />;
}

/** Кнопка-значок: подпись обязательна — без неё значок не прочтёт ни человек, ни проверка */
export function IconBtn({ label, className = '', children, ...p }: React.ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
  return <button type="button" aria-label={label} title={label} {...p} className={`fx-ibtn ${className}`}>{children}</button>;
}

/** Переключатель вариантов: тема, вид, «по составу / по типу» */
export function Seg<T extends string>({ value, options, onChange, label }: { value: T; options: Array<{ value: NoInfer<T>; label: string; hint?: string }>; onChange: (v: NoInfer<T>) => void; label: string }) {
  return (
    <div className="fx-segctl" role="group" aria-label={label}>
      {options.map((o) => (
        <button key={o.value} type="button" title={o.hint} onClick={() => onChange(o.value)} aria-pressed={value === o.value}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** Фильтр со счётчиками — он же сводка: «Все 48 · В работе 31 · Архив 4» */
export function FilterSeg<T extends string>({ value, options, onChange, label }: { value: T; options: Array<{ value: NoInfer<T>; label: string; count?: number; hint?: string }>; onChange: (v: NoInfer<T>) => void; label: string }) {
  return (
    <div className="fx-seg" role="group" aria-label={label}>
      {options.map((o) => (
        <button key={o.value} type="button" title={o.hint} onClick={() => onChange(o.value)} aria-pressed={value === o.value}>
          {o.label}{o.count !== undefined && <span className="fx-n">{o.count}</span>}
        </button>
      ))}
    </div>
  );
}

export function Field({ label, hint, children, className = '' }: { label: string; hint?: string; children: React.ReactNode; className?: string }) {
  return (
    <label className={`fx-field ${className}`}>
      <span className="fx-label">{label}</span>
      {children}
      {hint && <span className="fx-hint">{hint}</span>}
    </label>
  );
}

export const inputCls = 'fx-input';

export function Input(p: React.InputHTMLAttributes<HTMLInputElement> & { ref?: React.Ref<HTMLInputElement> }) {
  return <input {...p} className={`${inputCls} ${p.className || ''}`} />;
}

export function Area(p: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea {...p} className={`${inputCls} resize-y ${p.className || ''}`} />;
}

export function Select({ value, onChange, options, className = '', ...rest }: { value: string; onChange: (v: string) => void; options: Array<{ value: string; label: string; disabled?: boolean; title?: string }>; className?: string } & Omit<React.SelectHTMLAttributes<HTMLSelectElement>, 'onChange' | 'value'>) {
  return (
    <select {...rest} value={value} onChange={(e) => onChange(e.target.value)} className={`${inputCls} cursor-pointer ${className}`}>
      {options.map((o) => <option key={o.value} value={o.value} disabled={o.disabled} title={o.title}>{o.label}</option>)}
    </select>
  );
}

export type Tone = 'slate' | 'emerald' | 'amber' | 'rose' | 'sky';
const DOT: Record<Tone, string> = { slate: '', emerald: 'fx-st-ok', amber: 'fx-st-warn', rose: 'fx-st-bad', sky: 'fx-st-info' };

/**
 * Метка статуса — точка и слово цветом текста. Раньше это была цветная
 * пилюля с рамкой; пилюли стояли на каждом значении, и глаз переставал их
 * различать. Нажимаемая метка остаётся кнопкой того же вида.
 */
export function Chip({ children, tone = 'slate', onClick, title, off }: { children: React.ReactNode; tone?: Tone; onClick?: () => void; title?: string; off?: boolean }) {
  const cls = `fx-st ${DOT[tone]} text-xs ${off ? 'line-through opacity-50' : ''} ${onClick ? 'cursor-pointer hover:text-slate-900 dark:hover:text-white' : ''}`;
  return onClick
    ? <button type="button" onClick={onClick} title={title} className={cls}>{children}</button>
    : <span title={title} className={cls}>{children}</span>;
}

/** Статус строкой: «В работе», «Конфликт». Синоним Chip без нажатия — для читаемости разметки */
export function Status({ tone = 'slate', children, title }: { tone?: Tone; children: React.ReactNode; title?: string }) {
  return <span title={title} className={`fx-st ${DOT[tone]}`}>{children}</span>;
}

/** Бейдж — только счётчик или то, что требует действия сейчас */
export function Badge({ children, tone, title }: { children: React.ReactNode; tone?: 'bad' | 'accent'; title?: string }) {
  return <span title={title} className={`fx-badge ${tone ? `fx-badge-${tone}` : ''}`}>{children}</span>;
}

export function Empty({ title, text, children }: { title: string; text?: string; children?: React.ReactNode }) {
  return (
    <div className="fx-empty">
      <div className="fx-empty-title">{title}</div>
      {text && <div className="fx-empty-text">{text}</div>}
      {children}
    </div>
  );
}

/** Заголовок группы внутри области: 13/600 и линия, без заглавных и цвета */
export function SectionTitle({ children, right }: { children: React.ReactNode; right?: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2 mt-4 mb-1">
      <span className="text-sm font-semibold text-slate-800 dark:text-slate-100">{children}</span>
      <span className="flex-1 h-px bg-slate-200 dark:bg-slate-800" />
      {right}
    </div>
  );
}

/**
 * Шапка раздела — одна строка 44 px: название, счётчик, вкладки, действия.
 * Без значка в цветном квадратике и без подзаголовка: что делает раздел,
 * объясняют Руководство и пустое состояние (01-design.md, раздел 5).
 */
export function SectionHead({ title, count, children, actions }: { title: React.ReactNode; count?: React.ReactNode; children?: React.ReactNode; actions?: React.ReactNode }) {
  return (
    <div className="fx-head">
      <h1 className="fx-head-title">{title}</h1>
      {count !== undefined && count !== null && count !== '' && <span className="fx-head-count">{count}</span>}
      {children}
      {actions && <div className="fx-head-acts">{actions}</div>}
    </div>
  );
}

/** Вкладки раздела в шапке: выбранная отмечена линией снизу */
export function Tabs<T extends string>({ value, tabs, onChange, label }: { value: T; tabs: Array<{ value: NoInfer<T>; label: string; icon?: React.ReactNode; count?: number; title?: string }>; onChange: (v: NoInfer<T>) => void; label: string }) {
  return (
    <div className="fx-tabs" role="tablist" aria-label={label}>
      {tabs.map((t) => (
        <button key={t.value} type="button" role="tab" aria-selected={value === t.value} title={t.title} onClick={() => onChange(t.value)} className="fx-tab">
          {t.icon}{t.label}{t.count !== undefined && <span className="text-slate-400 font-normal tabular-nums">{t.count}</span>}
        </button>
      ))}
    </div>
  );
}

/** Панель инструментов 40 px: найти → показать → вывести */
export function Toolbar({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return <div className={`fx-tools ${className}`}>{children}</div>;
}

export function Switch({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return <button type="button" role="switch" aria-checked={checked} aria-label={label} disabled={disabled} onClick={() => onChange(!checked)} className="fx-switch" />;
}

/** Строка настройки: название и пояснение слева, контрол справа */
export function SettingRow({ title, desc, children }: { title: React.ReactNode; desc?: React.ReactNode; children?: React.ReactNode }) {
  return (
    <div className="fx-set-row">
      <div className="fx-set-text">{title}{desc && <div className="fx-set-desc">{desc}</div>}</div>
      {children}
    </div>
  );
}

export function Avatar({ name, online, className = '' }: { name: string; online?: boolean; className?: string }) {
  const ini = name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase();
  return <span className={`fx-av ${online ? 'fx-av-online' : ''} ${className}`} aria-hidden="true">{ini || '·'}</span>;
}
