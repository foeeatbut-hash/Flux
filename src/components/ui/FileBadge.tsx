/**
 * Значок файла Flux Office: лист с загнутым углом, мягкой двухтоновой тенью,
 * детализированным знаком вида и нижней полосой цвета программы с подписью
 * формата (DOCX, XLSX, CSV, PDF, ЗАМ, MD, TXT, PNG, ZIP, DWG и др.).
 *
 * Рисуется SVG в сетке 32×32 и одинаково чётко читается от 16 px (строка
 * Проводника) до 256 px (огромные значки).
 *
 * Мелкий значок не несёт подписи — на 16 px буквы превращаются в пятно; вид
 * узнаётся по цвету полосы и знаку. С 32 px на полосе появляется
 * расширение: .xlsx и .xlsm, .docx и .md различимы, не читая имя.
 *
 * Формат, который Flux не открывает и для которого рисунка нет, — «закрытый»
 * лист (`closed`): приглушённая серая полоса, замок, расширение на полосе.
 * Системных значков Windows здесь нет и не будет: значок целиком наш.
 *
 * Вид и цвет считает lib/fileBadge.ts — здесь только рисование.
 */
import React from 'react';
import { badgeOf, badgeLabel, BADGE_COLOR, type BadgeKind } from '../../lib/fileBadge';
import { ICON_SIZE } from '../../lib/metrics';
import type { FileLike } from '../../lib/fileTypes';
import { resolveIconSize } from '../icons/resolveSize';

