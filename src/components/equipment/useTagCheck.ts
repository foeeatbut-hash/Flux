import { useEffect, useState } from 'react';

/**
 * Проверка тега на лету — тем же правилом, по которому он запишется.
 *
 * Ответ сервера (`/api/projects/:id/tag-check`) ничего не пишет, но знает всё,
 * что знает запись: код проекта, правила тегов, похожие буквы и занятость.
 * Поэтому окно может честно сказать до нажатия: «будет записан как …»,
 * «уже есть и свободен — привяжется он», «занят другой позицией».
 */

export interface TagCheckState {
  state: 'idle' | 'checking' | 'ok' | 'bad';
  identifier: string;
  problem?: string;
  fix?: string;
  corrected?: { from: string; what: string };
  existing?: boolean;
  created?: boolean;
}

export function useTagCheck(projectId: string, text: string): TagCheckState {
  const [res, setRes] = useState<TagCheckState>({ state: 'idle', identifier: '' });
  useEffect(() => {
    const raw = text.trim();
    if (!raw || !projectId) { setRes({ state: 'idle', identifier: '' }); return; }
    setRes((r) => ({ ...r, state: 'checking' }));
    let alive = true;
    // Пауза, чтобы не спрашивать сервер на каждую букву
    const t = setTimeout(() => {
      fetch(`/api/projects/${encodeURIComponent(projectId)}/tag-check`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ identifier: raw }),
      })
        .then((r) => r.json())
        .then((d) => { if (alive) setRes({ ...d, state: d?.ok ? 'ok' : 'bad', identifier: d?.identifier || raw }); })
        .catch(() => { if (alive) setRes({ state: 'idle', identifier: raw }); });
    }, 300);
    return () => { alive = false; clearTimeout(t); };
  }, [projectId, text]);
  return res;
}

/** Одна строка ответа для человека — под полем тега */
export function tagHint(c: TagCheckState): string {
  if (c.state === 'checking') return 'Проверяю…';
  if (c.state === 'bad') return c.problem || 'Тег не проходит правила проекта';
  if (c.state !== 'ok') return '';
  const fixed = c.corrected ? `Исправлено: ${c.corrected.what} — будет записан как «${c.identifier}». ` : '';
  return fixed + (c.existing ? 'Такой тег уже есть и свободен — привяжется он.' : 'Новый тег — будет заведён в реестре.');
}

/**
 * Приставка для нового тега — от тега родителя: «3700-B01-DW-001A» → «3700-B01-».
 *
 * Два первых сегмента — код проекта и установки: у позиций одной установки
 * они общие, а дальше идут свой код оборудования и номер, их человек и
 * допишет. Родителя без тега нет — приставки нет.
 */
export function tagPrefixOf(parentTag: string): string {
  const parts = String(parentTag || '').split('-').filter(Boolean);
  return parts.length >= 3 ? `${parts.slice(0, 2).join('-')}-` : '';
}
