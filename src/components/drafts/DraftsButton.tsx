import React from 'react';
import { Files } from 'lucide-react';
import { badgeLabel } from '../../lib/taskbar';
import { BAR_BTN, BAR_ICON } from '../../lib/metrics';
import { badgeCount } from '../../lib/draftsPanel';
import { useDraftsPanelStore } from '../../store/draftsPanelStore';
import { useDraftsSettings } from '../../store/draftsSettingsStore';

/** Пауза перед открытием наведением: проезд курсора к соседней кнопке не должен открывать панель. */
const HOVER_OPEN_MS = 350;
const NO_OPEN: ReadonlySet<string> = new Set();

export default function DraftsButton({ displayId }: { displayId?: number }) {
  const id = displayId ?? 0;
  const open = useDraftsPanelStore((s) => s.displayId === id);
  const entries = useDraftsPanelStore((s) => s.entries);
  const toggle = useDraftsPanelStore((s) => s.toggle);
  const badge = useDraftsSettings((s) => s.badge);
  const openOn = useDraftsSettings((s) => s.openOn);
  // «Не в проекте» — по проекту, а не по тому, открыт ли файл в окне: открытый черновик из проекта не станет «не в проекте».
  const count = React.useMemo(() => badgeCount(entries, badge, NO_OPEN), [entries, badge]);
  const timer = React.useRef<ReturnType<typeof setTimeout>>(undefined);
  React.useEffect(() => () => clearTimeout(timer.current), []);
  return <button type="button" data-drafts-button={id} aria-label="Черновики" aria-expanded={open} title="Черновики"
    onClick={(event) => { clearTimeout(timer.current); toggle(id, event.currentTarget.getBoundingClientRect()); }}
    onPointerEnter={(event) => {
      if (openOn !== 'hover' || open) return;
      const rect = event.currentTarget.getBoundingClientRect();
      timer.current = setTimeout(() => { if (useDraftsPanelStore.getState().displayId !== id) toggle(id, rect); }, HOVER_OPEN_MS);
    }}
    onPointerLeave={() => clearTimeout(timer.current)}
    style={{ width: BAR_BTN, height: BAR_BTN }}
    className="relative flex shrink-0 items-center justify-center rounded-lg text-slate-700 hover:bg-slate-200/60 dark:text-slate-100 dark:hover:bg-slate-800">
    <Files size={BAR_ICON} />
    {count > 0 && <span className="absolute right-0 top-0 rounded-full bg-slate-600 px-1 text-xs leading-4 text-white dark:bg-slate-600 dark:text-white">{badgeLabel(count)}</span>}
    {open && <span className="absolute bottom-0 h-0.5 w-4 rounded bg-slate-600 dark:bg-slate-400" />}
  </button>;
}
