import React, { useEffect, useRef, useState } from 'react';
import { createModuleBridge } from '../../../modules/bridge';
import { useRealTimeSync } from '../SocketProvider';
import { subscribeModuleRefresh, requestModuleRefresh } from '../../services/moduleRefresh';
import { MODULE_SANDBOX } from '../../../modules/protocol';
import {
  themeKeys, type LaunchContext, type ModuleManifest, type ModuleReader, type ThemeTokens,
} from '../../../modules/contract';

export interface ModuleFrameProps {
  manifest: ModuleManifest;
  context: LaunchContext;
  theme: string;
  createReadCycle: () => ModuleReader;
}
function themeTokens(): ThemeTokens {
  const style = getComputedStyle(document.documentElement);
  return Object.fromEntries(themeKeys.map(key => [key, style.getPropertyValue(key).trim()])) as ThemeTokens;
}
export default function ModuleFrame({ manifest, context, theme, createReadCycle }: ModuleFrameProps) {
  const { isConnected } = useRealTimeSync();
  const connected = useRef(isConnected);
  connected.current = isConnected;
  const frame = useRef<HTMLIFrameElement>(null);
  const [session] = useState(() => crypto.randomUUID());
  const latest = useRef({ context, createReadCycle });
  latest.current = { context, createReadCycle };
  const bridgeRef = useRef<ReturnType<typeof createModuleBridge> | null>(null);
  useEffect(() => {
    let reader = latest.current.createReadCycle();
    const bridge = createModuleBridge({
      frame: () => frame.current?.contentWindow || null, session, manifest,
      context: () => latest.current.context, theme: themeTokens,
      beginReadCycle: () => { reader = latest.current.createReadCycle(); },
      read: (resource, entityId) => reader(resource, entityId),
    });
    bridgeRef.current = bridge;
    const listener = (event: MessageEvent) => { void bridge.handle(event); };
    window.addEventListener('message', listener);
    const unsubscribe = subscribeModuleRefresh(() => bridge.notify('changed'), () => connected.current);
    return () => {
      bridge.dispose(); bridgeRef.current = null;
      unsubscribe();
      window.removeEventListener('message', listener);
    };
  }, [session, manifest]);
  useEffect(() => { if (isConnected) requestModuleRefresh(); }, [isConnected]);
  useEffect(() => { bridgeRef.current?.notify('project-changed'); }, [context.projectId, context.entry, context.entityId]);
  useEffect(() => { bridgeRef.current?.notify('changed'); }, [theme]);
  return <iframe ref={frame} title={manifest.name} data-testid="flux-module-frame" sandbox={MODULE_SANDBOX}
    referrerPolicy="no-referrer" allow="camera 'none'; microphone 'none'; geolocation 'none'; clipboard-read 'none'; clipboard-write 'none'"
    src={`flux-module://${manifest.id}/index.html#${session}`}
    className="h-full w-full min-h-0 flex-1 border-0" />;
}
