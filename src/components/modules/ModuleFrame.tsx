import React, { useEffect, useRef, useState } from 'react';
import { createModuleBridge } from '../../../modules/bridge';
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
    let refresh: ReturnType<typeof setTimeout> | undefined;
    const changed = () => { clearTimeout(refresh); refresh = setTimeout(() => bridge.notify('changed'), 80); };
    // У каждого portable свой сервер: чужую SQL-запись дополняем опросом, как каталог.
    const poll = setInterval(changed, 20_000);
    window.addEventListener('message', listener);
    // Своих авторов не исключаем: правка в соседнем окне тоже должна перечитать модуль.
    window.addEventListener('socket:entity:changed', changed);
    window.addEventListener('socket:tag:updated', changed);
    window.addEventListener('socket:tag:linked', changed);
    window.addEventListener('catalog:published', changed);
    window.addEventListener('focus', changed);
    return () => {
      bridge.dispose(); bridgeRef.current = null;
      clearTimeout(refresh); clearInterval(poll);
      window.removeEventListener('message', listener);
      window.removeEventListener('socket:entity:changed', changed);
      window.removeEventListener('socket:tag:updated', changed);
      window.removeEventListener('socket:tag:linked', changed);
      window.removeEventListener('catalog:published', changed);
      window.removeEventListener('focus', changed);
    };
  }, [session, manifest]);
  useEffect(() => { bridgeRef.current?.notify('project-changed'); }, [context.projectId, context.entry, context.entityId]);
  useEffect(() => { bridgeRef.current?.notify('changed'); }, [theme]);
  return <iframe ref={frame} title={manifest.name} data-testid="flux-module-frame" sandbox={MODULE_SANDBOX}
    referrerPolicy="no-referrer" allow="camera 'none'; microphone 'none'; geolocation 'none'; clipboard-read 'none'; clipboard-write 'none'"
    src={`flux-module://${manifest.id}/index.html#${session}`}
    className="h-full w-full min-h-0 flex-1 border-0" />;
}
