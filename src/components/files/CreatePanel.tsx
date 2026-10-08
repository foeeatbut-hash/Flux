import React from 'react';
import { FileSpreadsheet, FileText, FileArchive, Folder, FolderPlus } from 'lucide-react';
import ContextMenu, { type MenuItem } from '../ContextMenu';
import { useToastStore } from '../../store/toastStore';
import { windowsFilesRequest, type WindowsFileRef } from '../../lib/windowsFiles';
import {
  CREATE_KINDS, DEFAULT_NAME, createEntry, createHint, createTitle, createdMessage, isCreated, validateName,
  type BridgeRequest, type CreateKind, type CreateOutcome, type CreatePlace,
} from './createEntry';

/**
 * Панель «Создать»: одна на Проводник и рабочий стол.
 *
 * Два раздела с одним и тем же набором — в Windows и во Flux. Объект Flux до
 * публикации виден только во Flux, поэтому человек выбирает место сам, а не
 * догадывается по кнопке. Разделы собираются из одного списка `CREATE_KINDS`:
 * так наборы не могут разойтись (у рабочего стола раньше не было ZIP).
 */

const ICONS: Record<CreateKind, React.ReactNode> = {
  folder: <Folder />, doc: <FileText />, sheet: <FileSpreadsheet />, text: <FileText />, archive: <FileArchive />,
};
const SECTION_LABEL: Record<CreatePlace, string> = { windows: 'Создать Windows', flux: 'Создать в Flux' };
const SHORT_LABEL: Record<CreatePlace, string> = { windows: 'В Windows', flux: 'В Flux' };

const kindItems = (place: CreatePlace, pick: (place: CreatePlace, kind: CreateKind) => void): MenuItem[] =>
  CREATE_KINDS.map(({ kind, label }) => ({ label, icon: ICONS[kind], onClick: () => pick(place, kind) }));

/** Места, где можно создавать. В папке-черновике Flux настоящего каталога Windows нет. */
export const createPlaces = (windows: boolean): CreatePlace[] => (windows ? ['windows', 'flux'] : ['flux']);

/** Два раздела верхнего уровня: «Создать Windows ▸» и «Создать в Flux ▸» — так их видно на столе. */
export function createSections(pick: (place: CreatePlace, kind: CreateKind) => void, windows = true): MenuItem[] {
  return createPlaces(windows).map((place) => ({ label: SECTION_LABEL[place], icon: <FolderPlus />, items: kindItems(place, pick) }));
}

/**
 * Один пункт «Создать ▸» с теми же двумя разделами внутри — так он стоит в меню
 * Проводника, где пунктов и без того много. `open` раскрывает его сразу
 * (для Ctrl+Shift+N): на первом разделе, на пункте «Папку».
 */
export function createMenuItem(pick: (place: CreatePlace, kind: CreateKind) => void, windows = true, open = false): MenuItem {
  const places = createPlaces(windows);
  return {
    label: 'Создать', icon: <FolderPlus />, defaultOpen: open,
    items: places.map((place, index) => ({ label: SHORT_LABEL[place], icon: <FolderPlus />, defaultOpen: open && index === 0, items: kindItems(place, pick) })),
  };
}

type Creating = { place: CreatePlace; kind: CreateKind; parent: WindowsFileRef };

/**
 * Состояние панели: какой объект создаётся и под каким именем, само создание и
 * разметка (окно имени, меню по сочетанию клавиш). Экран отдаёт папку-родителя и
 * решает, что делать после — обновить список, открыть файл, выделить новое.
 */
