/**
 * «Открыть в Таблице» для старой книги .xls и таблицы .csv.
 *
 * Таблица Flux Office правит только .xlsx, поэтому сервер кладёт рядом копию
 * «<имя>.xlsx» (server/routes/officeConvert.ts), а окно сразу открывает её.
 * Исходник не трогается. Повторное открытие ведёт в ту же копию.
 */
import React, { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Empty } from '../components/ui';
import { editorHref } from '../lib/officeFiles';
import { useToastStore } from '../store/toastStore';

export default function SheetCopyEntry() {
  const [params] = useSearchParams();
  const id = params.get('convert') || '';
  const navigate = useNavigate();
  const { addToast } = useToastStore();
  const [error, setError] = useState('');

  useEffect(() => {
    let live = true;
    fetch(`/api/office/files/${encodeURIComponent(id)}/as-xlsx`, { method: 'POST' })
      .then(async (r) => { const d = await r.json().catch(() => ({})); if (!r.ok) throw new Error(d?.error || `сервер ответил ${r.status}`); return d; })
      .then((d) => {
        if (!live) return;
        if (!d.existed) addToast(d.nearby ? `Рядом создана копия «${d.name}»` : `Копия «${d.name}» — в «Выгрузках»: рядом с исходником писать нельзя`, 'success');
        navigate(editorHref(d), { replace: true });
      })
      .catch((e) => { if (live) setError(String(e?.message || e)); });
    return () => { live = false; };
  }, [id]);

  return (
    <div className="flex h-full items-center justify-center p-6">
      {error
        ? <Empty title="Таблица не открылась" text={error} />
        : <p className="text-sm text-slate-500 dark:text-slate-400">Готовится копия .xlsx…</p>}
    </div>
  );
}
