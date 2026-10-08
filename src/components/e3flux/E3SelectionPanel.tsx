/**
 * «Подбор по проекту»: какое типовое решение подобрано каждой позиции и где
 * нужен ответ (docs/e3-integration.md, 5.2 и 5.6). Слева — профиль проекта:
 * его правка тут же пересчитывает подбор, а записывается кнопкой. Позиции без
 * типового решения по природе (шумоглушитель, секция) в список не попадают, а
 * видны одной строкой внизу.
 */
import React, { useEffect, useMemo, useState } from 'react';
import { buildRecipe } from '../../../e3/recipe';
import { selectSolution } from '../../../e3/solutionSelect';
import type { E3Position, E3Profile, E3Selection, E3SolutionBook } from '../../../e3/solutionTypes';
import { classById, classOrder } from '../../../equipment/classes';
import { e3SolutionsService as svc, E3SolutionVersionError, type E3ProfileDoc } from '../../services/e3SolutionsService';
import { buildExportSources, type ExportSystem } from '../../lib/exportWorkspace';
import { toPositions } from '../../lib/e3Positions';
import { count } from '../../lib/plural';
import { can } from '../../lib/permissions';
import { useStore } from '../../store/store';
import { Empty, FilterSeg, Input, SectionHead, Select, Status, Toolbar } from '../ui';
import E3ProfileForm from './E3ProfileForm';
import E3SelectionDialog from './E3SelectionDialog';
import { solutionLine } from './e3SolutionText';

const muted = 'text-slate-500 dark:text-slate-400';
const SHOWN = 500;
/** Позиция подбора; соседи нужны составу блока: подпозиции ищутся по тегу владельца */
interface Row { id: string; label: string; cls: string; selection: E3Selection; position: E3Position; siblings: E3Position[] }
type View = 'all' | 'one' | 'many' | 'none';
const STATE = {
  one: { tone: 'emerald', text: 'Подобрано' }, many: { tone: 'amber', text: 'Нужен ответ' }, none: { tone: 'rose', text: 'Решения нет' },
} as const;

