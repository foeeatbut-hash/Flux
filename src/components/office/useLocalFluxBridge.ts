import { useMemo, useRef, type MutableRefObject } from 'react';
import { base64ToBytes, type WindowsFileContent } from '../../lib/windowsFiles';
import { sha256Hex } from '../../lib/officeBridge';
import type { OfficeLocalFieldRefreshResult } from '../../../office/fieldRefresh';
import { officeDataApi, type OfficeLocalSource } from './fluxData';
import { useOfficeFluxBridge, type OfficeEditorLink, type OfficeFileLink } from './useOfficeFluxBridge';

interface Options {
  /** Word или Таблица: от этого зависят слова сообщений и то, держит ли файл сеанс оболочки. */
  app: 'docs' | 'sheets';
  fileKey: string;
  projectId: string;
  editor: OfficeEditorLink;
  load: () => Promise<WindowsFileContent>;
  write: (bytes: Uint8Array) => Promise<WindowsFileContent>;
  /** Записывает правки редактора в файл; force — даже если редактор о них ещё не знает. */
  save: (force?: boolean) => Promise<boolean>;
  ready: () => boolean;
  /** Таблица: сеанс оболочки должен принять версию файла, которую хост только что записал. */
  rebase?: (sha256: string) => Promise<void>;
  /** Последнее известное содержимое файла: его берёт и сохранение из редактора. */
  latest: MutableRefObject<WindowsFileContent>;
}

/**
 * Файл Проводника для панели Flux. Байты лежат только у хоста: сервер видит их
 * в запросе и возвращает новые, а записывает их файловый мост (`write`), без
 * переоткрытия документа — как у файлов проекта, но без FileNode.
 */
export function useLocalFluxBridge(options: Options) {
  const live = useRef(options); live.current = options;
  // Записанное хостом не нужно читать заново: запись вернула новое содержимое
  const justWrote = useRef(false);
  const source = useMemo<OfficeLocalSource>(() => ({
    kind: 'local', projectId: () => live.current.projectId, base64: () => live.current.latest.current.base64,
  }), []);
  const reload = async () => { const content = await live.current.load(); live.current.latest.current = content; return content; };
  const noun = options.app === 'docs' ? 'Документ' : 'Книга';
  const file: OfficeFileLink = {
    state: async () => {
      if (justWrote.current) justWrote.current = false; else await reload();
      return officeDataApi.state(source);
    },
    updateState: async (body) => {
      const response = await officeDataApi.updateState(source, body);
      if (!response.base64) throw new Error('Сервер не вернул новое содержимое файла.');
      const written = await live.current.write(base64ToBytes(response.base64));
      live.current.latest.current = written;
      justWrote.current = true;
      await live.current.rebase?.(written.sha256);
      return { baseHash: response.baseHash };
    },
    flush: () => { justWrote.current = false; return live.current.save(false); },
    committed: async () => {  // слова ошибки одни на план и схему
      justWrote.current = false;
      if (!(await live.current.save(true))) throw new Error(`${noun} не записан${options.app === 'docs' ? '' : 'а'}. Сохраните правки в редакторе и повторите действие.`);
      await reload();
      const current = await officeDataApi.state(source);
      return { current, savedHash: current.baseHash };
    },
    remember: () => { /* хеш версии берётся из самого содержимого файла */ },
    notReady: () => !live.current.ready(),
    messages: {
      notSaved: `${noun} не записан${options.app === 'docs' ? '' : 'а'}. Сначала сохраните правки.`,
      rowsMissing: `Редактор не вернул сведения о заполненных строках. Сохраните ${options.app === 'docs' ? 'файл' : 'книгу'} и проверьте результат.`,
    },
  };
  const bridge = useOfficeFluxBridge(options.editor, file, options.fileKey);
  const refreshFields = async (projectId: string): Promise<OfficeLocalFieldRefreshResult> => {
    const fileKey = live.current.fileKey;
    const assertScope = () => {
      if (live.current.projectId !== projectId || live.current.fileKey !== fileKey) throw new Error('Проект или файл изменился во время обновления. Повторите действие.');
    };
    if (!projectId || !live.current.ready()) throw new Error('Редактор ещё загружается.');
    assertScope();
    if (!(await live.current.save(true))) throw new Error('Изменения файла не удалось сохранить. Поля не обновлены.');
    const before = await reload();
    assertScope();
    const result = await officeDataApi.updateLocalFields({ projectId, base64: before.base64, baseHash: before.sha256 });
    assertScope();
    const updatedBytes = base64ToBytes(result.base64);
    const resultHash = await sha256Hex(updatedBytes.slice().buffer as ArrayBuffer);
    if (resultHash !== result.sha256) throw new Error('Ответ обновления повреждён. Файл не изменён.');
    const current = await live.current.load();
    assertScope();
    if (current.sha256 !== before.sha256) throw new Error('Файл изменился во время обновления. Поля не записаны.');
    if (result.unchanged) {
      if (result.sha256 !== before.sha256) throw new Error('Файл изменился во время обновления. Поля не записаны.');
      live.current.latest.current = current;
      return result;
    }
    const written = await live.current.write(updatedBytes);
    if (written.sha256 !== result.sha256) throw new Error('Не удалось подтвердить новую версию файла.');
    live.current.latest.current = written;
    justWrote.current = true;
    return result;
  };
  return { ...bridge, source, refreshFields };
}
