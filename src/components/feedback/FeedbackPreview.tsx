/**
 * «Что уйдёт» — предпросмотр перед отправкой.
 *
 * Показывается не для красоты. Обращение несёт с собой технические записи и
 * сведения о программе, и человек имеет право увидеть их ДО отправки, а не
 * узнать потом, что вместе с описанием уехал журнал. Поэтому здесь ровно то,
 * что попадёт на сервер, — тем же составом и в том же порядке.
 */
import React from 'react';
import { FileText, Image as ImageIcon, Activity } from 'lucide-react';
import { TYPE_NAMES, FREQUENCY_NAMES, IMPACT_NAMES } from '../../../feedback/contracts';
import type { Fields } from '../../feedback/useComposer';
import type { DraftAttachment } from '../../feedback/draftDb';

const kilobytes = (bytes: number): string =>
  bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} МБ` : `${Math.max(1, Math.round(bytes / 1024))} КБ`;

const ICONS = { IMAGE: ImageIcon, FILE: FileText, DIAGNOSTICS: Activity };

function Line({ name, value }: { name: string; value: string }) {
  if (!value) return null;
  return (
    <div className="flex gap-3 py-1">
      <span className="w-28 shrink-0 text-xs text-slate-500 dark:text-slate-400">{name}</span>
      <span className="min-w-0 flex-1 text-xs text-slate-800 dark:text-slate-150 whitespace-pre-wrap break-words">{value}</span>
    </div>
  );
}

export default function FeedbackPreview({ fields, attachments, appVersion }: {
  fields: Fields;
  attachments: DraftAttachment[];
  appVersion: string;
}) {
  const steps = fields.steps.filter((s) => s.trim());
  return (
    <div className="space-y-3">
      <div className="rounded-lg border border-slate-200 dark:border-slate-800 p-3">
        <Line name="Вид" value={TYPE_NAMES[fields.type]} />
        <Line name="Заголовок" value={fields.title} />
        <Line name="Описание" value={fields.description} />
        {steps.length > 0 && (
          <Line name="Шаги" value={steps.map((s, i) => `${i + 1}. ${s}`).join('\n')} />
        )}
        <Line name="Ожидалось" value={fields.expected} />
        <Line name="Получилось" value={fields.actual} />
        <Line name="Польза" value={fields.benefit} />
        <Line name="Как часто" value={FREQUENCY_NAMES[fields.frequency]} />
        <Line name="Насколько мешает" value={IMPACT_NAMES[fields.impact]} />
        <Line name="Когда случилось" value={new Date(fields.incidentAt).toLocaleString('ru-RU')} />
      </div>

      <div className="rounded-lg border border-slate-200 dark:border-slate-800 p-3 space-y-1.5">
        <div className="text-xs font-bold text-slate-800 dark:text-slate-150">Вложения</div>
        {attachments.length === 0 && (
          <p className="text-xs text-slate-500 dark:text-slate-400">Ничего не приложено.</p>
        )}
        {attachments.map((item) => {
          const Icon = ICONS[item.kind] || FileText;
          return (
            <div key={item.id} className="flex items-center gap-2 text-xs text-slate-700 dark:text-slate-300">
              <Icon className="w-3.5 h-3.5 shrink-0 text-slate-400" />
              <span className="min-w-0 flex-1 truncate">{item.name}</span>
              <span className="shrink-0 text-slate-500 dark:text-slate-400">{kilobytes(item.blob?.size || 0)}</span>
            </div>
          );
        })}
        {fields.technicalEvents && !attachments.some((a) => a.kind === 'DIAGNOSTICS') && (
          <p className="text-xs text-slate-500 dark:text-slate-400">
            Технические записи этого окна снимутся в момент отправки — по ним видно, что происходило перед сбоем.
          </p>
        )}
      </div>

      <p className="text-xs text-slate-500 dark:text-slate-400 leading-relaxed">
        {fields.appContext
          ? `Вместе с обращением уедет версия программы (${appVersion}) и раздел, в котором вы были.`
          : 'Сведения о программе прикладывать не будем — разбирающему придётся спросить их у вас.'}
        {' '}Наружу не уходит ничего: всё остаётся на сервере компании.
      </p>
    </div>
  );
}
