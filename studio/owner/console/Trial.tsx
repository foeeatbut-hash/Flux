/**
 * «Проверить в работе»: запуск программы из запроса на публикацию на тестовой базе в изоляции.
 *
 * Страница программы — вложенная изолированная (sandbox без доступа к сети, CSP как у Flux),
 * её отдаёт главный процесс из того же пакета, что открыт на экране. Данные для чтения — вымышленные,
 * записанные ниже: общая база компании не открывается, подключения к внешним программам отказывают
 * (разрешения у программы нет), записи некуда. Python и WebAssembly здесь не запускаются: их
 * исполняет окно Flux (modules/engine), а в разделе владельца такого хоста нет.
 */
import React, { useEffect, useRef, useState } from 'react';
import { createModuleBridge } from '../../../modules/bridge';
import { languageOf } from '../../../modules/engine/types';
import { themeKeys, type ModuleManifest, type ReadData, type Resource, type ThemeTokens } from '../../../modules/contract';
import { call } from './api';
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

export default function Trial({ requestId }: { requestId: string }) {
  const [manifest, setManifest] = useState<ModuleManifest | null>(null);
  const [error, setError] = useState('');
  const [failure, setFailure] = useState('');
  const [logs, setLogs] = useState<string[]>([]);
  const [session] = useState(() => crypto.randomUUID());
  const frame = useRef<HTMLIFrameElement>(null);

  useEffect(() => { setManifest(null); setError(''); setFailure(''); setLogs([]); }, [requestId]);

  useEffect(() => {
    if (!manifest || languageOf(manifest) !== 'typescript') return;
    const bridge = createModuleBridge({
      frame: () => frame.current?.contentWindow || null, session, manifest, theme: themeTokens, read: testReader,
      context: () => ({ projectId: TEST_DATA.project?.id || null, entry: manifest.entries[0] || 'start', entityId: manifest.entries[0] === 'tag' ? 'test-tag-1' : manifest.entries[0] === 'equipment' ? 'test-equipment' : null }),
      onFailure: kind => setFailure(kind),
      onLog: (level, text) => setLogs(prev => [...prev.slice(-199), `${level}: ${text}`]),
    });
    const listener = (event: MessageEvent) => { void bridge.handle(event); };
    window.addEventListener('message', listener);
    return () => { window.removeEventListener('message', listener); bridge.dispose(); };
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
  if (languageOf(manifest) !== 'typescript') {
    return <Empty title="Пробный запуск для этого языка — во Flux" text="Python и WebAssembly исполняет окно Flux (общая среда Pyodide и WebAssembly из portable Flux). Проверьте код и контрольные примеры во вкладке «Файлы», а запуск — в тестовом канале Flux." />;
  }
  return <div className="pane">
    <div className="bar"><span className="muted">Тестовая база: вымышленные данные, сети нет, подключения отказывают. Запуск — {manifest.name} {manifest.version}.</span>
      <span className="grow" /><Btn onClick={() => { setManifest(null); }}>Остановить</Btn></div>
    {failure && <ErrorLine text={`Программа остановилась: ${failure}`} />}
    <div className="scroll" style={{ display: 'flex' }}>
      <iframe ref={frame} className="trial" title={manifest.name} data-testid="trial-frame" sandbox="allow-scripts" referrerPolicy="no-referrer"
        allow="camera 'none'; microphone 'none'; geolocation 'none'" src={`flux-module://trial/index.html#${session}`} />
    </div>
    {logs.length > 0 && <pre className="code mono" style={{ flex: '0 0 auto', maxHeight: 120 }} aria-label="Журнал программы">{logs.join('\n')}</pre>}
  </div>;
}
