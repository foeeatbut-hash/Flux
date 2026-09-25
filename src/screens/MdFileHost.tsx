/**
 * Файл Markdown из Проводника — в том же редакторе, что и заметки Блокнота.
 *
 * Раньше .md открывался предпросмотром или прежним Документом, который
 * переводил его в свой формат. Теперь правится сам файл: текст читается как
 * есть и пишется целиком через общее ядро записи Flux Office
 * (PUT /api/office/files/:id/content) — со сверкой версии и откатом, как
 * у Документа и Таблицы. Файл поменял кто-то другой — запись не идёт.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import NoteEditorHost from './NoteEditorHost';
import { useWindowTitle } from '../lib/paneTitle';
import { rememberDoc } from '../store/recentStore';
import { Empty } from '../components/ui';

export default function MdFileHost() {
  const [params] = useSearchParams();
  const fileId = params.get('file') || '';
  const [name, setName] = useState('');
  const [failure, setFailure] = useState('');
  const sha = useRef('');

  useWindowTitle(name);

  useEffect(() => {
    let cancelled = false;
    setFailure('');
    fetch(`/api/office/files/${encodeURIComponent(fileId)}/meta`)
      .then(async (r) => { const d = await r.json().catch(() => ({})); if (!r.ok) throw new Error(d?.error || `сервер ответил ${r.status}`); return d; })
      .then((d) => { if (!cancelled) { setName(String(d.name || '')); sha.current = String(d.sha256 || ''); } })
      .catch((e) => { if (!cancelled) setFailure(String(e.message || e)); });
    return () => { cancelled = true; };
  }, [fileId]);

  useEffect(() => {
    if (fileId && name) rememberDoc({ href: `/notes?file=${fileId}`, title: name, kind: 'note', at: Date.now() });
  }, [fileId, name]);

  const load = useCallback(async () => {
    const r = await fetch(`/api/files/${encodeURIComponent(fileId)}/raw`);
    if (!r.ok) throw new Error(`Файл не прочитан: ${r.status}`);
    return new TextDecoder('utf-8').decode(await r.arrayBuffer());
  }, [fileId]);

  const save = useCallback(async (text: string) => {
    const r = await fetch(`/api/office/files/${encodeURIComponent(fileId)}/content`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/octet-stream', 'X-Base-Sha256': sha.current },
      // Пустой файл ядро записи не принимает — пустой текст пишется переводом строки
      body: new TextEncoder().encode(text || '\n'),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d?.error || `сервер ответил ${r.status}`);
    if (d?.sha256) sha.current = String(d.sha256);
  }, [fileId]);

  if (!fileId) return <Empty title="Файл не выбран" text="Откройте файл .md из Проводника." />;
  if (failure) return <Empty title="Файл не открыт" text={failure} />;
  if (!name) return null;
  return <NoteEditorHost path={`flux://file/${fileId}`} name={name.replace(/\.(md|markdown)$/i, '')} load={load} save={save} />;
}
