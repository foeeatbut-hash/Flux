import { useCallback, useEffect, useRef, useState } from 'react';
import type { OfficeAppliedTemplate, OfficeState } from './fluxData';

/**
 * Лента «Flux» редактора (tools/genoffice/inject/flux-ribbon.tsx) и окно Flux.
 *
 * Лента шлёт одно сообщение `flux:open-panel` с полем command; хост открывает
 * или переключает правую панель и передаёт ей команду. Общий для Word, Таблицы
 * и файлов Проводника, чтобы три окна не повторяли один и тот же разбор.
 * Состояние для кнопок ленты («Исходная шапка», «Выпустить») хост шлёт ей
 * событием fluxRibbonState.
 */
export const RIBBON_COMMANDS = [
  'translator', 'source-equipment', 'source-tags', 'templates', 'pinned', 'save-template',
  'update-template', 'refresh', 'issue', 'reset-header', 'export', 'project-fields', 'english',
] as const;
export type RibbonCommandName = typeof RIBBON_COMMANDS[number];
/** Команда с номером: повторное нажатие той же кнопки — новая команда. */
export interface RibbonCommand { seq: number; name: RibbonCommandName }

export const NO_TEMPLATE_HINT = 'У файла нет шаблона';

const formatDate = (iso: string) => {
  const at = new Date(iso);
  return Number.isNaN(at.getTime()) ? '' : at.toLocaleDateString('ru-RU');
};

/** Подсказка кнопки «Исходная шапка», когда шаблон у файла есть. */
export function resetHintOf(template: Pick<OfficeAppliedTemplate, 'name' | 'appliedAt'>): string {
  const date = formatDate(template.appliedAt);
  return `Вернуть шапку к шаблону${template.name ? ` «${template.name}»` : ''}${date ? ` от ${date}` : ''}`;
}

interface Options {
  /** Сообщение окну редактора (как `send` хоста). */
  send: (message: { event: string; payload?: unknown }) => void;
  /** Состояние файла без записи правок редактора; нужно, пока панель закрыта. */
  peek?: () => Promise<OfficeState>;
  /** «Выпустить» доступно: файл проекта, а не файл Проводника. */
  issueAvailable: boolean;
  issueHint?: string;
  /** «Поля проекта» и «Английская версия» нужны карточке файла в базе: у файла Проводника их нет. */
  projectFile?: boolean;
  projectFields?: boolean;
}

export function useFluxRibbon({ send, peek, issueAvailable, issueHint, projectFile = issueAvailable, projectFields = projectFile }: Options) {
  const [open, setOpen] = useState(false);
  const [command, setCommand] = useState<RibbonCommand | null>(null);
  const [template, setTemplate] = useState<OfficeAppliedTemplate | null>(null);
  const seq = useRef(0);
  const live = useRef({ send, peek }); live.current = { send, peek };

  const publish = useCallback((applied: OfficeAppliedTemplate | null, canIssue: boolean, hint?: string) => {
    live.current.send({ event: 'fluxRibbonState', payload: {
      resetAvailable: !!applied, resetHint: applied ? resetHintOf(applied) : NO_TEMPLATE_HINT,
      issueAvailable: canIssue, issueHint: canIssue ? 'Выпустить ревизию документа' : hint || 'Недоступно для этого файла',
      projectFile, projectFileHint: 'Только для файлов проекта: у файла Проводника нет карточки в базе', projectFields,
    } });
  }, [projectFile, projectFields]);
  useEffect(() => { publish(template, issueAvailable, issueHint); }, [template, issueAvailable, issueHint, publish]);

  /** Лента спросила состояние (открылась вкладка): перечитываем файл, если панель его не знает. */
  const refreshTemplate = useCallback(async () => {
    publish(template, issueAvailable, issueHint);
    if (open || !live.current.peek) return;
    try { setTemplate((await live.current.peek()).template ?? null); } catch { /* файл без схемы или ещё открывается: кнопка остаётся неактивной */ }
  }, [open, template, issueAvailable, issueHint, publish]);

  /** Сообщение редактора; true — оно было про ленту. */
  const handle = useCallback((message: { op?: string; command?: unknown }): boolean => {
    if (message.op === 'flux:ribbon-ready') { void refreshTemplate(); return true; }
    if (message.op !== 'flux:open-panel') return false;
    setOpen(true);
    const name = RIBBON_COMMANDS.find((item) => item === message.command);
    setCommand(name ? { seq: ++seq.current, name } : null);
    return true;
  }, [refreshTemplate]);

  const close = useCallback(() => { setOpen(false); setCommand(null); }, []);
  return { open, command, template, setTemplate, handle, close };
}
