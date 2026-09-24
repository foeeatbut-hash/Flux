import React from 'react';
import { Paperclip, Star, Archive, Trash2, MailOpen, Mail as MailIcon, CornerUpLeft, UserCheck, Languages } from 'lucide-react';
import type { MailThread } from '../../services/mailService';
import { displayName, initialsOf, toneOf, type AvatarTone } from '../../lib/mailAddress';
import { threadParticipants } from '../../lib/mailThread';
import { useTranslateStore } from '../../store/translateStore';
import { detectLang } from '../../translate/lang';
import { joinSegments } from '../../translate/engine';

/**
 * Список переписок.
 *
 * Строка повторяет устройство Gmail, потому что к нему у человека уже есть
 * привычка: отметка, звезда, отправитель фиксированной ширины, тема с
 * фрагментом через тире, дата справа. Непрочитанное — полужирным. При
 * наведении дата уступает место действиям.
 *
 * Плотность строки берётся из общей настройки программы, а не своя: одна
 * ручка на всё лучше двух похожих.
 */

interface Props {
  threads: MailThread[];
  picked: string[];
  openKey: string;
  myAddr: string;
  loading: boolean;
  /** Общий ящик: показываем, кто взял переписку и кто на неё ответил */
  shared: boolean;
  /** Мой id — чтобы отличить «за мной» от «за коллегой» */
  meId: string;
  onClaim: (t: MailThread, on: boolean) => void;
  /** Показывать ли колонку отправителя — в узкой панели её убираем */
  onOpen: (key: string) => void;
  onPick: (key: string) => void;
  onStar: (t: MailThread, on: boolean) => void;
  onSeen: (t: MailThread, on: boolean) => void;
  onArchive: (t: MailThread) => void;
  onTrash: (t: MailThread) => void;
}

/** Короткое имя для пометки: в строке списка на полное ФИО места нет. */
function shortName(full: string): string {
  const parts = String(full || '').trim().split(/\s+/).filter(Boolean);
  if (parts.length < 2) return parts[0] || '';
  return `${parts[0]} ${parts[1][0]}.`;
}

/** Круг с буквами: у каждого отправителя свой цвет, но всегда один и тот же. */
const TONE_CLASS: Record<AvatarTone, string> = {
  emerald: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300',
  sky: 'bg-sky-100 text-sky-800 dark:bg-sky-950 dark:text-sky-300',
  amber: 'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300',
  rose: 'bg-rose-100 text-rose-800 dark:bg-rose-950 dark:text-rose-300',
  slate: 'bg-slate-200 text-slate-700 dark:bg-slate-800 dark:text-slate-300',
};

/**
 * Дата в списке: сегодня — время, в этом году — день и месяц, раньше — год.
 * Так же поступает Gmail, и по делу: колонка узкая, а полная дата в ней не
 * читается и не нужна.
 */
function shortDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) return d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (d.toDateString() === yesterday.toDateString()) return 'вчера';
  if (d.getFullYear() === now.getFullYear()) {
    return d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' }).replace('.', '');
  }
  return d.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: '2-digit' });
}

/** Кто в переписке. Свой адрес показываем как «вы» — это делает Gmail. */
function whoOf(t: MailThread, myAddr: string): string {
  const names = t.from.map((f) => (f.addr && f.addr === myAddr ? 'вы' : displayName(f)));
  return threadParticipants(names) || 'Без отправителя';
}

const RowAction = ({ title, onClick, children }: { title: string; onClick: (e: React.MouseEvent) => void; children: React.ReactNode }) => (
  <button
    type="button"
    title={title}
    aria-label={title}
    onClick={onClick}
    className="p-1.5 rounded-md text-slate-500 hover:text-slate-800 hover:bg-slate-200/70 dark:text-slate-400 dark:hover:text-white dark:hover:bg-slate-700 cursor-pointer"
  >
    {children}
  </button>
);

