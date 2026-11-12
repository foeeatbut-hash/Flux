/**
 * Дерево файлов и папок проекта: создать, переименовать, переместить перетаскиванием, удалить (с подтверждением),
 * загрузить файлы и папку. Дерево — это сама папка на диске; изменения снаружи приходят сверху (список обновляется).
 */
import React, { useRef, useState } from 'react';
import { ChevronDown, ChevronRight, File as FileIcon, FilePlus, Folder, FolderPlus, Upload } from 'lucide-react';
import { call } from '../call';
import Modal from './Modal';

export interface Entry { path: string; dir: boolean; size: number; ignored: boolean; text?: boolean }

const parentOf = (p: string) => p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '';
const baseOf = (p: string) => p.slice(p.lastIndexOf('/') + 1);

type Prompt = { kind: 'file' | 'folder' | 'rename'; base: string; value: string } | null;

function toBase64(bytes: ArrayBuffer): string {
  let text = '';
  const view = new Uint8Array(bytes);
  for (let i = 0; i < view.length; i += 0x8000) text += String.fromCharCode(...view.subarray(i, i + 0x8000));
  return btoa(text);
}

export default function FileTree({ id, entries, active, problems, onOpen, onChanged, onRenamed, onDeleted, onError }: {
  id: string; entries: Entry[]; active: string; problems: Set<string>;
  onOpen: (path: string) => void; onChanged: () => void; onRenamed: (from: string, to: string) => void; onDeleted: (path: string) => void; onError: (text: string) => void;
}) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState('');
  const [prompt, setPrompt] = useState<Prompt>(null);
  const [removing, setRemoving] = useState<string>('');
  const [dropOn, setDropOn] = useState('');
  const upload = useRef<HTMLInputElement>(null);
  const uploadDir = useRef<HTMLInputElement>(null);

  const selectedEntry = entries.find(e => e.path === selected);
  // Куда класть новое: в выбранную папку, у файла — рядом с ним
  const targetDir = selectedEntry ? (selectedEntry.dir ? selectedEntry.path : parentOf(selectedEntry.path)) : '';
  const run = async (fn: () => Promise<unknown>) => { try { await fn(); onChanged(); } catch (e) { onError((e as Error).message); } };

  const submit = async () => {
    if (!prompt || !prompt.value.trim()) return;
    const name = prompt.value.trim().replace(/^\/+|\/+$/g, '');
    const full = prompt.kind === 'rename' ? `${parentOf(prompt.base)}${parentOf(prompt.base) ? '/' : ''}${name}` : `${prompt.base}${prompt.base ? '/' : ''}${name}`;
    setPrompt(null);
    await run(async () => {
      if (prompt.kind === 'folder') await call('fileMkdir', { id, path: full });
      else if (prompt.kind === 'file') { await call('draftSave', { id, path: full, text: '' }); onOpen(full); }
      else { await call('fileRename', { id, from: prompt.base, to: full }); onRenamed(prompt.base, full); }
    });
  };
  const move = async (from: string, intoDir: string) => {
    const to = `${intoDir}${intoDir ? '/' : ''}${baseOf(from)}`;
    if (to === from || intoDir === from || intoDir.startsWith(`${from}/`)) return;
    await run(async () => { await call('fileRename', { id, from, to }); onRenamed(from, to); });
  };
  const files = async (list: FileList | null, keepPaths: boolean) => {
    if (!list || !list.length) return;
    await run(async () => {
      const batch: Array<{ dir: string; name: string; data: string }> = [];
      for (const f of Array.from(list).slice(0, 200)) {
        if (f.size > 32 * 1024 * 1024) throw new Error(`Файл «${f.name}» больше 32 МиБ.`);
        const rel = keepPaths && (f as any).webkitRelativePath ? parentOf((f as any).webkitRelativePath.split('/').slice(1).join('/')) : '';
        batch.push({ dir: [targetDir, rel].filter(Boolean).join('/'), name: f.name, data: toBase64(await f.arrayBuffer()) });
      }
      // По одному вызову на файл: у каждого свой каталог, а ответ об ошибке называет нужный файл
      for (const b of batch) await call('fileImport', { id, dir: b.dir, files: [{ name: b.name, data: b.data }] });
    });
  };

  // Скачать файл: текст берётся у главного процесса и отдаётся браузерным сохранением окна
  const download = async (path: string) => {
    try {
      const f = await call<{ text: string | null }>('draftFile', { id, path });
      if (f.text === null) { onError('Этот файл не текстовый: скачайте проект архивом.'); return; }
      const url = URL.createObjectURL(new Blob([f.text], { type: 'text/plain;charset=utf-8' }));
      const a = document.createElement('a'); a.href = url; a.download = baseOf(path); a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) { onError((e as Error).message); }
  };
  const hiddenBy = (p: string) => [...collapsed].some(c => p.startsWith(`${c}/`));
  return (
    <div className="studio-tree" aria-label="Файлы проекта" role="tree">
      <div className="studio-tree-tools" role="toolbar" aria-label="Действия с файлами">
        <button type="button" className="fx-ibtn" aria-label="Новый файл" title="Новый файл" onClick={() => setPrompt({ kind: 'file', base: targetDir, value: '' })}><FilePlus /></button>
        <button type="button" className="fx-ibtn" aria-label="Новая папка" title="Новая папка" onClick={() => setPrompt({ kind: 'folder', base: targetDir, value: '' })}><FolderPlus /></button>
        <button type="button" className="fx-ibtn" aria-label="Загрузить файлы" title="Загрузить файлы" onClick={() => upload.current?.click()}><Upload /></button>
        <button type="button" className="fx-btn fx-btn-quiet" onClick={() => uploadDir.current?.click()}>Папку…</button>
        <input ref={upload} type="file" multiple hidden aria-label="Выбор файлов для загрузки" onChange={e => { void files(e.target.files, false); e.target.value = ''; }} />
        <input ref={uploadDir} type="file" hidden aria-label="Выбор папки для загрузки" {...({ webkitdirectory: '', directory: '' } as object)} onChange={e => { void files(e.target.files, true); e.target.value = ''; }} />
      </div>
      <div className="studio-tree-list"
        onDragOver={e => { e.preventDefault(); }} onDrop={e => { e.preventDefault(); const from = e.dataTransfer.getData('text/x-studio-path'); if (from) void move(from, ''); else void files(e.dataTransfer.files, false); }}>
        {entries.filter(e => !hiddenBy(e.path)).map(e => {
          const depth = e.path.split('/').length - 1, isOpen = !collapsed.has(e.path);
          return (
            <div key={e.path} role="treeitem" aria-selected={selected === e.path || active === e.path} aria-expanded={e.dir ? isOpen : undefined}
              className={`studio-node${active === e.path ? ' is-active' : ''}${e.ignored ? ' is-ignored' : ''}${dropOn === e.path ? ' is-drop' : ''}${problems.has(e.path) ? ' has-problem' : ''}`}
              style={{ paddingLeft: 8 + depth * 14 }} draggable
              title={e.ignored ? `${e.path} — в пакет не попадает` : e.path}
              onDragStart={ev => ev.dataTransfer.setData('text/x-studio-path', e.path)}
              onDragOver={ev => { if (e.dir) { ev.preventDefault(); ev.stopPropagation(); setDropOn(e.path); } }}
              onDragLeave={() => setDropOn('')}
              onDrop={ev => { if (!e.dir) return; ev.preventDefault(); ev.stopPropagation(); setDropOn(''); const from = ev.dataTransfer.getData('text/x-studio-path'); if (from) void move(from, e.path); else void files(ev.dataTransfer.files, false); }}
              onClick={() => { setSelected(e.path); if (e.dir) setCollapsed(c => { const n = new Set(c); if (n.has(e.path)) n.delete(e.path); else n.add(e.path); return n; }); else onOpen(e.path); }}>
              {e.dir ? (isOpen ? <ChevronDown /> : <ChevronRight /> ) : <span className="studio-node-gap" />}
              {e.dir ? <Folder /> : <FileIcon />}
              <span className="studio-node-name">{baseOf(e.path)}</span>
              {selected === e.path && (
                <span className="studio-node-acts">
                  {!e.dir && e.text !== false && <button type="button" className="fx-btn fx-btn-quiet" onClick={ev => { ev.stopPropagation(); void download(e.path); }}>Скачать</button>}
                  <button type="button" className="fx-btn fx-btn-quiet" onClick={ev => { ev.stopPropagation(); setPrompt({ kind: 'rename', base: e.path, value: baseOf(e.path) }); }}>Переименовать</button>
                  <button type="button" className="fx-btn fx-btn-quiet" onClick={ev => { ev.stopPropagation(); setRemoving(e.path); }}>Удалить</button>
                </span>)}
            </div>);
        })}
      </div>
      {prompt && (
        <Modal title={prompt.kind === 'file' ? 'Новый файл' : prompt.kind === 'folder' ? 'Новая папка' : 'Переименовать'} onClose={() => setPrompt(null)}>
          <form onSubmit={e => { e.preventDefault(); void submit(); }}>
            <div className="field"><label htmlFor="tree-name">{prompt.kind === 'rename' ? 'Новое имя' : `Имя${prompt.base ? ` (в «${prompt.base}»)` : ''}`}</label>
              <input id="tree-name" className="fx-input" value={prompt.value} maxLength={100} onChange={e => setPrompt({ ...prompt, value: e.target.value })} /></div>
            <p className="fx-hint">Имена — латиница, цифры, точка, дефис и подчёркивание: так они попадут в пакет.</p>
            <div className="row studio-modal-actions"><button type="submit" className="fx-btn fx-btn-primary" disabled={!prompt.value.trim()}>Готово</button>
              <button type="button" className="fx-btn" onClick={() => setPrompt(null)}>Отмена</button></div>
          </form>
        </Modal>)}
      {removing && (
        <Modal title="Удалить?" onClose={() => setRemoving('')}>
          <p>«{removing}» будет удалён{entries.find(e => e.path === removing)?.dir ? ' вместе со всем содержимым' : ''} с диска. Вернуть его из Studio нельзя.</p>
          <div className="row studio-modal-actions">
            <button type="button" className="fx-btn fx-btn-danger" onClick={() => { const p = removing; setRemoving(''); void run(async () => { await call('draftRemoveFile', { id, path: p }); onDeleted(p); }); }}>Удалить</button>
            <button type="button" className="fx-btn" onClick={() => setRemoving('')}>Отмена</button></div>
        </Modal>)}
    </div>
  );
}
