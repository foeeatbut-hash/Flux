/**
 * Загрузка заполненной книги атрибутов: чтение файла, окно плана, отмена.
 *
 * Тот же порядок, что у загрузки справочника атрибутов (E3AttributesImport):
 * сервер ничего не пишет, пока человек не увидел план. Здесь в плане главное —
 * ошибки ключей (строка без ID, чужой ID, чужой тег): они названы с листом и
 * номером строки, а такие строки не записываются. Отмена идёт тем же маршрутом,
 * что у импорта расчёта: данные КИП пишутся в характеристики позиции.
 */
import React from 'react';
import { Dialog, Btn } from '../ui';
import { useModalStore } from '../../store/modalStore';
import type { UploadPlan } from '../../../e3/attributeUpload';
import { count } from '../../lib/plural';
import { notifyE3Changed } from '../../lib/e3Changed';

export interface UploadPreview { plan: UploadPlan; issues: string[]; sheets: { name: string; aoa: unknown[][] }[] }

const post = async (url: string, body: unknown) => {
  // Запись значений КИП меняет то, что видит «Нет данных»; план ничего не пишет
  const writes = !url.endsWith('/plan');
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Ошибка ${res.status}`);
  if (writes) notifyE3Changed();
  return data;
};

/** Листы файла как таблицы строк: разбор и проверка ключей — на сервере, где известен проект */
export async function readBookFile(file: File): Promise<{ name: string; aoa: unknown[][] }[]> {
  const XLSX = await import('xlsx');
  const wb = XLSX.read(await file.arrayBuffer(), { type: 'array' });
  return wb.SheetNames.map((name) => ({ name, aoa: XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[name], { header: 1, defval: '', raw: false, blankrows: true }) }));
}

const base = (projectId: string) => `/api/projects/${encodeURIComponent(projectId)}/e3-attribute-upload`;
export const planUploadRequest = async (projectId: string, file: File): Promise<UploadPreview> => {
  const sheets = await readBookFile(file);
  const r = await post(`${base(projectId)}/plan`, { sheets });
  return { plan: r.plan, issues: r.issues || [], sheets };
};
export const applyUploadRequest = (projectId: string, sheets: UploadPreview['sheets']) =>
  post(`${base(projectId)}/apply`, { sheets }) as Promise<{ batchId: string; written: number; values: number; errors: unknown[] }>;

// ── Последняя загрузка: помнится в браузере, как последний импорт расчёта ──
const KEY = (projectId: string) => `flux_e3_upload_${projectId}`;
const WEEK = 7 * 24 * 60 * 60 * 1000;
export function rememberUpload(projectId: string, batchId: string, written: number): void {
  try { localStorage.setItem(KEY(projectId), JSON.stringify({ batchId, written, at: Date.now() })); } catch (_) { /* приватный режим */ }
}
export function lastUpload(projectId: string): { batchId: string; written: number; at: number } | null {
  try {
    const v = JSON.parse(localStorage.getItem(KEY(projectId)) || 'null');
    return v?.batchId && Date.now() - v.at < WEEK ? v : null;
  } catch (_) { return null; }
}
export const forgetUpload = (projectId: string) => { try { localStorage.removeItem(KEY(projectId)); } catch (_) { /* приватный режим */ } };

/** Отмена загрузки: сначала план, потом подтверждение, потом запись */
export async function undoUpload(batchId: string): Promise<{ restored: number; skipped: number }> {
  const plan = await (await fetch(`/api/equipment/import-undo/${encodeURIComponent(batchId)}`)).json();
  const n = (plan.restore || []).length;
  if (!n) throw new Error(plan.skip?.length ? 'Позиции уже правили после загрузки — отменять нечего' : 'Отменять нечего');
  const ok = await useModalStore.getState().openConfirm('Отменить загрузку книги?', `Значения КИП вернутся к прежним у ${count(n, 'позиция', 'позиции', 'позиций')}.${plan.skip?.length ? ` Пропустим (правили после загрузки): ${plan.skip.length}.` : ''}`, { confirmLabel: 'Отменить загрузку', tone: 'danger' });
  if (!ok) throw new Error('');
  return post('/api/equipment/import-undo', { batchId });
}

const Names = ({ names, label }: { names: string[]; label: string }) => (
  <details className="mt-1">
    <summary className="cursor-pointer text-xs text-slate-500 dark:text-slate-400">{label}</summary>
    <div className="mt-1 max-h-28 overflow-auto font-mono text-xs break-words">{names.join(', ')}</div>
  </details>
);

export default function E3UploadDialog({ preview, busy, error, onApply, onClose }: {
  preview: UploadPreview; busy: boolean; error: string; onApply: () => void; onClose: () => void;
}) {
  const { plan, issues } = preview;
  const values = plan.writes.reduce((n, w) => n + w.changes.length, 0);
  const nothing = plan.writes.length === 0;
  return (
    <Dialog title="Загрузка книги атрибутов" onClose={onClose} busy={busy} width="max-w-2xl" scrollBody label="План загрузки книги атрибутов"
      footer={<><Btn onClick={onClose} disabled={busy}>Отмена</Btn><Btn tone="primary" disabled={busy || nothing} onClick={onApply} title={nothing ? 'Книга ничего не меняет' : undefined}>Записать</Btn></>}>
      <p className="text-sm tabular-nums">
        Изменится позиций: <b className="font-semibold">{plan.writes.length}</b> · значений: <b className="font-semibold">{values}</b> · без изменений: <b className="font-semibold">{plan.same}</b>
        {plan.errors.length > 0 && <> · ошибок: <b className="font-semibold text-rose-600 dark:text-rose-400">{plan.errors.length}</b></>}
      </p>
      <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">Значения ложатся в группу «КИП» характеристик позиции. Пустая ячейка ничего не стирает.</p>

      {issues.length > 0 && <ul role="status" className="mt-3 list-disc space-y-0.5 pl-4 text-xs text-amber-700 dark:text-amber-400">{issues.map((t, i) => <li key={i}>{t}</li>)}</ul>}

      {plan.errors.length > 0 && <section className="mt-3">
        <div className="fx-label">Ошибки — эти строки не будут записаны · {plan.errors.length}</div>
        <div className="mt-1 max-h-44 overflow-auto rounded border border-slate-200 dark:border-slate-700">
          {plan.errors.map((e, i) => (
            <div key={i} className="border-b border-slate-100 px-2 py-1 text-xs last:border-b-0 dark:border-slate-800">
              <span className="font-mono text-slate-500 dark:text-slate-400">{e.sheet}, строка {e.line}</span> — {e.message}
            </div>
          ))}
        </div>
      </section>}

      {plan.notes.length > 0 && <section className="mt-3">
        <div className="fx-label">Замечания к столбцам</div>
        {plan.notes.map((n) => <div key={n.code} className="mt-1 text-xs text-amber-700 dark:text-amber-400">{n.text}{n.names.length > 0 && <Names names={n.names} label="Какие атрибуты" />}</div>)}
      </section>}

      {plan.writes.length > 0 && <section className="mt-3">
        <div className="fx-label">Что изменится</div>
        <div className="mt-1 max-h-56 overflow-auto rounded border border-slate-200 dark:border-slate-700">
          {plan.writes.map((w) => (
            <div key={w.id} className="border-b border-slate-100 px-2 py-1 last:border-b-0 dark:border-slate-800">
              <div className="font-mono text-xs">{w.label}</div>
              {w.changes.map((c) => (
                <div key={c.attr} className="text-xs text-slate-600 dark:text-slate-400">
                  <span className="font-mono">{c.attr}</span>: {c.before || '—'} → <span className="text-slate-900 dark:text-slate-100">{c.after}</span>
                </div>
              ))}
            </div>
          ))}
        </div>
      </section>}
      {error && <p role="alert" className="fx-error mt-3">{error}</p>}
    </Dialog>
  );
}
