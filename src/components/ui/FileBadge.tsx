/**
 * Значок файла Flux Office: лист с загнутым углом, знак вида и полоса цвета
 * программы с расширением. Рисуется SVG, чтобы одинаково читаться от 16 px
 * (строка Проводника) до 64 px (крупные значки стола).
 *
 * Мелкий значок не несёт подписи — на 16 px буквы превращаются в пятно; вид
 * узнаётся по цвету полосы и знаку. С 32 px на полосе появляется
 * расширение: .xlsx и .xlsm, .docx и .md различимы, не читая имя.
 *
 * Вид и цвет считает lib/fileBadge.ts — здесь только рисование.
 */
import React from 'react';
import { badgeOf, badgeLabel, BADGE_COLOR, type BadgeKind } from '../../lib/fileBadge';
import type { FileLike } from '../../lib/fileTypes';

/** Знак вида: в поле 14×10 от точки (9, 9) */
function Mark({ kind, c }: { kind: BadgeKind; c: string }) {
  const line = { stroke: c, strokeWidth: 1.6, strokeLinecap: 'round' as const };
  switch (kind) {
    case 'doc':
      return (<g {...line}><path d="M10 10.5h11" /><path d="M10 13.5h11" /><path d="M10 16.5h7" /></g>);
    case 'sheet':
      return (
        <g stroke={c} strokeWidth={1.2} fill="none">
          <rect x={9.5} y={9.5} width={13} height={8} rx={1} />
          <path d="M9.5 12.2h13M9.5 14.8h13M13.8 9.5v8M18.2 9.5v8" />
        </g>
      );
    case 'pdf':
      return (<path d="M11 17.5c2.5-2 4.2-5 4.6-7.8.2-1.3-1.3-1.5-1.4-.2-.3 2.9 2.6 6.4 6.4 6.9 1.2.2 1.3-1.3.1-1.3-3.1-.1-7.6 1.3-9.7 2.4z" fill="none" stroke={c} strokeWidth={1.3} strokeLinejoin="round" />);
    case 'note':
      return (<g {...line}><path d="M10 10.5h11" /><path d="M10 13.5h6" /><path d="M17.5 16l1.5 1.5 3-3.2" /></g>);
    case 'markdown':
      return (<g {...line} fill="none" strokeLinejoin="round"><path d="M9.5 17V10.5l2.5 3 2.5-3V17" /><path d="M19.5 10.5v6M17.5 14.5l2 2 2-2" /></g>);
    case 'text':
      return (<g {...line}><path d="M10 10.5h11" /><path d="M10 13.5h11" /><path d="M10 16.5h11" /></g>);
    case 'image':
      return (
        <g fill="none" stroke={c} strokeWidth={1.3} strokeLinejoin="round">
          <rect x={9.5} y={9.5} width={13} height={8} rx={1} />
          <path d="M10 17l3.5-3.8 2.5 2.4 2-1.8 3.5 3.2" />
          <circle cx={18.8} cy={12} r={1} fill={c} stroke="none" />
        </g>
      );
    case 'archive':
      return (<g stroke={c} strokeWidth={1.4}><path d="M16 9v9" strokeDasharray="1.6 1.4" /><rect x={14.5} y={14.5} width={3} height={3} rx={.6} fill={c} /></g>);
    case 'cad':
      return (<g {...line} fill="none"><path d="M10 17.5l6-8 6 8" /><path d="M12.2 14.5h7.6" /><circle cx={16} cy={9.5} r={.9} fill={c} stroke="none" /></g>);
    default:
      return null;
  }
}

export default function FileBadge({ file, size = 20, kind: forced, className = '' }: {
  /** Файл (имя и тип из базы) или имя */
  file: FileLike | string;
  size?: number;
  /** Вид, если он известен заранее (заметка Блокнота — не файл) */
  kind?: BadgeKind;
  className?: string;
}) {
  const kind = forced || badgeOf(file);
  const c = BADGE_COLOR[kind];
  const label = size >= 32 ? badgeLabel(file, kind) : '';
  return (
    // Значок всегда стоит рядом с именем файла или программы — для чтения с
    // экрана он лишний: иначе кнопка «Блокнот» зовётся «Заметка Блокнот»
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true" data-kind={kind}
      className={`shrink-0 ${className}`}>
      {/* Лист: светлый в светлой теме, тёмный в тёмной — граница держит форму на любом фоне */}
      <path d="M8 3h12.5L27 9.5V27a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z"
        className="fill-white stroke-slate-300 dark:fill-slate-800 dark:stroke-slate-600" strokeWidth={1} />
      {/* Загнутый угол */}
      <path d="M20.5 3v4.5a2 2 0 0 0 2 2H27"
        className="fill-slate-100 stroke-slate-300 dark:fill-slate-700 dark:stroke-slate-600" strokeWidth={1} strokeLinejoin="round" />
      <Mark kind={kind} c={c} />
      {/* Полоса цвета программы */}
      <path d="M6 21h21v6a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2z" fill={c} />
      {label && (
        <text x={16.5} y={27} textAnchor="middle" fontSize={label.length > 3 ? 5.6 : 6.4} fontWeight={700}
          fill="#fff" style={{ fontFamily: 'inherit', letterSpacing: '0.02em' }}>{label}</text>
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
  function OfficeAppIcon({ size = 20, className = '' }: { size?: number; className?: string }) {
    return <FileBadge file={sample} kind={kind} size={size} className={className} />;
  }
  OfficeAppIcon.displayName = `OfficeAppIcon(${kind})`;
  return OfficeAppIcon;
}

export const DocAppIcon = officeAppIcon('doc', 'Документ.docx');
export const SheetAppIcon = officeAppIcon('sheet', 'Таблица.xlsx');
export const PdfAppIcon = officeAppIcon('pdf', 'Файл.pdf');
export const NotesAppIcon = officeAppIcon('note', 'Заметка');
