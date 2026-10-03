import React, { useMemo, useState } from 'react';
import type { CatalogDraft, CatalogWorkspace } from '../../../catalog/publication';
import { catalogDifferences } from '../../../catalog/review';
import { catalogWorkspaceService } from '../../services/catalogWorkspaceService';
import { catalogService } from '../../services/catalogService';
import { veza2026Pack } from '../../../catalog/packs/veza2026';
import { useStore } from '../../store/store';
import { Btn, Empty } from './ui';

const FIELD_NAMES: Record<string, string> = {
  id: 'Идентификатор', code: 'Код', title: 'Название', name: 'Название', shortName: 'Короткое название',
  classId: 'Вид оборудования', manufacturerId: 'Изготовитель', classIds: 'Применяемость: виды',
  familyIds: 'Применяемость: модели', description: 'Описание', kind: 'Тип изделия', typeLabel: 'Тип позиции',
  status: 'Состояние данных', sort: 'Порядок', facts: 'Характеристики', shapes: 'Формы', params: 'Параметры',
  positions: 'Позиции обозначения', rules: 'Правила', match: 'Условия подбора', specs: 'Характеристики изделия',
  documents: 'Документы', tables: 'Таблицы', catalog: 'Каталог', assetId: 'Файл каталога', label: 'Подпись',
  ru: 'Русский текст', en: 'Английский текст', unit: 'Единица измерения', values: 'Допустимые значения',
  default: 'Значение по умолчанию', min: 'Минимум', max: 'Максимум', source: 'Источник', pages: 'Страницы',
  edition: 'Редакция', country: 'Страна', standard: 'Стандарт', notes: 'Примечания', skip: 'Пропускать',
  actuatorCode: 'Код привода', role: 'Роль', key: 'Ключ', format: 'Формат', formats: 'Форматы',
};

function humanField(path: string): string {
  return path.replace(/\[([^\]]+)\]/g, '.$1').split('.').filter(Boolean).map((part) => {
    if (FIELD_NAMES[part]) return FIELD_NAMES[part];
    if (/^[a-z0-9_-]{1,80}$/i.test(part) && /\d/.test(part)) return `элемент ${part}`;
    return part.replace(/([a-zа-я])([A-Z])/g, '$1 $2').toLocaleLowerCase('ru');
  }).join(' · ') || 'Запись';
}

function draftNeedsSecondReview(draft: CatalogDraft, requireSecondReview: boolean): boolean {
  return requireSecondReview && ['family', 'component'].includes(draft.entity)
    && (!draft.reviewedById || draft.reviewedById === draft.authorId);
}

function friendlyPublishError(message: string): string {
  if (/другим сотрудником|проверку должен подтвердить другой/i.test(message)) {
    return 'Публикация остановлена: семейство или компонент должен проверить другой сотрудник с правом публикации.';
  }
  return message;
}

