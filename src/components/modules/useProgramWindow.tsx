/**
 * Окно программы-страницы: диалоги Flux, заголовок и «есть несохранённое» (добавлено к договору v2).
 *
 * Диалог программы и вопрос при закрытии живут здесь, в окне программы, поэтому закрытие окна убирает их без ответа.
 * Несохранённое Flux спрашивает сам через общий страж закрытия окна (`lib/closeGuard`): так крестик рамы, панель задач,
 * выход из Flux и закрытие всех окон идут одним путём. Программа закрытие не блокирует и о нём заранее не узнаёт;
 * зависшая программа («не отвечает») закрывается без вопроса — отвечать ей всё равно некому.
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { guardClose } from '../../lib/closeGuard';
import { usePaneId, useWindowTitle } from '../../lib/paneTitle';
import { useWindowStore } from '../../store/windowStore';
import type { PageDialog, PageDialogAnswer } from '../../../modules/page/model';
import ProgramDialog from './ProgramDialog';

export const CLOSE_TITLE = 'Закрыть без сохранения?';
export const CLOSE_DEFAULT_TEXT = 'В окне есть несохранённые изменения.';

export function useProgramWindow(programName: string, initialTitle: string, hung: boolean) {
  const paneId = usePaneId();
  const winId = paneId.startsWith('win:') ? paneId.slice(4) : '';
  const [custom, setCustom] = useState(initialTitle);
  // «Программа — заголовок»; без заголовка рама показывает просто название программы
  useWindowTitle(custom ? `${programName} — ${custom}` : '');
  const [asked, setAsked] = useState<{ request: PageDialog; resolve: (answer: PageDialogAnswer) => void } | null>(null);
  const [closing, setClosing] = useState<{ text: string; resolve: (allowed: boolean) => void } | null>(null);
  const unsaved = useRef({ on: false, text: '' });
  const hungRef = useRef(hung); hungRef.current = hung;
  const closeAsk = useRef<Promise<boolean> | null>(null);
  const live = useRef({ asked, closing }); live.current = { asked, closing };

  useEffect(() => guardClose(winId, () => {
    if (!unsaved.current.on || hungRef.current) return true;
    if (closeAsk.current) return closeAsk.current;
    // Окно могло быть свёрнуто или стоять на другом столе: вопрос про него, значит, показываем его
    const store = useWindowStore.getState();
    const win = store.windows.find(item => item.id === winId);
    if (win && win.desk !== store.desk) useWindowStore.setState({ desk: win.desk });
    store.focus(winId);
    const run = new Promise<boolean>(resolve => setClosing({ text: unsaved.current.text, resolve })).finally(() => { closeAsk.current = null; });
    closeAsk.current = run;
    return run;
  }), [winId]);
  // Окно ушло: открытые вопросы закрываются без ответа
  useEffect(() => () => { live.current.asked?.resolve(null); live.current.closing?.resolve(false); }, []);

  const host = useMemo(() => ({
    dialog: (request: PageDialog) => new Promise<PageDialogAnswer>(resolve => setAsked({ request, resolve })),
    setTitle: (text: string) => setCustom(text),
    setUnsaved: (on: boolean, text: string) => { unsaved.current = { on, text }; },
  }), []);

  // Вопрос о закрытии важнее вопроса программы; тот вернётся, если человек откажется закрывать
  const node = closing
    ? <ProgramDialog key="close" program={programName} cancelFirst onAnswer={answer => { setClosing(null); closing.resolve(answer === true); }}
      request={{ kind: 'confirm', title: CLOSE_TITLE, text: closing.text || CLOSE_DEFAULT_TEXT, ok: 'Закрыть', cancel: 'Отмена', danger: true }} />
    : asked ? <ProgramDialog key="ask" program={programName} request={asked.request} onAnswer={answer => { setAsked(null); asked.resolve(answer); }} /> : null;
  return { host, node };
}
