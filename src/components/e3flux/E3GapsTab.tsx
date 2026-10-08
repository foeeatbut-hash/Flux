/**
 * Вкладка «Нет данных» в E3Flux: живой список мест, где E3Flux не хватает
 * данных, со ссылкой прямо на запись. Слева группы (атрибуты, каталог, проект),
 * справа «что · где · почему» и кнопка-ссылка. Список ничего не хранит и
 * пересчитывается из тех же загрузок, что у соседних вкладок (`useGapsData`).
 */
import React, { useMemo, useState } from 'react';
import { BookMarked, FolderKanban, Layers, ListChecks, type LucideIcon } from 'lucide-react';
import { GAP_GROUP, GAP_KIND_TITLES, type Gap, type GapGroup, type GapKind, type GapSeverity, type GapWhere } from '../../../e3/gaps';
import { Btn, Empty, Input, Select, Status, Toolbar } from '../ui';
import NoProject from '../NoProject';

const muted = 'text-slate-500 dark:text-slate-400';
/** Больше строк в окне не рисуем: список для просмотра, поиск и отбор сужают его */
const SHOWN = 500;
type Part = 'all' | GapGroup;
const PARTS: Array<[Part, string, LucideIcon]> = [['all', 'Все', ListChecks], ['attributes', 'Атрибуты', BookMarked], ['catalog', 'Каталог', Layers], ['project', 'Проект', FolderKanban]];
const SEVERITY: Record<GapSeverity, { tone: 'rose' | 'amber' | 'slate'; text: string }> = {
  error: { tone: 'rose', text: 'Ошибка' }, warn: { tone: 'amber', text: 'Не хватает' }, info: { tone: 'slate', text: 'Справка' },
};

export default function E3GapsTab({ gaps, ready, error, hasProject, loadedAt, onOpen }: {
  gaps: Gap[]; ready: boolean; error: string; hasProject: boolean; loadedAt: number; onOpen: (where: GapWhere) => void;
}) {
  const [part, setPart] = useState<Part>('all');
  const [kind, setKind] = useState('');
  const [q, setQ] = useState('');

  const counts = useMemo(() => {
    const m: Record<Part, number> = { all: gaps.length, attributes: 0, catalog: 0, project: 0 };
    for (const g of gaps) m[GAP_GROUP[g.kind]]++;
    return m;
  }, [gaps]);
  const inPart = useMemo(() => gaps.filter((g) => part === 'all' || GAP_GROUP[g.kind] === part), [gaps, part]);
  // Виды, которые есть в выбранной группе, со счётом: пустые виды в отборе не нужны
  const kinds = useMemo(() => {
    const m = new Map<GapKind, number>();
    for (const g of inPart) m.set(g.kind, (m.get(g.kind) || 0) + 1);
    return [...m.entries()];
  }, [inPart]);
  const low = q.trim().toLocaleLowerCase('ru');
  const shown = useMemo(() => inPart.filter((g) => (!kind || g.kind === kind) && (!low || `${g.title} ${g.place} ${g.detail}`.toLocaleLowerCase('ru').includes(low))), [inPart, kind, low]);

  if (error && !ready) return <div className="p-4"><Empty title="Список недоступен" text={error} /></div>;
  if (!ready) return <div role="status" className={`p-4 text-sm ${muted}`}>Подготовка данных…</div>;

  const choose = (p: Part) => { setPart(p); setKind(''); };
  const kindValue = kinds.some(([k]) => k === kind) ? kind : '';
  return (
    <div className="flex h-full min-h-0">
      <nav className="fx-side w-52 shrink-0 p-2" aria-label="Группы пробелов">
        {PARTS.map(([id, label, Icon]) => (
          <button key={id} type="button" className="fx-li w-full" aria-current={part === id} onClick={() => choose(id)}
            title={id === 'project' && !hasProject ? 'Выберите проект, чтобы увидеть пробелы по его позициям' : undefined}>
            <Icon />{label}{counts[id] ? <span className="fx-n">{counts[id]}</span> : null}
          </button>
        ))}
      </nav>
      <div className="flex min-w-0 flex-1 flex-col">
        <Toolbar>
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Поиск" title="Запись, место или причина" aria-label="Поиск по пробелам" className="w-[160px]" />
          <Select value={kindValue} onChange={setKind} aria-label="Вид пробела" className="w-auto"
            options={[{ value: '', label: `все виды · ${inPart.length}` }, ...kinds.map(([k, n]) => ({ value: k, label: `${GAP_KIND_TITLES[k]} · ${n}` }))]} />
          {error && <span role="alert" className="fx-error text-xs">{error}</span>}
          <span className={`ml-auto text-xs ${muted}`}>{loadedAt ? `Обновлено ${new Date(loadedAt).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}` : ''}</span>
        </Toolbar>
        <div className="min-h-0 flex-1 overflow-auto">
          {part === 'project' && !hasProject ? <NoProject what="пробелов по позициям" />
            : !shown.length ? <div className="p-4"><Empty title={gaps.length ? 'Ничего не найдено' : 'Данных хватает'} text={gaps.length ? 'Измените поиск или отбор.' : 'Справочник, каталог и позиции проекта не просят ничего добавить.'} /></div> : (
              <table className="fx-table text-left">
                <thead><tr><th>Состояние</th><th>Что</th><th>Где</th><th>Почему</th><th><span className="sr-only">Ссылка</span></th></tr></thead>
                <tbody>{shown.slice(0, SHOWN).map((g) => {
                  const s = SEVERITY[g.severity];
                  return (
                    <tr key={g.key}>
                      <td className="whitespace-nowrap"><Status tone={s.tone}>{s.text}</Status></td>
                      <td className="max-w-[200px] truncate font-mono" title={g.title}>{g.title}</td>
                      <td className="max-w-[220px] truncate" title={g.place}>{g.place}</td>
                      <td className={`max-w-[300px] truncate ${muted}`} title={g.detail}>{g.detail}</td>
                      <td className="whitespace-nowrap text-right"><Btn tone="ghost" size="sm" onClick={() => onOpen(g.where)} aria-label={`Открыть: ${g.title}`} title={`Открыть: ${g.place}`}>Открыть</Btn></td>
                    </tr>
                  );
                })}</tbody>
              </table>
            )}
        </div>
        {shown.length > SHOWN && <div className={`border-t border-slate-200 px-4 py-1 text-xs dark:border-slate-800 ${muted}`}>Показано {SHOWN} из {shown.length} — сузьте поиск или выберите вид.</div>}
      </div>
    </div>
  );
}