/** Детализированный знак вида документа в центральном поле листа */
function Mark({ kind, label, c }: { kind: BadgeKind; label: string; c: string }) {
  const line = { stroke: c, strokeWidth: 1.35, strokeLinecap: 'round' as const };
  if (kind === 'sheet' && label === 'CSV') {
    return (
      <g {...line}>
        <path d="M9.5 9.2v8.8M18.2 9.2v8.8" strokeDasharray="1.5 1.3" strokeWidth={1.2} />
        <path d="M11 10h5.6M19.8 10h2.8M11 12.2h5.6M19.8 12.2h2.8M11 14.4h5.6M19.8 14.4h2.8M11 16.6h5.6M19.8 16.6h2.8" />
      </g>
    );
  }
  switch (kind) {
    case 'doc':
      return (
        <g {...line}>
          <path d="M9.5 9.5h7" strokeWidth={1.6} />
          <path d="M9.5 11.8h12.5M9.5 13.8h12.5" />
          <circle cx={10} cy={15.8} r={0.75} fill={c} stroke="none" />
          <path d="M12.2 15.8h9.8" />
          <circle cx={10} cy={17.8} r={0.75} fill={c} stroke="none" />
          <path d="M12.2 17.8h7.5" />
        </g>
      );
    case 'sheet':
      return (
        <g stroke={c} strokeWidth={1.15} fill="none">
          <rect x={9.2} y={8.8} width={13.6} height={9.2} rx={1} />
          <path d="M9.2 8.8h13.6v2.4H9.2z" fill={c} fillOpacity={0.22} stroke="none" />
          <path d="M9.2 11.2h13.6M9.2 13.5h13.6M9.2 15.8h13.6M13.7 8.8v9.2M18.3 8.8v9.2" />
        </g>
      );
    case 'pdf':
      return (
        <g fill="none" stroke={c} strokeWidth={1.25} strokeLinejoin="round">
          <path d="M11 17.2c2.5-2 4.2-5 4.6-7.8.2-1.3-1.3-1.5-1.4-.2-.3 2.9 2.6 6.4 6.4 6.9 1.2.2 1.3-1.3.1-1.3-3.1-.1-7.6 1.3-9.7 2.4z" />
          <rect x={14.3} y={7.6} width={1.8} height={1.8} fill="#fff" stroke={c} strokeWidth={1} />
          <rect x={9.6} y={16.5} width={1.8} height={1.8} fill="#fff" stroke={c} strokeWidth={1} />
          <rect x={20.2} y={14.8} width={1.8} height={1.8} fill="#fff" stroke={c} strokeWidth={1} />
        </g>
      );
    case 'note':
      return (
        <g {...line}>
          <path d="M9.5 9.8h12.5M9.5 12h12.5M9.5 14.2h12.5M9.5 16.4h8" />
          <path d="M19.2 16.4l1.4 1.5 2.6-2.8" strokeWidth={1.55} strokeLinejoin="round" fill="none" />
        </g>
      );
    case 'markdown':
      return (
        <g {...line} fill="none" strokeLinejoin="round">
          <path d="M9.2 16.8V10.5l2.4 2.8 2.4-2.8v6.3" strokeWidth={1.5} />
          <path d="M16.8 11v5.5M15.2 14.8l1.6 1.8 1.6-1.8" strokeWidth={1.4} />
          <path d="M19.8 10.5h3M19.8 12.8h3M19.8 15.1h3M19.8 17.2h2.2" strokeWidth={1.2} />
        </g>
      );
    case 'text':
      return (
        <g {...line} strokeWidth={1.3}>
          <path d="M9.5 9.5h3.2M14.2 9.5h4.5M9.5 11.7h12.5M9.5 13.9h7.2M18.2 13.9h3.8M9.5 16.1h12.5M9.5 18.1h5.5" />
        </g>
      );
    case 'image':
      return (
        <g fill="none" stroke={c} strokeWidth={1.2} strokeLinejoin="round">
          <rect x={9.2} y={9.2} width={13.6} height={8.8} rx={1.1} fill={c} fillOpacity={0.12} />
          <path d="M9.6 17.6l4.2-4.4 2.8 2.7 2.2-2 3.6 3.7z" fill={c} fillOpacity={0.28} />
          <circle cx={19.2} cy={11.8} r={1.2} fill={c} stroke="none" />
        </g>
      );
    case 'archive':
      return (
        <g stroke={c} strokeWidth={1.25} fill="none">
          <path d="M15.3 3.6v16.8M16.9 3.6v16.8" strokeDasharray="1.4 1.2" />
          <rect x={14.5} y={13.2} width={3.2} height={3.8} rx={0.7} fill="#e2e8f0" stroke={c} strokeWidth={1.2} />
          <circle cx={16.1} cy={15.1} r={0.55} fill={c} stroke="none" />
        </g>
      );
    case 'cad':
      return (
        <g stroke={c} strokeWidth={1.2} fill="none" strokeLinecap="round" strokeLinejoin="round">
          <circle cx={13} cy={9.6} r={1.2} fill={c} fillOpacity={0.2} />
          <path d="M13 8.2v1M12.2 10.7l-2.6 7M13.8 10.7l2.6 7M10.4 15.2h5.2" strokeWidth={1.35} />
          <path d="M17.2 11.5h3.6l1.4 1.4v4.6h-5z" fill={c} fillOpacity={0.1} strokeWidth={1} />
          <path d="M17.2 9.8h5M23.4 11.5v6" strokeWidth={0.95} />
        </g>
      );
    case 'slide':
      return (
        <g stroke={c} strokeWidth={1.2} fill="none" strokeLinecap="round">
          <rect x={9.2} y={8.8} width={13.6} height={9.2} rx={1} fill={c} fillOpacity={0.12} />
          <path d="M11.8 11.4h5M11.8 13.6h3.2" />
          <path d="M19.6 12.2v2.2h2.2a2.2 2.2 0 0 0-2.2-2.2z" fill={c} fillOpacity={0.4} strokeWidth={0.9} />
        </g>
      );
    case 'code':
      return (
        <path d="m13.5 9.5-3.4 4.3 3.4 4.3m5-8.6 3.4 4.3-3.4 4.3m-3.6-10-2 11.4" fill="none" stroke={c} strokeWidth={1.4} strokeLinecap="round" strokeLinejoin="round" />
      );
    case 'app':
      return (
        <g stroke={c} strokeWidth={1.2} fill="none" strokeLinejoin="round">
          <rect x={9.2} y={8.8} width={13.6} height={9.4} rx={1.2} />
          <path d="M9.2 8.8h13.6v2.6H9.2z" fill={c} fillOpacity={0.3} stroke="none" />
          <rect x={11.6} y={12.8} width={4.6} height={3.4} rx={0.6} fill={c} fillOpacity={0.45} stroke="none" />
          <path d="M18 13.4h2.6M18 15.4h2.6" strokeLinecap="round" strokeWidth={1} />
        </g>
      );
    case 'shortcut':
      return (
        <g stroke={c} strokeWidth={1.5} fill="none" strokeLinecap="round" strokeLinejoin="round">
          <path d="M10.4 17.8v-3.4a3.2 3.2 0 0 1 3.2-3.2h8" />
          <path d="M18.8 8.4l3.2 2.8-3.2 2.8" />
        </g>
      );
    case 'video':
      return (
        <g stroke={c} strokeWidth={1.2} fill="none" strokeLinejoin="round">
          <rect x={9.2} y={9.2} width={10.2} height={8.6} rx={1.3} fill={c} fillOpacity={0.12} />
          <path d="M13.3 11.2l3.7 2.3-3.7 2.3z" fill={c} stroke="none" />
          <path d="M19.4 12.4l3.4-1.8v5.4l-3.4-1.8z" fill={c} fillOpacity={0.45} />
        </g>
      );
    case 'audio':
      return (
        <path d="M10.4 12.2v2.8M12.8 10.6v6M15.2 9v9.2M17.6 11v5.2M20 10v7M22.4 12.2v2.8" fill="none" stroke={c} strokeWidth={1.5} strokeLinecap="round" />
      );
    case 'e3':
      return (
        <g stroke={c} strokeWidth={1.2} fill="none" strokeLinecap="round" strokeLinejoin="round">
          <rect x={9.2} y={9} width={4.6} height={3.8} rx={0.7} fill={c} fillOpacity={0.25} />
          <rect x={18.2} y={14.2} width={4.6} height={3.8} rx={0.7} fill={c} fillOpacity={0.25} />
          <path d="M13.8 10.9h2.6v5.2h1.8" />
        </g>
      );
    case 'closed':
      // Замок: «здесь не открывается». Дужка и корпус одним цветом полосы
      return (
        <g stroke={c} strokeWidth={1.3} fill="none" strokeLinecap="round">
          <path d="M13.7 13.2v-1.6a2.3 2.3 0 0 1 4.6 0v1.6" />
          <rect x={11.8} y={13.2} width={8.4} height={5.2} rx={1.2} fill={c} fillOpacity={0.28} />
          <circle cx={16} cy={15.8} r={0.8} fill={c} stroke="none" />
        </g>
      );
    default:
      return (
        <g {...line}>
          <path d="M10 10.5h11M10 13.5h11M10 16.5h7.5" />
        </g>
      );
  }
}