export default function CatalogPublications({ workspace, onChanged }: { workspace: CatalogWorkspace; onChanged: () => Promise<void> }) {
  const user = useStore((state) => state.user);
  const canManagePolicy = user?.role === 'OWNER' || user?.role === 'ADMIN';
  const [selected, setSelected] = useState<string[]>([]);
  const [expanded, setExpanded] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [plan, setPlan] = useState<Awaited<ReturnType<typeof catalogService.importCatalog>> | null>(null);
  const [result, setResult] = useState('');
  const requireSecondReview = workspace.policy?.requireSecondReview === true;
  const keyOf = (d: CatalogDraft) => `${d.entity}:${d.id}`;
  const chosen = useMemo(() => workspace.drafts.filter((draft) => selected.includes(keyOf(draft))), [workspace.drafts, selected]);
  const reviewBlocked = chosen.some((draft) => draftNeedsSecondReview(draft, requireSecondReview));

  const run = async (fn: () => Promise<unknown>, explainPublishFailure = false) => {
    setBusy(true); setError(''); setResult('');
    try { await fn(); await onChanged(); }
    catch (e: any) { setError(explainPublishFailure ? friendlyPublishError(e?.message || 'Не удалось опубликовать пакет') : e?.message || 'Действие не выполнено'); }
    finally { setBusy(false); }
  };
  const publish = () => run(async () => {
    const r = await catalogWorkspaceService.publish(chosen);
    setResult(`Публикация ${r.publication}: ${r.count} записей. Данные доступны сотрудникам.`);
    setSelected([]);
  }, true);

  const toggleExpanded = (key: string) => setExpanded((current) =>
    current.includes(key) ? current.filter((entry) => entry !== key) : [...current, key]);

  const changesFor = (draft: CatalogDraft) => catalogDifferences(draft.before, draft.document);

  return <div className="h-full min-h-0 flex flex-col gap-3 overflow-auto p-2">
    <div className="flex flex-wrap items-center gap-2">
      <h2 className="font-semibold text-slate-800 dark:text-slate-100">Проверка и публикация</h2>
      <span className="flex-1" />
      {canManagePolicy && <label className="flex max-w-xl items-start gap-2 text-xs text-slate-700 dark:text-slate-300">
        <input type="checkbox" className="mt-0.5 accent-emerald-600 dark:accent-emerald-400"
          checked={requireSecondReview} disabled={busy}
          onChange={(event) => void run(() => catalogWorkspaceService.setPolicy(event.target.checked))} />
        <span><span className="block font-medium">Требовать вторую проверку семейства или компонента</span>
          <span className="mt-0.5 block text-slate-500 dark:text-slate-400">Для каждой модели второй сотрудник с правом публикации подтверждает содержимое. Автор не может подтвердить собственную правку.</span></span>
      </label>}
      {workspace.rights.import && <Btn disabled={busy} onClick={() => void run(async () => setPlan(await catalogService.importCatalog(veza2026Pack, 'plan')))}>Данные из PDF ВЕЗА: предпросмотр</Btn>}
      {workspace.rights.publish && <Btn tone="primary" disabled={busy || chosen.length === 0 || reviewBlocked} onClick={publish}>Опубликовать выбранное</Btn>}
    </div>
    <p className="text-xs text-slate-500 dark:text-slate-400">Черновики не меняют подбор и проекты. Проверяйте источники и состав пакета: новая модель публикуется вместе с её видом и изготовителем. Выпущенные документы сохраняют прежние снимки.</p>
    {reviewBlocked && <p role="status" className="text-xs text-amber-700 dark:text-amber-300">Для выбранного семейства или компонента нужно подтверждение другого сотрудника с правом публикации.</p>}
    {error && <p role="alert" className="text-sm text-rose-600 dark:text-rose-400">{error}</p>}
    {result && <p role="status" className="text-sm text-slate-700 dark:text-slate-300">{result}</p>}
    {plan && <section className="space-y-2 rounded-lg border border-slate-200 p-3 dark:border-slate-700">
      <h3 className="font-medium text-slate-800 dark:text-slate-100">Предпросмотр каталога ВЕЗА</h3>
      <p className="text-xs text-slate-500 dark:text-slate-400">Независимые маркировки ОСА 300/301 и источники воздушных клапанов. Числовые таблицы и графики, требующие сверки, помечены в карточках. Исходные PDF загружаются в карточку отдельно.</p>
      <ul className="max-h-52 overflow-auto text-sm">{plan.plan.map((r) => <li key={`${r.entity}:${r.id}`} className="flex flex-wrap gap-3 border-b border-slate-100 py-1 dark:border-slate-800"><span className="min-w-0 flex-1 break-all font-mono">{r.code}</span><span>{r.action === 'new' ? 'Новое' : r.action === 'update' ? 'Изменится' : 'Без изменений'}</span></li>)}</ul>
      <div className="flex flex-wrap gap-2"><Btn tone="primary" disabled={busy || !plan.plan.some((r) => r.action !== 'same')} onClick={() => void run(async () => { await catalogService.importCatalog({ ...veza2026Pack, preview: plan.preview }, 'apply'); setPlan(null); setResult('Пакет сохранён в черновиках. Проверьте его и опубликуйте.'); })}>Сохранить черновики</Btn><Btn disabled={busy} onClick={() => setPlan(null)}>Закрыть</Btn></div>
    </section>}
    {!workspace.drafts.length ? <Empty title="Нет неопубликованных изменений" text="Создайте модель, измените характеристики или загрузите проверенный пакет. Сотрудники продолжают работать с опубликованным каталогом." /> : <>
      <label className="flex items-center gap-2 text-sm text-slate-700 dark:text-slate-300"><input type="checkbox" disabled={busy} checked={workspace.drafts.length > 0 && workspace.drafts.every((d) => selected.includes(keyOf(d)))} onChange={(e) => setSelected(e.target.checked ? workspace.drafts.map(keyOf) : [])} />Выбрать весь пакет</label>
      <div className="max-w-full overflow-auto rounded-lg border border-slate-200 dark:border-slate-700">
        <table className="w-full min-w-[820px] text-left text-sm">
          <thead className="text-xs text-slate-500 dark:text-slate-400"><tr><th className="p-2">Выбор</th><th className="p-2">Запись</th><th className="p-2">Изменение</th><th className="p-2">Проверка</th><th className="p-2">Действия</th></tr></thead>
          <tbody>{workspace.drafts.map((draft) => {
            const key = keyOf(draft);
            const isExpanded = expanded.includes(key);
            const differences = isExpanded && draft.operation !== 'archive' && draft.before ? changesFor(draft) : [];
            const needsReview = draftNeedsSecondReview(draft, requireSecondReview);
            const isReviewer = !!draft.reviewedById && draft.reviewedById !== draft.authorId;
            return <React.Fragment key={key}>
              <tr className="border-t border-slate-200 align-top dark:border-slate-700">
                <td className="p-2"><input type="checkbox" disabled={busy} aria-label={`Выбрать ${draft.document.code || draft.document.name || draft.id}`} checked={selected.includes(key)} onChange={(e) => setSelected(e.target.checked ? [...selected, key] : selected.filter((k) => k !== key))} /></td>
                <td className="max-w-80 break-words p-2">{draft.document.code || draft.document.name || draft.id}<div className="text-xs text-slate-500 dark:text-slate-400">{{ family: 'Семейство оборудования', component: 'Компонент', class: 'Вид оборудования', manufacturer: 'Изготовитель', tagRule: 'Правило тега' }[draft.entity]}</div></td>
                <td className="p-2">{draft.operation === 'archive' ? 'В архив' : draft.before ? 'Изменение' : 'Новая запись'}
                  <button type="button" onClick={() => toggleExpanded(key)} aria-expanded={isExpanded}
                    className="mt-1 block rounded px-1 py-0.5 text-xs text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800">
                    {isExpanded ? 'Скрыть изменения' : 'Показать изменения'}{isExpanded && differences.length ? ` · ${differences.length}${differences.length >= 200 ? '+' : ''}` : ''}
                  </button>
                </td>
                <td className="p-2">
                  {draft.state === 'review' ? 'На проверке' : 'Черновик'}
                  {draft.reviewedById && <div className="mt-1 max-w-44 break-all text-xs text-slate-500 dark:text-slate-400">Проверил: {draft.reviewedById === user?.id ? 'вы' : draft.reviewedById}</div>}
                  {needsReview && <div className="mt-1 text-xs text-amber-700 dark:text-amber-300">Нужен другой проверяющий</div>}
                </td>
                <td className="p-2"><div className="flex flex-wrap gap-2">
                  {workspace.rights.edit && <>
                    {draft.state !== 'review' && <Btn disabled={busy} onClick={() => void run(() => catalogWorkspaceService.review(draft))}>На проверку</Btn>}
                    <Btn disabled={busy} onClick={() => void run(() => catalogWorkspaceService.discard(draft))}>Отменить правку</Btn>
                  </>}
                  {requireSecondReview && ['family', 'component'].includes(draft.entity) && draft.state === 'review' && workspace.rights.publish && <Btn disabled={busy || draft.authorId === user?.id} onClick={() => void run(() => catalogWorkspaceService.approve(draft))}>Подтвердить проверку</Btn>}
                </div></td>
              </tr>
              {isExpanded && <tr className="border-t border-slate-100 bg-slate-50 dark:border-slate-800 dark:bg-slate-900/60"><td colSpan={5} className="p-3">
                {draft.operation === 'archive' ? <p className="text-sm text-slate-700 dark:text-slate-300">Запись будет перемещена в архив. Опубликованные данные останутся доступны до подтверждения пакета.</p>
                  : !draft.before ? <div><div className="mb-2 text-xs font-medium text-slate-600 dark:text-slate-300">Содержимое новой записи</div><pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-md bg-white p-3 text-xs text-slate-700 dark:bg-slate-950 dark:text-slate-300">{JSON.stringify(draft.document, null, 2)}</pre></div>
                    : differences.length ? <div className="overflow-x-auto"><table className="w-full min-w-[640px] text-left text-xs"><thead className="text-slate-500 dark:text-slate-400"><tr><th className="w-1/5 px-2 py-1.5 font-medium">Поле</th><th className="w-2/5 px-2 py-1.5 font-medium">Было</th><th className="w-2/5 px-2 py-1.5 font-medium">Станет</th></tr></thead><tbody>{differences.map((difference, index) => <tr key={`${difference.path}:${index}`} className="border-t border-slate-200 align-top dark:border-slate-700"><th className="break-words px-2 py-2 font-medium text-slate-700 dark:text-slate-300">{humanField(difference.path)}</th><td className="whitespace-pre-wrap break-words px-2 py-2 text-slate-600 dark:text-slate-400">{difference.before}</td><td className="whitespace-pre-wrap break-words px-2 py-2 text-slate-800 dark:text-slate-100">{difference.after}</td></tr>)}</tbody></table>{differences.length >= 200 && <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">Показаны первые 200 изменений.</p>}</div>
                      : <p className="text-sm text-slate-500 dark:text-slate-400">Предметных изменений нет.</p>}
              </td></tr>}
            </React.Fragment>;
          })}</tbody>
        </table>
      </div>
    </>}
  </div>;
}
