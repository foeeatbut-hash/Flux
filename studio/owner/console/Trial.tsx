/**
 * «Проверить в работе»: запуск программы из запроса на публикацию на тестовой базе в изоляции.
 *
 * Страница программы — вложенная изолированная (sandbox без доступа к сети, CSP как у Flux),
 * её отдаёт главный процесс из того же пакета, что открыт на экране. Данные для чтения — вымышленные,
 * записанные ниже: общая база компании не открывается, подключения к внешним программам отказывают
 * (разрешения у программы нет), записи некуда. Файл пользователя (flux.openFile) и диалоги (flux.dialogs) настоящие, как в запуске
 * разработчика (общая часть — studio/shell/programFile.ts). Python и WebAssembly здесь не запускаются: их
 * исполняет окно Flux (modules/engine), а в разделе владельца такого хоста нет.
 */
import React, { useEffect, useRef, useState } from 'react';
import { createModuleBridge } from '../../../modules/bridge';
import { languageOf } from '../../../modules/engine/types';
import { themeKeys, type ModuleManifest, type ReadData, type Resource, type ThemeTokens } from '../../../modules/contract';
import { call } from './api';
import { dialogAnswerLine, dialogStartLine, pickedFromWire } from '../../renderer/work/programDialog';
import type { PageDialog, PageDialogAnswer } from '../../../modules/page/model';
import TrialDialog from './TrialDialog';
import { Btn, Empty, ErrorLine } from './ui';

/** Тестовая база: небольшая, но с данными во всех пяти ресурсах договора */
const TEST_DATA: ReadData = {
  project: { id: 'test-project', name: 'Тестовый проект', code: 'TEST' },
  equipment: {
    id: 'test-equipment', name: 'Насос тестовый', itemCode: 'PMP-001', equipType: 'Насос', version: 1,
    params: [{ group: 'Основные', key: 'power', value: '15', unit: 'кВт' }, { group: 'Основные', key: 'flow', value: '120', unit: 'м3/ч' }],
    tags: [{ id: 'test-tag-1', identifier: 'P-101', name: 'Насос подачи', parentId: null }],
    composition: [{ id: 'part-1', name: 'Электродвигатель', itemCode: 'MTR-001', parentId: null }],
  },
  tag: { id: 'test-tag-1', identifier: 'P-101', name: 'Насос подачи', parentId: null },
  specification: { rows: [{ id: 'test-tag-1', identifier: 'P-101', name: 'Насос подачи', parentId: null }, { id: 'test-tag-2', identifier: 'P-102', name: 'Насос резервный', parentId: null }] },
  catalog: { families: [{ id: 'family-1', name: 'Насосы', code: 'PMP', classId: 'class-1' }] },
};
export const testReader = async <R extends Resource>(resource: R): Promise<ReadData[R]> => structuredClone(TEST_DATA[resource]);

function themeTokens(): ThemeTokens {
  const style = getComputedStyle(document.documentElement);
  return Object.fromEntries(themeKeys.map(key => [key, style.getPropertyValue(key).trim()])) as ThemeTokens;
}

const isPage = (manifest: ModuleManifest) => (manifest as { ui?: string }).ui === 'page';