export default function MailList({
  threads, picked, openKey, myAddr, loading, shared, meId, onClaim,
  onOpen, onPick, onStar, onSeen, onArchive, onTrash,
}: Props) {
  // Тема на чужом языке переводится прямо в списке — и занимает место
  // фрагмента, а не лишнюю строку: фрагмент в таком письме всё равно на том же
  // чужом языке, а тема по-русски отвечает на вопрос «моё ли это письмо»
  const many = useTranslateStore((s) => s.many);
  const termIndex = useTranslateStore((s) => s.termIndex);
  const subjectRu = React.useMemo(() => {
    const map: Record<string, string> = {};
    for (const t of threads) {
      const subject = (t.subject || '').trim();
      if (!subject) continue;
      const lang = detectLang(subject);
      if (lang !== 'en' && lang !== 'zh') continue;
      const ru = joinSegments(many(subject, lang, 'ru')).trim();
      if (ru && ru !== subject) map[t.threadKey] = ru;
    }
    return map;
  }, [threads, many, termIndex]);

  if (loading && !threads.length) {
    return (
      <div className="flex-1 flex items-center justify-center text-sm text-slate-400 dark:text-slate-500">
        Загружаем письма…
      </div>
    );
  }

  if (!threads.length) {
    return (
      <div className="flex-1 flex items-center justify-center p-6">
        <div className="blank">
          <MailOpen className="w-12 h-12 text-slate-300 dark:text-slate-700 mb-3" />
          <p className="blank-title">Писем нет</p>
          <p className="blank-text">Здесь пусто: либо папка пуста, либо ничего не нашлось по запросу.</p>
        </div>
      </div>
    );
  }

  return (
    <div role="list" className="flex-1 overflow-y-auto scrollbar-thin">
      {threads.map((t) => {
        const isPicked = picked.includes(t.threadKey);
        const isOpen = openKey === t.threadKey;
        const who = whoOf(t, myAddr);
        const last = t.from[t.from.length - 1] || { name: '', addr: '' };

        return (
          <div
            key={t.threadKey}
            role="listitem"
            tabIndex={0}
            onClick={() => onOpen(t.threadKey)}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(t.threadKey); } }}
            className={`group relative flex items-center gap-2 px-2 border-b border-slate-100 dark:border-slate-850 cursor-pointer transition-colors outline-none
              focus-visible:ring-2 focus-visible:ring-emerald-500 focus-visible:ring-inset
              ${isOpen ? 'bg-emerald-50/70 dark:bg-emerald-950/30'
                : isPicked ? 'bg-sky-50/70 dark:bg-sky-950/25'
                : t.unread ? 'bg-white dark:bg-slate-900 hover:bg-slate-50 dark:hover:bg-slate-850'
                : 'bg-slate-50/60 dark:bg-slate-950/40 hover:bg-slate-100/70 dark:hover:bg-slate-850'}`}
            // Высота строки — из общей настройки плотности программы. С поправкой
            // в 4 px три режима дают 32, 38 и 46 — почти в точности три режима
            // Gmail, к которым человек привык
            style={{ minHeight: 'calc(var(--flux-row-h, 34px) + 4px)' }}
          >
            {/* Отметка */}
            <input
              type="checkbox"
              checked={isPicked}
              onClick={(e) => e.stopPropagation()}
              onChange={() => onPick(t.threadKey)}
              aria-label={`Отметить переписку «${t.subject || 'без темы'}»`}
              className="shrink-0 w-4 h-4 accent-emerald-600 cursor-pointer"
            />

            {/* Звезда */}
            <button
              type="button"
              title={t.flagged ? 'Снять важность' : 'Пометить важным'}
              aria-label={t.flagged ? 'Снять важность' : 'Пометить важным'}
              onClick={(e) => { e.stopPropagation(); onStar(t, !t.flagged); }}
              className="shrink-0 p-0.5 cursor-pointer"
            >
              {/* Незажжённая звезда приглушена, но остаётся различимой: это
                  кнопка, в неё надо попасть, а не догадаться о ней */}
              <Star className={`w-4 h-4 ${t.flagged
                ? 'text-amber-500 fill-amber-400'
                : 'text-slate-400 hover:text-amber-500 dark:text-slate-455'}`} />
            </button>

            {/* Кружок отправителя: в тесной панели убирается первым */}
            <div className={`hidden @[620px]:flex shrink-0 w-6 h-6 rounded-full items-center justify-center text-2xs font-semibold ${TONE_CLASS[toneOf(last)]}`}>
              {initialsOf(last)}
            </div>

            {/* Отправитель, тема и фрагмент.
                Широкая колонка — одна строка, как в Gmail: отправитель слева,
                тема и фрагмент через тире. Узкая (список рядом с открытым
                письмом) — две строки: иначе на тему остаётся 50 px, и от
                «Поставка AHU-21 сдвигается» видно «П.». Так же разворачивается
                и сам Gmail в раздельном виде. */}
            <div className="flex-1 min-w-0 py-1.5 flex flex-col @[720px]:flex-row @[720px]:items-baseline @[720px]:gap-2">
              <div className={`min-w-0 truncate text-xs @[900px]:text-sm @[720px]:shrink-0 @[720px]:w-28 @[900px]:w-44
                ${t.unread ? 'font-semibold text-slate-900 dark:text-white' : 'text-slate-600 dark:text-slate-400'}`}>
                {who}
                {t.count > 1 && <span className="ml-1 text-slate-400 dark:text-slate-500 font-normal">{t.count}</span>}
              </div>

              <div className="min-w-0 flex items-baseline gap-1.5 @[720px]:flex-1">
                {t.answered && <CornerUpLeft className="w-3 h-3 shrink-0 text-slate-400 dark:text-slate-500" />}
                <span className={`min-w-0 truncate text-xs @[900px]:text-sm @[720px]:shrink-0 @[720px]:max-w-[45%]
                  ${t.unread ? 'font-semibold text-slate-900 dark:text-white' : 'text-slate-700 dark:text-slate-300'}`}>
                  {t.subject || '(без темы)'}
                </span>
                <span className="hidden @[720px]:flex flex-1 min-w-0 items-baseline gap-1 truncate text-xs
                                 text-slate-400 dark:text-slate-500">
                  {subjectRu[t.threadKey] ? (
                    <>
                      <Languages className="w-3 h-3 shrink-0 self-center text-emerald-600 dark:text-emerald-400" />
                      <span className="min-w-0 truncate">{subjectRu[t.threadKey]}</span>
                    </>
                  ) : (t.snippet ? `— ${t.snippet}` : '')}
                </span>
              </div>

              {/* Общий ящик: девять остальных должны видеть, что письмо уже
                  взяли или на него ответили, — до того как ответят второй раз */}
              {shared && t.state && (t.state.repliedByName || t.state.claimedByName) && (
                <div className="shrink-0 flex items-center gap-1 mt-0.5 @[720px]:mt-0">
                  {t.state.repliedByName ? (
                    <span
                      title={`Ответил ${t.state.repliedByName}${t.state.repliedAt ? `, ${shortDate(t.state.repliedAt)}` : ''}`}
                      className="inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-2xs font-semibold bg-emerald-100 text-emerald-800 dark:bg-emerald-950/60 dark:text-emerald-300"
                    >
                      <CornerUpLeft className="w-3 h-3 shrink-0" />
                      <span className="max-w-[7rem] truncate">{shortName(t.state.repliedByName)}</span>
                    </span>
                  ) : (
                    <span
                      title={`В работе у ${t.state.claimedByName}`}
                      className={`inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-2xs font-semibold
                        ${t.state.claimedById === meId
                          ? 'bg-sky-100 text-sky-800 dark:bg-sky-950/60 dark:text-sky-300'
                          : 'bg-amber-100 text-amber-800 dark:bg-amber-950/60 dark:text-amber-300'}`}
                    >
                      <UserCheck className="w-3 h-3 shrink-0" />
                      <span className="max-w-[7rem] truncate">
                        {t.state.claimedById === meId ? 'За мной' : shortName(t.state.claimedByName)}
                      </span>
                    </span>
                  )}
                </div>
              )}
            </div>

            {t.hasFiles && <Paperclip className="shrink-0 w-3.5 h-3.5 text-slate-400 dark:text-slate-500" />}

            {/* Дата — и она же место для действий по наведению */}
            <div className="shrink-0 w-[4.5rem] text-right">
              <span className={`text-2xs font-mono tabular-nums group-hover:invisible
                ${t.unread ? 'font-semibold text-slate-900 dark:text-white' : 'text-slate-400 dark:text-slate-500'}`}>
                {shortDate(t.sentAt)}
              </span>
            </div>
            <div className="absolute right-1 hidden group-hover:flex group-focus-within:flex items-center gap-0.5
              bg-inherit rounded-lg pl-2">
              <RowAction title="В архив" onClick={(e) => { e.stopPropagation(); onArchive(t); }}>
                <Archive className="w-4 h-4" />
              </RowAction>
              <RowAction title="Удалить" onClick={(e) => { e.stopPropagation(); onTrash(t); }}>
                <Trash2 className="w-4 h-4" />
              </RowAction>
              <RowAction
                title={t.unread ? 'Отметить прочитанным' : 'Отметить непрочитанным'}
                onClick={(e) => { e.stopPropagation(); onSeen(t, t.unread); }}
              >
                {t.unread ? <MailOpen className="w-4 h-4" /> : <MailIcon className="w-4 h-4" />}
              </RowAction>
              {shared && (
                <RowAction
                  title={t.state?.claimedById === meId ? 'Отпустить переписку' : 'Взять переписку в работу'}
                  onClick={(e) => { e.stopPropagation(); onClaim(t, t.state?.claimedById !== meId); }}
                >
                  <UserCheck className={`w-4 h-4 ${t.state?.claimedById === meId ? 'text-sky-600 dark:text-sky-400' : ''}`} />
                </RowAction>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
