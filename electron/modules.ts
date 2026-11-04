import { app, protocol, type WebContents } from 'electron';
import path from 'node:path';
import fs from 'node:fs/promises';
import { bundledModules } from '../modules/bundled';
import { MODULE_SCHEME, moduleAssetPath, moduleHeaders } from '../modules/protocol';

export function registerModuleScheme() {
  // Не выдаём bypassCSP, fetch, service workers и доступ к файловой системе.
  protocol.registerSchemesAsPrivileged([{ scheme: MODULE_SCHEME, privileges: { standard: true, secure: true, corsEnabled: true } }]);
  app.on('web-contents-created', (_event, contents) => guardModuleNavigation(contents));
}
export function guardModuleNavigation(contents: WebContents) {
  // CSP ограничивает ресурсы, но не самостоятельный переход iframe по внешней ссылке.
  contents.on('will-frame-navigate', event => {
    if (event.frame?.url.startsWith(`${MODULE_SCHEME}:`)) event.preventDefault();
  });
}
export function setupModuleProtocol(distRoot: string) {
  const ids = bundledModules.map(item => item.id);
  protocol.handle(MODULE_SCHEME, async request => {
    const asset = moduleAssetPath(request.url, ids);
    if (request.method !== 'GET' || !asset) return new Response(null, { status: 404 });
    try {
      const data = await fs.readFile(path.join(distRoot, 'modules', asset.id, asset.file));
      const type = asset.file.endsWith('.js') ? 'text/javascript; charset=utf-8' : asset.file.endsWith('.css') ? 'text/css; charset=utf-8'
        : asset.file.endsWith('.woff2') ? 'font/woff2' : 'text/html; charset=utf-8';
      return new Response(data, { headers: moduleHeaders(type) });
    } catch (_) { return new Response(null, { status: 404 }); }
  });
}
