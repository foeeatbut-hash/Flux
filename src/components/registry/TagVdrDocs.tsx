import React from 'react';
import { useNavigate } from 'react-router-dom';

// ── Документы ВДР по тегу: тег — главный у строки реестра ──
// Показывается в карточке тега; клик — переход к строке в Менеджмент → ВДР.
export default function TagVdrDocs({ identifier, projectId }: { identifier: string; projectId: string }) {
  const [docs, setDocs] = React.useState<any[] | null>(null);
  const navigate = useNavigate();

  React.useEffect(() => {
    let dead = false;
    fetch(`/api/vdr/items/by-tag?projectId=${projectId}&tag=${encodeURIComponent(identifier)}`)
      .then(r => r.ok ? r.json() : { items: [] })
      .then(d => { if (!dead) setDocs((d.items || []).filter((x: any) => !x.titleEn?.includes('Vendor Document Register'))); })
      .catch(() => { if (!dead) setDocs([]); });
    return () => { dead = true; };
  }, [identifier, projectId]);

  if (!docs || docs.length === 0) return null;
  const stCls: Record<string, string> = {
    DRAFT: 'text-slate-500', READY: 'text-emerald-600', REMARKS: 'text-amber-600', ACCEPTED: 'text-sky-600',
  };
  const stLabel: Record<string, string> = { DRAFT: 'в работе', READY: 'готово', REMARKS: 'замечания', ACCEPTED: 'принят' };
  return (
    <div className="px-4 pb-3">
      <div className="text-xs font-medium text-emerald-500 mb-1.5">Документы (ВДР) — {docs.length}</div>
      <div className="border border-slate-200 dark:border-slate-800 rounded-lg divide-y divide-slate-100 dark:divide-slate-850 max-h-40 overflow-auto">
        {docs.map((d: any) => (
          <button type="button" key={d.id}
            onClick={() => navigate(`/management?vdr=${d.registerId}&item=${d.id}`)}
            className="w-full text-left px-3 py-1.5 flex items-center gap-2 text-xs hover:bg-emerald-50 dark:hover:bg-emerald-950/30 cursor-pointer">
            <span className="font-semibold text-slate-700 dark:text-slate-300 truncate flex-1" title={`${d.contractorNo}\n${d.titleRu || d.titleEn}`}>
              {d.contractorNo || d.titleRu || d.titleEn}
            </span>
            <span className="text-emerald-500 font-medium shrink-0">{d.vdrCode}</span>
            <span className="text-slate-400 shrink-0">рев. {d.revision}</span>
            <span className={`font-semibold shrink-0 ${stCls[d.status] || ''}`}>{stLabel[d.status] || d.status}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
