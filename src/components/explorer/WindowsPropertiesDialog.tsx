import React from 'react';
import type { Project } from '../../services/dataService';
import type { WindowsFileEntry, WindowsFileMetadata } from '../../lib/windowsFiles';
import { Btn, Dialog, Field, Input } from '../ui';
type ProjectTag = { id: string; identifier: string; name?: string };
const fileSize = (size: number) => size < 1024 ? `${size} Б` : size < 1048576 ? `${(size / 1024).toFixed(0)} КБ` : `${(size / 1048576).toFixed(1)} МБ`;
const dateLabel = (value: string) => new Date(value).toLocaleDateString('ru-RU');
export default function PropertiesDialog({ entry, rootId, metadata, projects, tags, activeProjectId, draftTags, setDraftTags, draftProjects, setDraftProjects, revision, setRevision, responsible, setResponsible, tagQuery, setTagQuery, busy, onClose, onSave }: {
  entry: WindowsFileEntry; rootId: string; metadata: WindowsFileMetadata | null; projects: Project[]; tags: ProjectTag[]; activeProjectId: string;
  draftTags: string[]; setDraftTags: (tags: string[]) => void; draftProjects: string[]; setDraftProjects: (projects: string[]) => void;
  revision: string; setRevision: (value: string) => void; responsible: string; setResponsible: (value: string) => void;
  tagQuery: string; setTagQuery: (value: string) => void; busy: boolean; onClose: () => void; onSave: () => void;
}) {
  const allTags = [...new Map([...tags.map((item) => [item.identifier, item.identifier] as const), ...draftTags.map((item) => [item, item] as const)]).values()];
  return <Dialog title={`Свойства · ${entry.name}`} onClose={onClose} width="max-w-2xl" footer={<><Btn onClick={onClose}>Закрыть</Btn><Btn tone="primary" onClick={onSave} disabled={busy}>Сохранить свойства</Btn></>}>
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-3">
      <ReadOnly label="Тип" value={entry.kind === 'directory' ? 'Папка' : entry.name.split('.').pop()?.toUpperCase() || 'Файл'} />
      <ReadOnly label="Размер" value={entry.kind === 'directory' ? '—' : fileSize(entry.size)} />
      <ReadOnly label="Изменён" value={dateLabel(entry.modifiedAt)} />
      <ReadOnly label="Создан" value={entry.createdAt ? dateLabel(entry.createdAt) : '—'} />
      <ReadOnly label="Автор" value={entry.author || '—'} />
      <ReadOnly label="Хранение" value={entry.storage === 'flux' ? 'Только в Flux' : 'Windows'} />
      <Field label="Ревизия"><Input value={revision} onChange={(e) => setRevision(e.target.value)} placeholder="Например, 2" /></Field>
      <Field label="Ответственный"><Input value={responsible} onChange={(e) => setResponsible(e.target.value)} placeholder="Фамилия Имя" /></Field>
      <Field label="Проекты" className="sm:col-span-2"><div className="max-h-28 overflow-auto flex flex-wrap gap-x-3 gap-y-1">{projects.map((project) => <label key={project.id} className="flex items-center gap-1.5 text-xs"><input type="checkbox" checked={draftProjects.includes(project.id)} onChange={(e) => setDraftProjects(e.target.checked ? [...new Set([...draftProjects, project.id])] : draftProjects.filter((id) => id !== project.id))} />{project.name}{project.id === activeProjectId ? ' · текущий' : ''}</label>)}</div>{!projects.length && <span className="text-xs text-slate-500 dark:text-slate-400">Проекты недоступны.</span>}</Field>
      <Field label="Теги" className="sm:col-span-2"><Input value={tagQuery} onChange={(e) => setTagQuery(e.target.value)} placeholder="Найти тег текущего проекта" />
        <div className="max-h-32 overflow-auto flex flex-wrap gap-x-3 gap-y-1">{allTags.filter((tag) => tag.toLocaleLowerCase('ru').includes(tagQuery.trim().toLocaleLowerCase('ru'))).slice(0, 100).map((tag) => <label key={tag} className="flex items-center gap-1.5 text-xs"><input type="checkbox" checked={draftTags.includes(tag)} onChange={(e) => setDraftTags(e.target.checked ? [...new Set([...draftTags, tag])] : draftTags.filter((value) => value !== tag))} />{tag}</label>)}</div>
        {activeProjectId ? <span className="text-xs text-slate-500 dark:text-slate-400">Теги берутся из текущего проекта; связь хранится только в свойствах файла.</span> : <span className="text-xs text-slate-500 dark:text-slate-400">Выберите проект, чтобы показать его теги.</span>}
      </Field>
    </div>
    {metadata?.history?.length ? <details className="mt-3"><summary className="cursor-pointer text-xs text-slate-500 dark:text-slate-400">История файла · {metadata.history.length}</summary><div className="max-h-24 overflow-auto mt-1 text-xs text-slate-500 dark:text-slate-400">{metadata.history.slice(-8).reverse().map((item, index) => <div key={`${item.at}:${index}`}>{dateLabel(item.at)} · {item.action} · {item.relativePath}</div>)}</div></details> : null}
  </Dialog>;
}

function ReadOnly({ label, value }: { label: string; value: string }) { return <div className="fx-field"><span className="fx-label">{label}</span><span className="text-xs">{value}</span></div>; }