export function useCreatePanel({ parent, windows = true, where, onCreated, inline = false, request = windowsFilesRequest }: {
  /** Папка, в которой создаём; null — пока папка не открыта */
  parent: WindowsFileRef | null;
  /** Есть ли у родителя настоящая папка Windows (у папки-черновика нет) */
  windows?: boolean;
  /** В Проводнике имя вводят в строке папки; рабочий стол сохраняет своё окно. */
  inline?: boolean;
  /** Как назвать место в сообщении об удаче: «на рабочем столе Windows», «в Windows» */
  where?: string;
  /** Вызывается после создания и после неудачной публикации (draftKept) — когда список надо перечитать */
  onCreated: (outcome: CreateOutcome) => void | Promise<void>;
  request?: BridgeRequest;
}) {
  const addToast = useToastStore((state) => state.addToast);
  const [creating, setCreating] = React.useState<Creating | null>(null);
  const [name, setName] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [keyMenu, setKeyMenu] = React.useState<{ x: number; y: number } | null>(null);
  const nameRef = React.useRef<HTMLInputElement>(null);

  const pick = React.useCallback((place: CreatePlace, kind: CreateKind) => {
    if (!parent) return;
    setKeyMenu(null);
    setName(DEFAULT_NAME[kind]);
    setCreating({ place, kind, parent: { ...parent } });
  }, [parent]);
  React.useEffect(() => { if (creating) { nameRef.current?.focus(); const end = name.lastIndexOf('.'); nameRef.current?.setSelectionRange(0, end > 0 ? end : name.length); } }, [creating]);

  React.useEffect(() => { setCreating(null); setKeyMenu(null); }, [parent?.rootId, parent?.relativePath, parent?.draftId]);
  const submit = async () => {
    if (!parent || !creating || busy) return;
    const problem = validateName(name);
    if (problem) { addToast(problem, 'error'); return; }
    setBusy(true);
    try {
      const outcome = await createEntry(request, { ...creating, parent: creating.parent, name });
      if (isCreated(outcome)) {
        setCreating(null);
        addToast(createdMessage(outcome, where), 'success');
        await onCreated(outcome);
      } else {
        addToast(outcome.message, 'error');
        // Черновик уже есть, не вышла только публикация: окно закрываем, чтобы повтор не делал дубль
        if (outcome.draftKept) { setCreating(null); await onCreated(outcome); }
      }
    } finally { setBusy(false); }
  };

  const element = <>
    {creating && !inline && <NameDialog place={creating.place} kind={creating.kind} name={name} setName={setName} inputRef={nameRef} busy={busy} onSubmit={() => void submit()} onCancel={() => setCreating(null)} />}
    {keyMenu && <ContextMenu x={keyMenu.x} y={keyMenu.y} onClose={() => setKeyMenu(null)} items={[createMenuItem(pick, windows, true)]} />}
  </>;

  return {
    pick, element, busy,
    nameElement: inline && creating ? <div className="flex h-9 shrink-0 items-center gap-3 px-4 text-xs" role="group" aria-label={createTitle(creating.place, creating.kind)}>
      <FolderPlus size={20} /><input ref={nameRef} aria-label="Имя" value={name} disabled={busy} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Enter') void submit(); if (e.key === 'Escape') setCreating(null); }} className="h-7 w-72 border border-[#0067c0] bg-white px-1 text-[#1b1b1b] outline-none dark:border-[#4cc2ff] dark:bg-[#383838] dark:text-white" />
      <button type="button" disabled={busy} onClick={() => void submit()}>Создать</button><button type="button" disabled={busy} onClick={() => setCreating(null)}>Отмена</button>
    </div> : null,
    /** Окно имени или меню по клавише открыты: список позади не должен ловить клавиши */
    open: !!creating || !!keyMenu,
    sections: () => createSections(pick, windows),
    menuItem: () => createMenuItem(pick, windows),
    /** Ctrl+Shift+N: та же панель, раскрытая на пункте «Папку» */
    openByKey: (x: number, y: number) => { if (parent) setKeyMenu({ x, y }); },
  };
}

function NameDialog({ place, kind, name, setName, inputRef, busy, onSubmit, onCancel }: {
  place: CreatePlace; kind: CreateKind; name: string; setName: (value: string) => void;
  inputRef: React.RefObject<HTMLInputElement | null>; busy: boolean; onSubmit: () => void; onCancel: () => void;
}) {
  return <div className="fixed inset-0 z-[100] grid place-items-center bg-black/40 p-4" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onCancel(); }}>
    <div role="dialog" aria-modal="true" aria-labelledby="windows-create-title" className="w-full max-w-sm rounded-xl border border-slate-200 bg-white p-5 shadow-md dark:border-dark-border dark:bg-dark-surface">
      <h2 id="windows-create-title" className="text-lg font-semibold">{createTitle(place, kind)}</h2>
      <p className="mt-2 text-sm text-slate-600 dark:text-slate-300">{createHint(place)}</p>
      <label className="mt-4 block text-sm">Имя<input ref={inputRef} value={name} onChange={(event) => setName(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') onSubmit(); if (event.key === 'Escape') onCancel(); }} className="mt-1 w-full rounded-md border border-slate-300 bg-white px-3 py-2 dark:border-dark-border dark:bg-dark-bg" /></label>
      <div className="mt-4 flex justify-end gap-2">
        <button type="button" onClick={onCancel} className="rounded-md border border-slate-300 px-3 py-2 text-sm dark:border-dark-border">Отмена</button>
        <button type="button" onClick={onSubmit} disabled={busy} className="rounded-md bg-slate-700 px-3 py-2 text-sm text-white hover:bg-slate-600">Создать</button>
      </div>
    </div>
  </div>;
}
