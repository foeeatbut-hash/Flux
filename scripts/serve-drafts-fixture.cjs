const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs/promises');
const root = path.resolve('.cache/drafts-ui');
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.svg': 'image/svg+xml' };
http.createServer(async (request, response) => {
  try {
    const name = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
    const file = path.resolve(root, '.' + name);
    if (!file.startsWith(root + path.sep)) { response.writeHead(403).end(); return; }
    const bytes = await fs.readFile(file);
    response.writeHead(200, { 'Content-Type': mime[path.extname(file)] || 'application/octet-stream' }).end(bytes);
  } catch { response.writeHead(404).end(); }
}).listen(5395, '127.0.0.1');
