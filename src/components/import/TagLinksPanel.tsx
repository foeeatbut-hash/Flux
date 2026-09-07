import React from 'react';
import { Tag as TagIcon, Link2, Plus, MinusCircle, AlertTriangle } from 'lucide-react';

// ── Теги бланка в предпросмотре импорта ──────────────────────────────────────
// Технологическая позиция из бланка — адрес изделия в проекте. Программа
// показывает, что нашла, и спрашивает: привязать к существующему тегу, завести
// новый или не связывать. Молча теги не создаются и не перевешиваются —
// решение принимает инженер, как и по остальным данным бланка.

export interface TagCandidate { id: string; identifier: string; why: string }
export interface TagLink {
  blockKey: string;
  identifier: string;
  action: 'link' | 'create' | 'skip';
  existingTagId?: string;
  takenBy?: string;
  candidates?: TagCandidate[];
}

interface Props {
  links: TagLink[];
  /** Подпись позиции по её адресу — чтобы было видно, к чему относится тег */
  titleOf: (blockKey: string) => string;
  onChange: (index: number, action: TagLink['action']) => void;
}

const CHOICES: { value: TagLink['action']; label: string; hint: string; Icon: any }[] = [
  { value: 'link', label: 'Привязать', hint: 'связать позицию с тегом, который уже есть в проекте', Icon: Link2 },
  { value: 'create', label: 'Создать', hint: 'завести новый тег с этим обозначением', Icon: Plus },
  { value: 'skip', label: 'Не связывать', hint: 'оставить позицию без тега', Icon: MinusCircle },
];

export default function TagLinksPanel({ links, titleOf, onChange }: Props) {
  if (!links.length) {
    return (
      <div className="flex-1 flex items-center justify-center text-sm text-slate-400 p-8 text-center">
        В бланке не нашлось технологических позиций.
      </div>
    );
  }

  // Один и тот же тег может стоять у нескольких позиций — это ошибка бланка,
  // и лучше показать её здесь, чем получить отказ «один тег — одно изделие»
  const seen = new Map<string, number>();
  for (const l of links) seen.set(l.identifier, (seen.get(l.identifier) || 0) + 1);

  return (
    <div className="flex-1 overflow-auto p-4">
      <div className="text-xs text-slate-500 mb-3">
        Найдено технологических позиций: <b>{links.length}</b>. Тег, которого нет в проекте,
        предлагается завести; найденный — привязать. Проверьте и поправьте, где нужно.
      </div>
      <div className="space-y-2">
        {links.map((l, i) => {
          const known = !!l.existingTagId;
          const duplicated = (seen.get(l.identifier) || 0) > 1;
          return (
            <div key={`${l.blockKey}-${l.identifier}-${i}`}
              className="rounded-lg border border-slate-200 dark:border-slate-800 p-2.5">
              <div className="flex items-center gap-2 flex-wrap">
                <TagIcon className="w-4 h-4 text-emerald-600 shrink-0" />
                <span className="font-mono text-sm font-bold text-slate-800 dark:text-white">{l.identifier}</span>
                <span className="text-xs text-slate-400 truncate">→ {titleOf(l.blockKey)}</span>
                <span className="flex-1" />
                {CHOICES.map(c => (
                  <button
                    key={c.value}
                    type="button"
                    title={c.hint}
                    onClick={() => onChange(i, c.value)}
                    className={`flex items-center gap-1 text-xs font-bold px-2 py-1 rounded-lg border cursor-pointer ${
                      l.action === c.value
                        ? 'border-emerald-500 bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300'
                        : 'border-slate-200 dark:border-slate-800 text-slate-500 hover:text-slate-800 dark:hover:text-white'
                    } ${c.value === 'link' && !known ? 'opacity-40 pointer-events-none' : ''}`}
                  >
                    <c.Icon className="w-3.5 h-3.5" />{c.label}
                  </button>
                ))}
              </div>
              {(l.takenBy || duplicated || (l.candidates || []).length > 0) && (
                <div className="mt-1.5 pl-6 space-y-1 text-xs">
                  {l.takenBy && (
                    <div className="flex items-center gap-1.5 text-amber-600">
                      <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
                      Тег уже привязан к другому изделию — один тег принадлежит одному изделию,
                      связь останется прежней.
                    </div>
                  )}
                  {duplicated && (
                    <div className="flex items-center gap-1.5 text-amber-600">
                      <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
                      Это обозначение встречается в бланке несколько раз.
                    </div>
                  )}
                  {(l.candidates || []).map(c => (
                    <div key={c.id} className="text-slate-500">
                      Похожий тег проекта: <span className="font-mono">{c.identifier}</span> — {c.why}
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
