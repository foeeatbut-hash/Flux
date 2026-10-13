import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Btn, Dialog, Empty } from '../ui';
import { editorHref, saveNewFile } from '../../lib/officeFiles';
import { officeDataApi, type OfficeQuery, type OfficeQueryResult } from './fluxData';
import { csvText, exportFile, exportMessage, sourceTitle, tableRows, xlsxBytes, type ExportFormat, type TableColumn } from './fluxTable';

interface Props {
  sourceId: string;
  /** Все столбцы источника; в выгрузку идут отмеченные. */
  columns: TableColumn[];
  result: OfficeQueryResult | null;
  selectedIds: string[];
  query: OfficeQuery;
  onClose: () => void;
}

/** Скачивание: ссылка на blob, как в старой панели. */
function downloadBlob(blob: Blob, name: string) {
  const href = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = href;
  anchor.download = name;
  anchor.click();
  URL.revokeObjectURL(href);
}

/**
 * Команда ленты «Выгрузить»: XLSX, CSV и «Книга Flux» (новый файл в
 * Проводнике и переход в него). Перенесено из старой панели: выбранные строки,
 * иначе все отобранные; без предела по числу строк; по отмеченным столбцам.
 */
export default function FluxExportDialog({ sourceId, columns, result, selectedIds, query, onClose }: Props) {
  const navigate = useNavigate();
  const [chosen, setChosen] = useState<string[]>(() => columns.map((column) => column.key));
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const active = useMemo(() => columns.filter((column) => chosen.includes(column.key)), [columns, chosen]);
  const count = selectedIds.length || result?.rows.length || 0;
  const title = sourceTitle(sourceId);

  const run = async (format: ExportFormat) => {
    if (!result || !active.length || busy) return;
    setBusy(true); setMessage('');
    try {
      // Выборка загружена не целиком (предел окна): выгрузке нужны все строки
      let data = result;
      if (!selectedIds.length && result.total > result.rows.length) {
        data = await officeDataApi.query({ ...query, columns: columns.map((column) => column.key), limit: 50000 });
      }
      const rows = tableRows(data, active, selectedIds);
      if (!rows.length) { setMessage('Нет строк для выгрузки.'); return; }
      const file = exportFile(active, rows, title, format);
      if (format === 'csv') downloadBlob(new Blob([csvText(file)], { type: 'text/csv;charset=utf-8;' }), file.name);
      else {
        const bytes = await xlsxBytes(file);
        if (format === 'office') navigate(editorHref(await saveNewFile(bytes, file.name, 'exports')));
        else downloadBlob(new Blob([bytes as BlobPart], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), file.name);
      }
      setMessage(exportMessage(format, rows.length));
    } catch (reason: any) { setMessage(String(reason?.message || 'Не удалось подготовить файл.')); }
    finally { setBusy(false); }
  };

  return <Dialog title={`Выгрузить: ${title}`} onClose={onClose} busy={busy} width="max-w-lg" scrollBody
    footer={<><Btn tone="ghost" onClick={onClose} disabled={busy}>Закрыть</Btn>
      <Btn disabled={busy || !result || !active.length} onClick={() => void run('xlsx')}>XLSX</Btn>
      <Btn disabled={busy || !result || !active.length} onClick={() => void run('csv')}>CSV</Btn>
      <Btn tone="primary" disabled={busy || !result || !active.length} onClick={() => void run('office')} title="Сохранить в Проводнике и открыть в Flux Office">Книга Flux</Btn></>}>
    {!result ? <Empty title="Нет выборки" text="Выберите источник на ленте или во вкладке «Выборка» и обновите выборку." /> : <>
      <p className="mb-2 text-sm">{selectedIds.length ? `Будут выгружены выбранные строки: ${selectedIds.length.toLocaleString('ru-RU')}.` : `Будут выгружены все строки выборки: ${(result.total || count).toLocaleString('ru-RU')}.`}</p>
      <details open className="rounded-lg border border-slate-200 px-2 py-1.5 dark:border-slate-700">
        <summary className="cursor-pointer text-xs text-slate-600 dark:text-slate-300">Столбцы: {active.length} из {columns.length}</summary>
        <div className="mt-2 flex gap-2 text-xs">
          <button type="button" className="fx-btn fx-btn-quiet fx-btn-sm" onClick={() => setChosen(columns.map((column) => column.key))}>Выбрать все</button>
          <button type="button" className="fx-btn fx-btn-quiet fx-btn-sm" onClick={() => setChosen([])}>Снять выбор</button>
        </div>
        <div className="mt-2 flex max-h-40 flex-wrap gap-x-3 gap-y-1 overflow-auto">
          {columns.map((column) => <label key={column.key} className="flex items-center gap-1 text-xs text-slate-600 dark:text-slate-300">
            <input type="checkbox" className="accent-emerald-600" checked={chosen.includes(column.key)} onChange={(event) => setChosen((current) => event.target.checked ? [...current, column.key] : current.filter((key) => key !== column.key))} />{column.title}
          </label>)}
        </div>
      </details>
    </>}
    {message && <p role="status" className="mt-3 text-xs text-slate-600 dark:text-slate-300">{message}</p>}
  </Dialog>;
}
