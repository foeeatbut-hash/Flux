import assert from 'node:assert/strict';
import { createLocalFileAccess } from '../electron/localFileAccess';
import { guardClose, mayClose, clearGuards } from '../src/lib/closeGuard';

async function main() {
  let origin = 'https://company.example/ignored';
  let token = 'session-A';
  let active = true;
  let licensed = true;
  let readOnly = false;
  let offline = false;
  const requests: { url: string; token: string; redirect: string }[] = [];
  const access = createLocalFileAccess({ server: () => origin, token: () => token,
    fetch: (async (url, options) => {
      if (offline) throw new Error('offline');
      requests.push({ url: String(url), token: (options!.headers as any).Authorization, redirect: options!.redirect! });
      return new Response(JSON.stringify(String(url).endsWith('/api/auth/me')
        ? { user: active ? { id: 'employee', isActive: true } : null }
        : { licensed, readOnly }), { status: 200 });
    }) as typeof fetch });
  assert.equal(await access.mayRead(), true);
  assert.equal(await access.mayWrite(), true);
  assert.ok(requests.every(r => r.url.startsWith('https://company.example/api/') && r.token === 'Bearer session-A' && r.redirect === 'error'));
  licensed = false; readOnly = true;
  assert.equal(await access.mayWrite(), false, 'expired license cannot save even after cached licensed read');
  assert.equal(await access.mayRead(), true, 'expired license can read');
  token = '';
  assert.equal(await access.mayRead(), false, 'logout invalidates cached local reads');
  token = 'session-B'; readOnly = false;
  assert.equal(await access.mayRead(), false, 'unlicensed session is not expired-read mode');
  licensed = true; active = false;
  assert.equal(await access.mayWrite(), false, 'deactivated employee cannot save');
  active = true; offline = true;
  assert.equal(await access.mayWrite(), false, 'unreachable server cannot grant local writes');
  offline = false; origin = 'file:///tmp/test';
  assert.equal(await access.mayRead(), false, 'renderer cannot turn the license API into file access');
  clearGuards(); guardClose('edited-file', () => { throw new Error('CAS conflict'); });
  assert.equal(await mayClose('edited-file'), false, 'failed saving must preserve editor');
  clearGuards(); assert.equal(await mayClose('edited-file'), true);
  console.log('Local file access and failed-close preservation: 12 checks PASS');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