/** С какого размера на полосе появляется расширение: на меньшем буквы — пятно */
const LABEL_FROM = 32;

export default function FileBadge({ file, size = ICON_SIZE.row, kind: forced, className = '' }: {
  /** Файл (имя и тип из базы) или имя */
  file: FileLike | string;
  size?: number;
  /** Вид, если он известен заранее (заметка Блокнота — не файл) */
  kind?: BadgeKind;
  className?: string;
}) {
  const kind = forced || badgeOf(file);
  const c = BADGE_COLOR[kind];
  const full = badgeLabel(file, kind);
  const label = size >= LABEL_FROM ? full : '';
  const barColor = kind === 'sheet' && full === 'CSV' ? '#0d9488' : c;
  return (
    // Значок всегда стоит рядом с именем файла или программы — для чтения с
    // экрана он лишний: иначе кнопка «Блокнот» зовётся «Заметка Блокнот»
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true" data-kind={kind}
      className={`shrink-0 ${className}`}>
      {/* Лист: светлый в светлой теме, тёмный в тёмной — граница держит форму на любом фоне */}
      <path d="M8 3h12.5L27 9.5V27a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z"
        className="fill-white stroke-slate-300 dark:fill-slate-800 dark:stroke-slate-600" strokeWidth={1.1} />
      {/* Мягкая двухтоновая тень вдоль правого края листа и под уголком */}
      <path d="M20.5 3L27 9.5V21H17L20.5 3z" fill="#64748b" fillOpacity={0.06} />
      {/* Световая фаска по верхнему и левому краю */}
      <path d="M7.2 20.5V5a1.2 1.2 0 0 1 1.2-1.2h11.6" fill="none" stroke="#ffffff" strokeOpacity={0.75} strokeWidth={0.9} strokeLinecap="round" />
      {/* Тень под загнутым уголком */}
      <path d="M20.5 7.8c0 1.2.8 2 2 2H27v1.1h-5a1.5 1.5 0 0 1-1.5-1.5z" fill="#0f172a" fillOpacity={0.08} />
      {/* Загнутый угол */}
      <path d="M20.5 3v4.5a2 2 0 0 0 2 2H27"
        className="fill-slate-100 stroke-slate-300 dark:fill-slate-700 dark:stroke-slate-600" strokeWidth={1.05} strokeLinejoin="round" />
      <Mark kind={kind} label={full} c={barColor} />
      {/* Полоса цвета программы с подписью формата */}
      <path d="M6 21h21v6a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2z" fill={barColor} />
      <path d="M6 21h21v1H6z" fill="#ffffff" fillOpacity={0.18} />
      <path d="M6 26.8v.2a2 2 0 0 0 2 2h17a2 2 0 0 0 2-2v-.2a2 2 0 0 1-2 1.4H8a2 2 0 0 1-2-1.4z" fill="#000000" fillOpacity={0.18} />
      {label && (
        <text x={16.5} y={26.8} textAnchor="middle" fontSize={label.length > 3 ? 5.5 : 6.3} fontWeight={700}
          fill="#fff" style={{ fontFamily: 'inherit', letterSpacing: '0.03em' }}>{label}</text>
      )}
    </svg>
  );
}

/**
 * Значок программы Flux Office — тот же лист, что у её файлов: в Пуске, на
 * панели задач и в заголовке окна Документ узнаётся так же, как файл .docx
 * на столе. Принимает size/className, как значки lucide в SECTIONS
 */
export function officeAppIcon(kind: BadgeKind, sample: string) {
  function OfficeAppIcon({ size, className = '' }: { size?: number; className?: string }) {
    return <FileBadge file={sample} kind={kind} size={resolveIconSize(size, className)} className={className} />;
  }
  OfficeAppIcon.displayName = `OfficeAppIcon(${kind})`;
  return OfficeAppIcon;
}

export const DocAppIcon = officeAppIcon('doc', 'Документ.docx');
export const SheetAppIcon = officeAppIcon('sheet', 'Таблица.xlsx');
export const PdfAppIcon = officeAppIcon('pdf', 'Файл.pdf');
export const NotesAppIcon = officeAppIcon('note', 'Заметка');
