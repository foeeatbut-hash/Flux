import React from 'react';
import { Files } from 'lucide-react';
import { badgeLabel } from '../../lib/taskbar';
import { BAR_BTN, BAR_ICON } from '../../lib/metrics';
import { useDraftsPanelStore } from '../../store/draftsPanelStore';

export default function DraftsButton({ displayId }: { displayId?: number }) {
  const id = displayId ?? 0;
  const open = useDraftsPanelStore((s) => s.displayId === id);
  const entries = useDraftsPanelStore((s) => s.entries);
  const toggle = useDraftsPanelStore((s) => s.toggle);
  const count = entries.filter((entry) => !entry.metadata?.projectIds?.length).length;
  return <button type="button" data-drafts-button={id} aria-label="Черновики" aria-expanded={open} title="Черновики"
    onClick={(event) => toggle(id, event.currentTarget.getBoundingClientRect())}
    style={{ width: BAR_BTN, height: BAR_BTN }}
    className="relative flex shrink-0 items-center justify-center rounded-lg text-slate-700 hover:bg-slate-200/60 dark:text-slate-100 dark:hover:bg-slate-800">
    <Files size={BAR_ICON} />
    {count > 0 && <span className="absolute right-0 top-0 rounded-full bg-slate-600 px-1 text-xs leading-4 text-white dark:bg-slate-600 dark:text-white">{badgeLabel(count)}</span>}
    {open && <span className="absolute bottom-0 h-0.5 w-4 rounded bg-slate-600 dark:bg-slate-400" />}
  </button>;
}
