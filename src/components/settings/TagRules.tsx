/**
 * Лист «Правила тегов» в Параметрах: алфавит, приставки и проверка на примере.
 *
 * Настройка проектная: в одном проекте теги пишут латиницей, в другом заказчик
 * требует кириллицу, и одно общее правило сделало бы половину проектов
 * неработающими. Меняет её тот, кому доверено вести проект.
 *
 * Здесь же — единственное место, где человеку показывают, ЧТО именно программа
 * найдёт в его тексте. Без этого правило выглядит как чёрный ящик: импорт
 * двадцати трёх файлов либо угадывает, либо нет, а почему — непонятно.
 */
import React from 'react';
import { AlertTriangle, CheckCircle2, Info } from 'lucide-react';
import { ENV_CONFIG, getAuthToken } from '../../config/env';
import { useStore } from '../../store/store';
import type { TagPolicy } from '../../../equipment/tagPolicy';
import SectionShell from './SectionShell';

const authHeaders = (): Record<string, string> => {
  const token = getAuthToken();
  return token
    ? { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
    : { 'Content-Type': 'application/json' };
};

const VERDICT_TEXT: Record<string, string> = {
  accepted: 'Тег проекта',
  review: 'Похоже на тег — подтвердите',
  invalid: 'Записать нельзя',
  reference: 'Не тег',
};

export default function TagRules({ addToast }: { addToast: (m: string, kind?: any) => void }) {
  const project = useStore((s) => s.activeProject);
  const projectId = String(project?.id || '');

  const [policy, setPolicy] = React.useState<TagPolicy | null>(null);
  const [mismatched, setMismatched] = React.useState(0);
  const [busy, setBusy] = React.useState(false);
  const [failure, setFailure] = React.useState('');
  const [sample, setSample] = React.useState('Освещение внутри блока не устанавливать. Таг-номер 3700-B01-FA-001A');
  const [found, setFound] = React.useState<any[]>([]);

  const load = React.useCallback(async () => {
    if (!projectId) return;
    try {
      const res = await fetch(`${ENV_CONFIG.apiUrl}/projects/${projectId}/tag-policy`, { headers: authHeaders() });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(String(data?.error || `сервер ответил ${res.status}`));
      setPolicy(data.policy);
      setMismatched(Number(data.mismatched) || 0);
    } catch (e: any) {
      setFailure(e?.message || 'Не удалось прочитать правила');
    }
  }, [projectId]);

  React.useEffect(() => { void load(); }, [load]);

  /** Проверка на примере ничего не пишет: это разговор, а не настройка. */
  const check = React.useCallback(async (next: TagPolicy | null, text: string) => {
    if (!projectId || !next) return;
    try {
      const res = await fetch(`${ENV_CONFIG.apiUrl}/projects/${projectId}/tag-policy/preview`, {
        method: 'POST', headers: authHeaders(), body: JSON.stringify({ policy: next, text }),
      });
      const data = await res.json().catch(() => ({}));
      setFound(Array.isArray(data?.candidates) ? data.candidates : []);
    } catch (_) { setFound([]); }
  }, [projectId]);

  React.useEffect(() => { void check(policy, sample); }, [policy, sample, check]);

  const save = async (next: TagPolicy) => {
    setBusy(true);
    setFailure('');
    try {
      const res = await fetch(`${ENV_CONFIG.apiUrl}/projects/${projectId}/tag-policy`, {
        method: 'PUT', headers: authHeaders(), body: JSON.stringify({ policy: next }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(String(data?.error || `сервер ответил ${res.status}`));
      setPolicy(data.policy);
      setMismatched(Number(data.mismatched) || 0);
      addToast('Правила тегов сохранены. Существующие теги не изменились.', 'success');
    } catch (e: any) {
      setFailure(e?.message || 'Не удалось сохранить правила');
    } finally {
      setBusy(false);
    }
  };

  if (!projectId) {
    return (
      <SectionShell title="Правила тегов" desc="Алфавит, приставки и проверка на примере">
        <p className="text-sm text-slate-500 dark:text-slate-400">
          Сначала выберите проект: правила тегов свои у каждого проекта.
        </p>
      </SectionShell>
    );
  }

  const cyr = !!policy?.allowCyrillic;

  return (
    <SectionShell title="Правила тегов" desc="Алфавит, приставки и проверка на примере">
      <button
        type="button"
        role="switch"
        aria-checked={cyr}
        disabled={busy || !policy}
        onClick={() => policy && save({ ...policy, allowCyrillic: !cyr })}
        className="fx-set-row w-full flex-row-reverse items-start text-left cursor-pointer disabled:opacity-60 disabled:cursor-default"
      >
        <span className="fx-switch shrink-0 pointer-events-none" aria-hidden="true" aria-checked={cyr} />
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-semibold text-slate-800 dark:text-slate-100">
            Разрешить кириллицу в тегах
          </span>
          <span className="block text-xs text-slate-500 dark:text-slate-400 mt-0.5 leading-relaxed text-pretty">
            По умолчанию в тегах разрешены латинские буквы, цифры и дефис. Включите, чтобы
            разрешить также кириллические буквы. Существующие теги переключатель не меняет:
            «3700-B01-001В» с кириллической «В» и «3700-B01-001B» с латинской остаются разными.
          </span>
        </span>
      </button>

      {mismatched > 0 && (
        <div className="mt-3 fx-note fx-note-warn">
          <div className="flex items-start gap-2.5">
            <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0 text-amber-600 dark:text-amber-400" />
            <p className="text-xs text-amber-700 dark:text-amber-300 leading-relaxed">
              По нынешним правилам не проходит тегов: {mismatched}. Они остаются на месте и работают —
              запрещено только заводить такие заново. Исправляют их переименованием в разделе «Теги».
            </p>
          </div>
        </div>
      )}

      {/* Приставки проекта: по ним импорт узнаёт свой тег в чужом тексте */}
      <div className="mt-4 fx-set-group">
        <h3 className="text-sm font-semibold text-slate-800 dark:text-slate-100">Приставки проекта</h3>
        <p className="mt-1 text-xs text-slate-500 dark:text-slate-400 leading-relaxed text-pretty">
          Код проекта и дополнительные приставки через запятую: «3700, 3800». По ним программа
          узнаёт тег в примечании. Приставка сверяется по границе части — «13700-B01» тегом
          проекта «3700» не считается.
        </p>
        <div className="mt-2 flex items-center gap-2 flex-wrap">
          <input
            value={(policy?.prefixes || []).join(', ')}
            onChange={(e) => policy && setPolicy({
              ...policy,
              prefixes: e.target.value.split(',').map((p) => p.trim()).filter(Boolean),
            })}
            spellCheck={false}
            placeholder="3700"
            className="flex-1 min-w-[12rem] px-2.5 py-1.5 rounded-lg text-xs
                       bg-slate-50 dark:bg-slate-900 text-slate-700 dark:text-slate-150
                       border border-slate-200 dark:border-slate-800"
          />
          <button
            type="button"
            onClick={() => policy && save(policy)}
            disabled={busy || !policy}
            className="fx-btn fx-btn-primary fx-btn-sm"
          >
            Сохранить
          </button>
        </div>
      </div>

      {/* Проверка на примере: видно, что программа найдёт до запуска импорта */}
      <div className="mt-4 fx-set-group">
        <h3 className="text-sm font-semibold text-slate-800 dark:text-slate-100">Проверить на примере</h3>
        <textarea
          value={sample}
          onChange={(e) => setSample(e.target.value)}
          rows={3}
          className="mt-2 w-full px-2.5 py-1.5 rounded-lg text-xs leading-relaxed
                     bg-slate-50 dark:bg-slate-900 text-slate-700 dark:text-slate-150
                     border border-slate-200 dark:border-slate-800"
        />
        <ul className="mt-2 space-y-1">
          {!found.length && (
            <li className="text-xs text-slate-400 dark:text-slate-500">В этом тексте тегов не нашлось.</li>
          )}
          {found.map((c, i) => (
            <li key={`${c.identifier}-${i}`} className="flex items-start gap-2 text-xs">
              {c.verdict === 'accepted' || c.verdict === 'review'
                ? <CheckCircle2 className="w-3.5 h-3.5 mt-0.5 shrink-0 text-emerald-600 dark:text-emerald-400" />
                : <Info className="w-3.5 h-3.5 mt-0.5 shrink-0 text-slate-400" />}
              <span className="min-w-0">
                <span className="font-mono font-semibold text-slate-800 dark:text-slate-100">{c.identifier}</span>
                <span className="text-slate-400 dark:text-slate-500"> — {VERDICT_TEXT[c.verdict] || c.verdict}</span>
                <span className="block text-2xs text-slate-500 dark:text-slate-400 leading-relaxed">{c.why}</span>
                {c.fix && (
                  <span className="block text-2xs text-emerald-700 dark:text-emerald-400">
                    предлагается исправление: {c.fix}
                  </span>
                )}
              </span>
            </li>
          ))}
        </ul>
      </div>

      {failure && (
        <p className="mt-3 text-xs font-semibold text-rose-600 dark:text-rose-400 leading-relaxed">{failure}</p>
      )}
    </SectionShell>
  );
}
