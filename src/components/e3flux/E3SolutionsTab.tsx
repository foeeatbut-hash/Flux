/**
 * Вкладка «Типовые решения» в E3Flux (docs/e3-integration.md, раздел 5):
 * слева разделы каталога, справа рабочая область. Книга каталога читается один
 * раз и общая для всех разделов, чтобы правка признака сразу была видна в
 * карточке решения и в подборе.
 */
import React, { useEffect, useState } from 'react';
import { BookA, Cable, Crosshair, Layers, Link2, ListChecks, Workflow, type LucideIcon } from 'lucide-react';
import NoProject from '../NoProject';
import E3ClassMapPanel from './E3ClassMapPanel';
import E3DictionaryPanel from './E3DictionaryPanel';
import E3FeaturesPanel from './E3FeaturesPanel';
import E3IoPanel from './E3IoPanel';
import E3RulesPanel from './E3RulesPanel';
import E3SelectionPanel from './E3SelectionPanel';
import E3SolutionsPanel from './E3SolutionsPanel';
import type { E3Jump } from './e3Jump';
import { useSolutionBook } from './useSolutionBook';

type Part = 'solutions' | 'features' | 'rules' | 'io' | 'dictionary' | 'classmap' | 'selection';

/** Раздел каталога по разделу перехода: правила состава живут в «Таблице IO» */
const partOf = (section?: string): Part | null => (section === 'io-rules' ? 'io' : (['solutions', 'features', 'rules', 'io', 'dictionary', 'classmap', 'selection'] as string[]).includes(section || '') ? (section as Part) : null);

export default function E3SolutionsTab({ rights, projectId, jump, done }: { rights: { edit: boolean; import: boolean }; projectId: string; jump?: E3Jump | null; done?: () => void }) {
  const state = useSolutionBook();
  const [part, setPart] = useState<Part>(partOf(jump?.section) || 'solutions');
  useEffect(() => { const p = partOf(jump?.section); if (p) setPart(p); }, [jump]);
  const pass = { jump: jump ?? null, done: done ?? (() => undefined) };
  const { book } = state;
  const parts: Array<[Part, string, LucideIcon, number | undefined]> = [
    ['solutions', 'Решения', Layers, book?.solutions.filter((s) => !s.removed).length],
    ['features', 'Признаки', ListChecks, book?.features.length],
    ['rules', 'Правила', Workflow, book?.rules.length],
    ['io', 'Таблица IO', Cable, book?.ioTable?.length],
    ['dictionary', 'Обозначения', BookA, book ? Object.keys(book.dictionary).length : undefined],
    ['classmap', 'Типы и классы', Link2, book ? Object.keys(book.classMap).length : undefined],
    ['selection', 'Подбор по проекту', Crosshair, undefined],
  ];
  return (
    <div className="flex h-full min-h-0">
      <nav className="fx-side w-52 shrink-0 p-2" aria-label="Разделы каталога решений">
        {parts.map(([id, label, Icon, n]) => (
          <button key={id} type="button" className="fx-li w-full" aria-current={part === id} onClick={() => setPart(id)}>
            <Icon />{label}{n ? <span className="fx-n">{n}</span> : null}
          </button>
        ))}
      </nav>
      <div className="min-w-0 flex-1">
        {part === 'solutions' ? <E3SolutionsPanel state={state} rights={rights} jump={pass} />
          : part === 'features' ? <E3FeaturesPanel state={state} rights={rights} jump={pass} />
          : part === 'rules' ? <E3RulesPanel state={state} rights={rights} jump={pass} />
          : part === 'io' ? <E3IoPanel state={state} rights={rights} jump={pass} />
          : part === 'dictionary' ? <E3DictionaryPanel state={state} rights={rights} />
          : part === 'classmap' ? <E3ClassMapPanel state={state} rights={rights} />
          : projectId ? <E3SelectionPanel key={projectId} book={book} projectId={projectId} jump={pass} /> : <NoProject what="подбора решений" />}
      </div>
    </div>
  );
}
