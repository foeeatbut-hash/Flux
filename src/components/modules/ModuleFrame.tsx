import React, { useEffect, useRef, useState } from 'react';
import { createModuleBridge } from '../../../modules/bridge';
import { useRealTimeSync } from '../SocketProvider';
import { subscribeModuleRefresh } from '../../services/moduleRefresh';
import { recordModuleCrash } from '../../services/moduleCrashQueue';
import { MODULE_SANDBOX } from '../../../modules/protocol';
import { languageOf } from '../../../modules/engine/types';
import { moduleCompute } from '../../services/moduleComputeHost';
import { ensureControls, type ControlsGate } from '../../services/moduleControlsGate';
import {
  themeKeys, type LaunchContext, type ModuleManifest, type ModuleReader, type ThemeTokens, type ModuleFailureKind,
} from '../../../modules/contract';

export interface ModuleFrameProps {
  manifest: ModuleManifest;
  context: LaunchContext;
  theme: string;
  channel?: 'test' | 'production';
  createReadCycle: () => ModuleReader;
}
function themeTokens(): ThemeTokens {
  const style = getComputedStyle(document.documentElement);
  return Object.fromEntries(themeKeys.map(key => [key, style.getPropertyValue(key).trim()])) as ThemeTokens;
}
export default function ModuleFrame({ manifest, context, theme, createReadCycle, channel = 'production' }: ModuleFrameProps) {
  const { isConnected } = useRealTimeSync();
  const connected = useRef(isConnected);
  connected.current = isConnected;
  const frame = useRef<HTMLIFrameElement>(null);
  const [session] = useState(() => crypto.randomUUID());
  const [failure, setFailure] = useState<ModuleFailureKind | null>(null);
  const language = languageOf(manifest);
  const [gate, setGate] = useState<ControlsGate | 'checking'>(language === 'typescript' ? 'ok' : 'checking');
  useEffect(() => {
    if (language === 'typescript') return;
    let current = true;
    void ensureControls(manifest).then(result => { if (current) setGate(result); });
    return () => { current = false; };
  }, [manifest, language]);
  const latest = useRef({ context, createReadCycle });
  latest.current = { context, createReadCycle };
  const bridgeRef = useRef<ReturnType<typeof createModuleBridge> | null>(null);
  const refreshRef = useRef<ReturnType<typeof subscribeModuleRefresh> | null>(null);
  useEffect(() => {
    let reader = latest.current.createReadCycle();
    const bridge = createModuleBridge({
      frame: () => frame.current?.contentWindow || null, session, manifest,
      context: () => latest.current.context, theme: themeTokens,
      beginReadCycle: () => { reader = latest.current.createReadCycle(); },
      read: (resource, entityId) => reader(resource, entityId),
      onFailure: kind => { recordModuleCrash(manifest.id, manifest.version, kind); setFailure(kind); },
      compute: language === 'typescript' ? undefined : input => moduleCompute().compute({ moduleId: manifest.id, version: manifest.version, language }, input,
        document.visibilityState === 'visible' ? 'active' : 'background'),
      // Счётчик сбоев пишет сам расчёт; здесь только плашка «подпрограмма остановилась»
      onComputeError: code => setFailure(code === 'TIMEOUT' ? 'timeout' : code === 'MEMORY' ? 'memory' : code === 'CRASH' || code === 'ABI' || code === 'BAD_OUTPUT' || code === 'NUMBER' ? 'crash' : null),
    });
    bridgeRef.current = bridge;
    const listener = (event: MessageEvent) => { void bridge.handle(event); };
    window.addEventListener('message', listener);
    const unsubscribe = subscribeModuleRefresh(() => bridge.notify('changed'), () => connected.current);
    refreshRef.current = unsubscribe;
    return () => {
      bridge.dispose(); bridgeRef.current = null;
      unsubscribe();
      refreshRef.current = null;
      window.removeEventListener('message', listener);
    };
  }, [session, manifest, language]);
  useEffect(() => { refreshRef.current?.connectionChanged(); }, [isConnected]);
  useEffect(() => { bridgeRef.current?.notify('project-changed'); }, [context.projectId, context.entry, context.entityId]);
  useEffect(() => { bridgeRef.current?.notify('changed'); }, [theme]);
  return <div className="flex h-full min-h-0 flex-1 flex-col">
    {failure && <div role="alert" className="flex items-center gap-3 border-b border-[var(--flux-line)] bg-[var(--flux-surface)] p-3 text-sm text-[var(--flux-text)]">
      <span>Подпрограмма {manifest.name} остановилась — отправить отчёт разработчику?</span>
      <button type="button" className="text-[var(--flux-accent)] underline" onClick={() => {
        window.dispatchEvent(new CustomEvent('flux:report-module', { detail: { source: 'running', moduleId: manifest.id, name: manifest.name, version: manifest.version, channel, moduleDiagnostics: { code: failure } } }));
        setFailure(null);
      }}>Отправить отчёт</button>
      <button type="button" onClick={() => setFailure(null)}>Закрыть</button>
    </div>}
    {gate === 'checking' && <div className="fx-empty"><div className="fx-empty-title">Проверка расчёта на этом компьютере…</div></div>}
    {gate === 'failed' && <div className="fx-empty" role="alert"><div className="fx-empty-title">Подпрограмма не запущена</div><div className="fx-empty-text">Контрольные примеры на этом компьютере не сошлись. Сообщение о сбое отправлено разработчику.</div></div>}
    {gate === 'ok' && <iframe ref={frame} title={manifest.name} data-testid="flux-module-frame" sandbox={MODULE_SANDBOX}
    referrerPolicy="no-referrer" allow="camera 'none'; microphone 'none'; geolocation 'none'; clipboard-read 'none'; clipboard-write 'none'"
    src={`flux-module://${manifest.id}/index.html#${session}`}
    className="h-full w-full min-h-0 flex-1 border-0" />}
  </div>;
}