export default function Trial({ requestId }: { requestId: string }) {
  const [manifest, setManifest] = useState<ModuleManifest | null>(null);
  const [error, setError] = useState('');
  const [failure, setFailure] = useState('');
  const [logs, setLogs] = useState<string[]>([]);
  const [session] = useState(() => crypto.randomUUID());
  const frame = useRef<HTMLIFrameElement>(null);
  const kept = useRef<Record<string, unknown>>({});
  const [dialog, setDialog] = useState<{ request: PageDialog; resolve: (answer: PageDialogAnswer) => void } | null>(null);
  const log = (text: string) => setLogs(prev => [...prev.slice(-199), text]);

  useEffect(() => { setManifest(null); setError(''); setFailure(''); setLogs([]); }, [requestId]);

  useEffect(() => {
    // Программа со своим экраном считает на странице сама: язык расчётов ей не мешает, а flux.compute в пробном запуске отвечает «недоступно»
    if (!manifest || (!isPage(manifest) && languageOf(manifest) !== 'typescript')) return;
    const page = isPage(manifest);
    const bridge = createModuleBridge({
      frame: () => frame.current?.contentWindow || null, session, manifest: page ? ({ ...manifest, contractVersion: 2 } as ModuleManifest) : manifest, theme: themeTokens, read: testReader,
      context: () => ({ projectId: TEST_DATA.project?.id || null, entry: manifest.entries[0] || 'start', entityId: manifest.entries[0] === 'tag' ? 'test-tag-1' : manifest.entries[0] === 'equipment' ? 'test-equipment' : null }),
      // Страница: окна, файлы и обмен в пробном запуске ничего не делают, состояние живёт, пока открыт запуск
      page: page ? {
        loadState: () => kept.current, keepState: state => { kept.current = state; },
        offerFile: async file => { setLogs(prev => [...prev.slice(-199), `файл: ${file.name} (${file.bytes.length} Б) — во Flux его предложат сохранить`]); return 'saved'; },
        // Файл пользователя: диалог показывает главный процесс Studio, как Flux в настоящем запуске; программа получает только выбранный файл
        pickFile: async request => pickedFromWire(await call('trialPickFile', { accept: request.accept }), text => log(`файл: ${text}`)),
        // Диалоги Flux: показывает диалог Studio, ответ человека идёт программе как во Flux; остановка запуска закрывает диалог без ответа
        dialog: request => new Promise<PageDialogAnswer>(resolve => {
          log(`диалог: ${dialogStartLine(request)}`);
          setDialog({ request, resolve: answer => { log(`диалог: ${dialogAnswerLine(request, answer)}`); resolve(answer); } });
        }),
        setTitle: text => setLogs(prev => [...prev.slice(-199), `заголовок окна: ${text || 'название программы'}`]),
        setUnsaved: (unsaved, text) => setLogs(prev => [...prev.slice(-199), `несохранённое: ${unsaved ? `есть ${text}`.trim() : 'нет'}`]),
        onBeat: () => undefined, openWindow: (name, params) => { setLogs(prev => [...prev.slice(-199), `окно: ${name} ${JSON.stringify(params)} — во Flux откроется обычным окном`]); return true; },
        params: () => ({}), broadcast: data => setLogs(prev => [...prev.slice(-199), `обмен: ${JSON.stringify(data).slice(0, 120)}`]),
      } : undefined,
      onFailure: kind => setFailure(kind),
      onLog: (level, text) => setLogs(prev => [...prev.slice(-199), `${level}: ${text}`]),
    });
    const listener = (event: MessageEvent) => { void bridge.handle(event); };
    window.addEventListener('message', listener);
    return () => { window.removeEventListener('message', listener); bridge.dispose(); setDialog(current => { current?.resolve(null); return null; }); };
  }, [manifest, session]);

  const start = async () => {
    setError('');
    try { setManifest((await call<{ manifest: ModuleManifest }>('trialLoad', { id: requestId })).manifest); }
    catch (e: any) { setError(e.message); }
  };

  if (!manifest) {
    return <div className="scroll"><Empty title="Проверить в работе" text="Программа запустится в изоляции на тестовой базе: без сети, без доступа к общей базе компании, на вымышленных данных." />
      <div className="pad" style={{ textAlign: 'center' }}><Btn tone="primary" onClick={() => void start()}>Запустить на тестовой базе</Btn></div><ErrorLine text={error} /></div>;
  }
  if (!isPage(manifest) && languageOf(manifest) !== 'typescript') {
    return <Empty title="Пробный запуск для этого языка — во Flux" text="Python и WebAssembly исполняет окно Flux (общая среда Pyodide и WebAssembly из portable Flux). Проверьте код и контрольные примеры во вкладке «Файлы», а запуск — в пробной группе во Flux." />;
  }
  return <div className="pane">
    <div className="bar"><span className="muted">Тестовая база: вымышленные данные, сети нет, подключения отказывают. Запуск — {manifest.name} {manifest.version}.</span>
      <span className="grow" /><Btn onClick={() => { setManifest(null); }}>Остановить</Btn></div>
    {failure && <ErrorLine text={`Программа остановилась: ${failure}`} />}
    <div className="scroll" style={{ display: 'flex' }}>
      <iframe ref={frame} className="trial" title={manifest.name} data-testid="trial-frame" sandbox="allow-scripts" referrerPolicy="no-referrer"
        allow="camera 'none'; microphone 'none'; geolocation 'none'" src={`flux-module://trial/${isPage(manifest) ? 'ui/index.html' : 'index.html'}#${session}`} />
    </div>
    {dialog && manifest && <TrialDialog program={manifest.name} request={dialog.request} onAnswer={answer => { setDialog(null); dialog.resolve(answer); }} />}
    {logs.length > 0 && <pre className="code mono" style={{ flex: '0 0 auto', maxHeight: 120 }} aria-label="Журнал программы">{logs.join('\n')}</pre>}
  </div>;
}
