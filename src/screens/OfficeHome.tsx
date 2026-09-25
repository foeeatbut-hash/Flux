/**
 * Стартовое окно программы Flux Office — как начальный экран Word и Excel.
 *
 * Документ, Таблица и PDF правят файлы, а не записи в базе, поэтому окно
 * программы без файла — не пустая библиотека документов, а три вопроса,
 * с которых начинается работа: создать новый, продолжить недавний или
 * открыть файл проекта. Открытие идёт тем же адресом, что двойной щелчок в
 * Проводнике: одна дорога к файлу, одно окно на файл.
 */
import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useStore } from '../store/store';
import { useToastStore } from '../store/toastStore';
import { useRecentStore } from '../store/recentStore';
import { visibleRecentDocs, whenLabel, type DocKind } from '../lib/recentDocs';
import { isWordFile, isExcelFile, isPdf, openHref, type FileLike } from '../lib/fileTypes';
import { blankBytes, BLANK_NAME, type BlankKind } from '../lib/blankFiles';
import { saveNewFile, editorHref } from '../lib/officeFiles';
import { recentBadge } from '../lib/fileBadge';
import FileBadge from '../components/ui/FileBadge';
import { Btn, Empty, Input, SectionHead, SectionTitle } from '../components/ui';
import { countOf, type WordKey } from '../lib/plural';

export type OfficeHomeKind = 'doc' | 'sheet' | 'pdf';

const TITLE: Record<OfficeHomeKind, string> = { doc: 'Документ', sheet: 'Таблица', pdf: 'PDF' };
const SAMPLE: Record<OfficeHomeKind, string> = { doc: 'Документ.docx', sheet: 'Таблица.xlsx', pdf: 'Файл.pdf' };
const RECENT_KIND: Record<OfficeHomeKind, DocKind> = { doc: 'text', sheet: 'sheet', pdf: 'pdf' };
/** Чем программа открывает файл: то же правило, что у двойного щелчка */
const FITS: Record<OfficeHomeKind, (f: FileLike) => boolean> = { doc: isWordFile, sheet: isExcelFile, pdf: isPdf };
const WORD: Record<OfficeHomeKind, WordKey> = { doc: 'документ', sheet: 'книга', pdf: 'файл' };
const NONE: Record<OfficeHomeKind, string> = { doc: 'В проекте пока нет документов Word', sheet: 'В проекте пока нет книг Excel', pdf: 'В проекте нет PDF' };

interface ProjectFile { id: string; name: string; type?: string; folderId?: string | null; folderName: string; updatedAt: number }

export default function OfficeHome({ kind }: { kind: OfficeHomeKind }) {
  const navigate = useNavigate();
  const addToast = useToastStore((s) => s.addToast);
  const projectId = useStore((s: any) => s.activeProject?.id || null) as string | null;
  const recentAll = useRecentStore((s) => s.docs);
  const [files, setFiles] = useState<ProjectFile[] | null>(null);
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setFiles(null);
    if (!projectId) { setFiles([]); return; }
    fetch(`/api/projects/${encodeURIComponent(projectId)}/folders`)
      .then((r) => r.json())
      .then((d) => {
        if (cancelled) return;
        const out: ProjectFile[] = [];
        const take = (f: any, folderName: string) => {
          if (!f || f.deletedAt || !FITS[kind](f)) return;
          out.push({ id: f.id, name: f.name, type: f.type, folderId: f.folderId, folderName, updatedAt: Date.parse(f.updatedAt || f.createdAt || '') || 0 });
        };
        for (const folder of d?.folders || []) for (const f of folder.files || []) take(f, folder.name || '');
        for (const f of d?.rootFiles || []) take(f, '');
        out.sort((a, b) => b.updatedAt - a.updatedAt);
        setFiles(out);
      })
      .catch(() => { if (!cancelled) setFiles([]); });
    return () => { cancelled = true; };
  }, [projectId, kind]);

  const recent = useMemo(
    () => visibleRecentDocs(recentAll, projectId).filter((d) => d.kind === RECENT_KIND[kind] && d.href.includes('?file=')).slice(0, 8),
    [recentAll, projectId, kind],
  );

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = files || [];
    return (q ? list.filter((f) => f.name.toLowerCase().includes(q) || f.folderName.toLowerCase().includes(q)) : list).slice(0, 200);
  }, [files, query]);

  const create = async () => {
    if (kind === 'pdf' || busy) return;
    setBusy(true);
    try {
      const made = await saveNewFile(await blankBytes(kind as BlankKind), BLANK_NAME[kind as BlankKind], 'desk');
      navigate(editorHref(made));
    } catch (e: any) {
      addToast(`Не удалось создать файл: ${e.message}`, 'error');
    } finally { setBusy(false); }
  };

  return (
    <div className="h-full flex flex-col min-h-0">
      <SectionHead
        title={<span className="flex items-center gap-2"><FileBadge file={SAMPLE[kind]} kind={kind} size={20} />{TITLE[kind]}</span>}
        actions={kind !== 'pdf' && (
          <Btn tone="primary" onClick={create} disabled={busy}>
            {kind === 'doc' ? 'Новый документ' : 'Новая таблица'}
          </Btn>
        )}
      />
      <div className="flex-1 min-h-0 overflow-auto px-4 pb-4">
        {recent.length > 0 && (
          <section className="mb-4">
            <SectionTitle>Недавние</SectionTitle>
            {recent.map((d) => (
              <button key={d.href} type="button" onClick={() => navigate(d.href)} className="fx-li w-full text-left">
                <FileBadge file={d.title} kind={recentBadge(d)} size={18} />
                <span className="flex-1 min-w-0 truncate">{d.title}</span>
                <span className="text-xs text-slate-400 shrink-0">{whenLabel(d.at)}</span>
              </button>
            ))}
          </section>
        )}

        <section>
          <SectionTitle right={files && files.length > 8 && (
            <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Найти по имени или папке" aria-label="Найти файл" className="w-64" />
          )}>
            {files ? `В проекте · ${countOf(files.length, WORD[kind])}` : 'В проекте'}
          </SectionTitle>
          {files === null && <p className="px-3 py-6 text-sm text-slate-400">Загрузка…</p>}
          {files && !shown.length && (
            <Empty
              title={query ? 'Ничего не нашлось' : NONE[kind]}
              text={kind === 'pdf'
                ? 'Перенесите PDF на стол или в Проводник — он откроется здесь.'
                : `Создайте новый или перенесите файл ${kind === 'doc' ? 'Word' : 'Excel'} на стол — он откроется здесь и останется тем же файлом.`}
            />
          )}
          {shown.map((f) => (
            <button key={f.id} type="button" onClick={() => navigate(openHref(f))} className="fx-li w-full text-left"
              title={f.folderName ? `${f.folderName} / ${f.name}` : f.name}>
              <FileBadge file={f} size={18} />
              <span className="flex-1 min-w-0 truncate">{f.name}</span>
              {f.folderName && <span className="text-xs text-slate-400 truncate max-w-[40%] shrink-0">{f.folderName}</span>}
            </button>
          ))}
        </section>
      </div>
    </div>
  );
}
