/**
 * Строка «В схеме E3» в карточке позиции (docs/e3-integration.md, 8.3): ОВ
 * видит, что его подбор уже ушёл в схему КИП и что переподбор заденет чужую
 * работу. «Изменилась после выгрузки» — версия позиции больше той, что
 * отправили. Строка открывает E3Flux на этой позиции.
 */
import React, { useEffect, useState } from 'react';
import { Workflow } from 'lucide-react';
import { ENV_CONFIG } from '../../config/env';
import { useStore } from '../../store/store';
import { useWindowStore } from '../../store/windowStore';

interface Row { elementId: string; project: string; sheet: string; designation: string; sentVersion: string; state: string }

// Один запрос на проект, а не на каждую открытую карточку; через полминуты — заново
const cache = new Map<string, { at: number; rows: Promise<Row[]> }>();
const load = (projectId: string): Promise<Row[]> => {
  const hit = cache.get(projectId);
  if (hit && Date.now() - hit.at < 30_000) return hit.rows;
  const rows = fetch(`${ENV_CONFIG.apiUrl}/projects/${encodeURIComponent(projectId)}/e3/summary`).then((r) => (r.ok ? r.json() : [])).catch(() => []);
  cache.set(projectId, { at: Date.now(), rows });
  return rows;
};

export default function E3SchemeLine({ componentId, version }: { componentId: string; version: number }) {
  const projectId = useStore((s) => s.activeProject?.id) || '';
  const [rows, setRows] = useState<Row[]>([]);
  useEffect(() => {
    let alive = true;
    if (!projectId) return;
    void load(projectId).then((all) => { if (alive) setRows(all.filter((r) => r.elementId === componentId)); });
    return () => { alive = false; };
  }, [projectId, componentId]);
  if (!rows.length) return null;
  return <div className="mt-1 flex flex-col gap-0.5">{rows.map((r, i) => {
    const changed = String(version) !== r.sentVersion;
    return (
      <button key={i} type="button" onClick={() => useWindowStore.getState().open(`/e3flux?position=${encodeURIComponent(componentId)}`)}
        className="inline-flex max-w-full items-center gap-1 text-2xs text-slate-500 hover:text-emerald-600 cursor-pointer" title="Открыть E3Flux на этой позиции">
        <Workflow className="w-3 h-3 shrink-0" />
        <span className="truncate">В схеме E3: {r.project}{r.sheet ? `, ${r.sheet}` : ''}{r.designation ? `, ${r.designation}` : ''}{r.state === 'REMOVED_IN_FLUX' ? ' · снята во Flux' : changed ? ' · изменилась после выгрузки' : ''}</span>
      </button>
    );
  })}</div>;
}