export default function E3SelectionPanel({ book, projectId }: { book: E3SolutionBook | null; projectId: string }) {
  const [systems, setSystems] = useState<ExportSystem[] | null>(null);
  const [profile, setProfile] = useState<E3ProfileDoc | null>(null);
  const [draft, setDraft] = useState<E3Profile>({});
  const [error, setError] = useState('');
  const [profileError, setProfileError] = useState('');
  const [busy, setBusy] = useState(false);
  const [scope, setScope] = useState('all');
  const [view, setView] = useState<View>('all');
  const [q, setQ] = useState('');
  const [open, setOpen] = useState('');
  // Профиль ведёт инженер КИП: право `e3.export` (раздел 11); без него форма только читается
  const mayEdit = can(useStore((s) => s.user) as any, 'e3.export');

  const loadProfile = React.useCallback(async () => { const p = await svc.profile(projectId); setProfile(p); setDraft(p.answers); }, [projectId]);
  useEffect(() => {
    let alive = true;
    setSystems(null); setProfile(null); setError('');
    Promise.all([
      fetch(`/api/projects/${encodeURIComponent(projectId)}/systems`).then((r) => { if (!r.ok) throw new Error('Оборудование недоступно. Проверьте доступ к проекту'); return r.json(); }),
      svc.profile(projectId),
    ]).then(([data, p]) => { if (alive) { setSystems(data.systems || []); setProfile(p); setDraft(p.answers); } })
      .catch((e: any) => { if (alive) setError(e.message || 'Не удалось загрузить данные'); });
    return () => { alive = false; };
  }, [projectId]);

  const sources = useMemo(() => buildExportSources(systems || [], []), [systems]);
  const units = sources.scopes.filter((s) => s.id.startsWith('unit:'));

  // Подпозиции ищутся среди соседей по тегу владельца: берём позиции одной установки, а не всего проекта
  const rows = useMemo(() => {
    if (!book || !systems) return { list: [] as Row[], skipped: 0 };
    const items = sources.rows(scope);
    const bySystem = new Map<string, typeof items>();
    for (const it of items) bySystem.set(it.systemName, [...(bySystem.get(it.systemName) || []), it]);
    const list: Row[] = [];
    let skipped = 0;
    for (const group of bySystem.values()) {
      const positions = toPositions(group);
      group.forEach((it, i) => {
        const p = positions[i];
        if (!(book.classMap[p.cls] || []).length) { skipped++; return; }
        list.push({ id: `${it.id}:${i}`, label: (it.tags || [])[0]?.identifier || String(it.name || ''), cls: p.cls, selection: selectSolution(p, positions, book, draft), position: p, siblings: positions });
      });
    }
    list.sort((a, b) => classOrder(a.cls) - classOrder(b.cls) || a.label.localeCompare(b.label, 'ru', { numeric: true }));
    return { list, skipped };
  }, [book, systems, sources, scope, draft]);

  const counts = { one: 0, many: 0, none: 0 };
  for (const r of rows.list) counts[r.selection.status]++;
  const low = q.trim().toLocaleLowerCase('ru');
  const shown = rows.list.filter((r) => (view === 'all' || r.selection.status === view)
    && (!low || `${r.label} ${r.selection.solution?.name || ''} ${r.selection.solution?.id || ''}`.toLocaleLowerCase('ru').includes(low)));
  const opened = rows.list.find((r) => r.id === open);
  const dirty = !!profile && JSON.stringify(draft) !== JSON.stringify(profile.answers);

  const saveProfile = async () => {
    if (!profile) return;
    setBusy(true); setProfileError('');
    try { const p = await svc.saveProfile(projectId, draft, profile.version); setProfile(p); setDraft(p.answers); }
    catch (e: any) {
      if (e instanceof E3SolutionVersionError) { await loadProfile().catch(() => undefined); setProfileError('Профиль изменён коллегой — он перечитан, повторите правку.'); } else setProfileError(e.message);
    } finally { setBusy(false); }
  };
  const answer = (id: string, value: string) => setDraft((d) => { const { [id]: _drop, ...rest } = d; return value ? { ...rest, [id]: value } : rest; });

  if (error) return <div className="p-4"><Empty title="Подбор недоступен" text={error} /></div>;
  if (!systems || !profile || !book) return <div role="status" className={`p-4 text-sm ${muted}`}>Подготовка данных проекта…</div>;
  if (!book.solutions.some((s) => !s.removed)) return <div className="p-4"><Empty title="Каталог типовых решений пуст" text="Сначала загрузите «Классификатор типовых решений» из Excel на вкладке «Решения»." /></div>;

  return (
    <div className="fx-page min-w-0">
      <SectionHead title="Подбор по проекту" count={rows.list.length ? count(rows.list.length, 'позиция', 'позиции', 'позиций') : ''} />
      <div className="flex min-h-0 flex-1">
        <aside className="fx-side flex w-64 shrink-0 flex-col gap-3 overflow-hidden p-3" aria-label="Профиль и отбор">
          <label className="fx-field shrink-0"><span className="fx-label">Установка</span>
            <Select value={scope} onChange={setScope} aria-label="Установка" options={[{ value: 'all', label: `Все установки · ${sources.rows('all').length}` }, ...units.map((u) => ({ value: u.id, label: `${u.label.replace(/^Установка «|»$/g, '')} · ${u.count}` }))]} />
          </label>
          <E3ProfileForm features={book.features} answers={draft} dirty={dirty} busy={busy} error={profileError} canSave={mayEdit} onChange={answer} onSave={() => void saveProfile()} />
        </aside>
        <div className="flex min-w-0 flex-1 flex-col border-l border-slate-200 dark:border-slate-800">
          <Toolbar>
            <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Поиск" title="Тег позиции или решение" aria-label="Поиск позиции" className="w-[120px]" />
            <FilterSeg label="Какие позиции показать" value={view} onChange={setView} options={[
              { value: 'all', label: 'Все', count: rows.list.length }, { value: 'one', label: 'Подобрано', count: counts.one },
              { value: 'many', label: 'Нужен ответ', count: counts.many, hint: 'Подходит несколько решений: не хватает признака' }, { value: 'none', label: 'Решения нет', count: counts.none },
            ]} />
          </Toolbar>
          <div className="min-h-0 flex-1 overflow-auto">
            {!shown.length ? <div className="p-4"><Empty title="Позиций нет" text={rows.list.length ? 'Измените поиск или отбор.' : 'В выбранном охвате нет оборудования, для которого есть типовые решения.'} /></div> : (
              <table className="fx-table text-left">
                <thead><tr><th>Позиция</th><th>Тип</th><th>Типовое решение</th><th>Состояние</th></tr></thead>
                <tbody>{shown.slice(0, SHOWN).map((r) => {
                  const st = STATE[r.selection.status];
                  const s = r.selection.solution;
                  return (
                    <tr key={r.id} tabIndex={0} role="button" className="cursor-pointer" onClick={() => setOpen(r.id)}
                      onKeyDown={(e) => { if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); setOpen(r.id); } }}>
                      <td className="whitespace-nowrap font-mono">{r.label || '—'}</td>
                      <td className="whitespace-nowrap">{classById(r.cls).title}</td>
                      <td className={`max-w-[420px] truncate font-mono ${s ? '' : muted}`} title={s ? solutionLine(s) : undefined}>{s ? solutionLine(s) : r.selection.status === 'many' ? `подходит ${r.selection.candidates.length}` : '—'}</td>
                      <td className="whitespace-nowrap"><Status tone={st.tone}>{st.text}</Status></td>
                    </tr>
                  );
                })}</tbody>
              </table>
            )}
          </div>
          {(shown.length > SHOWN || rows.skipped > 0) && <div className={`border-t border-slate-200 px-4 py-1 text-xs dark:border-slate-800 ${muted}`}>
            {shown.length > SHOWN && `Показано ${SHOWN} из ${shown.length}. `}
            {rows.skipped > 0 && `Не участвуют в схеме: ${rows.skipped} (для их типов решений нет и не нужно).`}
          </div>}
        </div>
      </div>
      {opened && <E3SelectionDialog label={opened.label} cls={opened.cls} selection={opened.selection} features={book.features}
        recipe={opened.selection.status === 'one' ? buildRecipe(opened.selection, opened.position, opened.siblings, book) : undefined} onClose={() => setOpen('')} />}
    </div>
  );
}
