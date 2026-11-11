/**
 * Раздел «Редактор»: точка подключения редакторов формы и кода (studio/renderer/editors/index.tsx).
 * Оболочка читает текстовые файлы проекта, передаёт их редактору и сохраняет то, что он вернул (studio/shared/editorContract.ts).
 * Пока редакторов в сборке нет, build.cjs подставляет заглушку «раздел в работе».
 */
import React, { Suspense, useCallback, useEffect, useState } from 'react';
import { SectionHead } from '../../../src/components/ui/controls';
import type { EditorDraft } from '../../shared/editorContract';
import { call } from '../call';

const Editors = React.lazy(() => import('studio-editors'));
interface Tree { files: Array<{ path: string; size: number; text: boolean }> }

export default function Editor({ id }: { id: string }) {
  const [draft, setDraft] = useState<EditorDraft | null>(null);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      const tree = await call<Tree>('draftTree', { id });
      const files: Record<string, string> = {};
      for (const f of tree.files.filter(x => x.text)) files[f.path] = (await call<{ text: string | null }>('draftFile', { id, path: f.path })).text ?? '';
      setDraft({ files, binary: tree.files.filter(x => !x.text).map(x => x.path) });
    } catch (e) { setError((e as Error).message); }
  }, [id]);
  useEffect(() => { setDraft(null); setError(''); if (id) void load(); }, [id, load]);

  const onChange = useCallback(async (changed: Record<string, string>) => {
    try {
      for (const [path, text] of Object.entries(changed)) await call('draftSave', { id, path, text });
      await load();
      return '';
    } catch (e) { return (e as Error).message; }
  }, [id, load]);

  return (
    <section aria-label="Редактор" className="fx-page">
      <SectionHead title="Редактор" />
      <div className="fx-page-body p-4 studio-body">
      {!id && <div className="empty">Сначала откройте проект в разделе «Проект подпрограммы».</div>}
      {error && <p className="fx-error" role="alert">{error}</p>}
      {id && draft && (
        <Suspense fallback={<div className="empty">Загрузка редактора…</div>}>
          <Editors moduleId={id} draft={draft} onChange={onChange} />
        </Suspense>
      )}
      </div>
    </section>
  );
}
