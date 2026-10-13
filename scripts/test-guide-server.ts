/** Disposable live contracts for Guide history, F replies, and Messenger ACL. */
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import net from 'node:net';
import { io as ioClient, type Socket } from 'socket.io-client';

const require = createRequire(__filename);
const Database = require('better-sqlite3');
const cwd = process.cwd();
let port = 0;
let base = process.env.FLUX_API || '';
const external = !!process.env.FLUX_API;
let dataDir = '';
let dbPath = '';
let child: ChildProcess | null = null;
let db: any = null;
let failed = 0;
const pass = (label: string, condition: unknown, details?: unknown) => {
  if (condition) console.log(`  ✓ ${label}`);
  else { failed++; console.error(`  ✗ ${label}`, details === undefined ? '' : JSON.stringify(details).slice(0, 240)); }
};
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function api(token: string, method: string, url: string, body?: unknown) {
  const response = await fetch(base + url, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { }
  return { status: response.status, json, text };
}

function launch(): ChildProcess {
  const env = {
    ...process.env,
    VENT_APP_DATA: dataDir,
    PORT: String(port),
    FLUX_LISTEN_HOST: '127.0.0.1',
    FLUX_API_ONLY: '1',
    FLUX_TEST_LICENSE: '1',
    FLUX_TEST_LICENSE_AUTO: '1',
    NODE_ENV: 'test',
  };
  const proc = spawn(process.execPath, ['--import', 'tsx', 'server.ts'], { cwd, env, stdio: ['ignore', 'ignore', 'pipe'] });
  proc.stderr?.on('data', (part) => {
    const line = String(part);
    if (/error|exception|failed/i.test(line)) process.stderr.write(line.slice(0, 1000));
  });
  return proc;
}

async function availableLoopbackPort(requested?: number): Promise<number> {
  const probe = net.createServer();
  await new Promise<void>((resolve, reject) => {
    probe.once('error', reject);
    probe.listen(requested || 0, '127.0.0.1', () => resolve());
  });
  const address = probe.address();
  if (!address || typeof address === 'string') throw new Error('Could not determine disposable server port');
  await new Promise<void>((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

async function waitHealthy() {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    if (child?.exitCode !== null && child?.exitCode !== undefined) throw new Error(`Disposable server exited (${child.exitCode})`);
    try {
      const response = await fetch(base + '/api/health');
      if (response.ok) {
        try {
          const probe = new Database(dbPath, { readonly: true, fileMustExist: true });
          const hasUserTable = !!probe.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'User'").get();
          probe.close();
          if (hasUserTable) return;
        } catch { }
      }
    } catch { }
    if (child?.exitCode !== null && child?.exitCode !== undefined) throw new Error(`Disposable server exited (${child.exitCode})`);
    await wait(250);
  }
  throw new Error('Disposable server did not become healthy within 30 seconds');
}

async function assertNativeOfficeAssets(): Promise<void> {
  const files = [
    ['public/genoffice/docs/index.html', 'dist/genoffice/docs/index.html'],
    ['public/genoffice/sheets/index.html', 'dist/genoffice/sheets/index.html'],
  ] as const;
  for (const [source, served] of files) {
    let sourceBytes: Buffer, servedBytes: Buffer;
    try { [sourceBytes, servedBytes] = await Promise.all([readFile(path.join(cwd, source)), readFile(path.join(cwd, served))]); }
    catch { throw new Error(`Native Office test blocked: missing rebuilt editor asset ${source} or ${served}`); }
    if (!sourceBytes.equals(servedBytes)) throw new Error(`Native Office test blocked: ${source} differs from ${served}; rebuild and serve the current editor assets first`);
  }
}

async function writeFixtureMetadata(users: Array<{ id: string; symbol: string; password: string }>, projectId: string, systemId: string): Promise<string> {
  const fixturePath = path.join(dataDir, 'fixture.json');
  await writeFile(fixturePath, JSON.stringify({
    baseUrl: base,
    admin: { id: users[0].id, symbol: users[0].symbol, password: users[0].password },
    peer: { id: users[1].id, symbol: users[1].symbol, password: users[1].password },
    outsider: { id: users[2].id, symbol: users[2].symbol, password: users[2].password },
    projectId,
    systemId,
    dataDir,
  }, null, 2), { mode: 0o600 });
  await chmod(fixturePath, 0o600);
  return fixturePath;
}

function hashPassword(password: string) {
  const salt = crypto.randomBytes(16);
  return `scrypt$${salt.toString('hex')}$${crypto.scryptSync(password, salt, 64).toString('hex')}`;
}

async function waitSocket(socket: Socket) {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Socket connect timeout')), 8000);
    socket.once('connect', () => { clearTimeout(timer); resolve(); });
    socket.once('connect_error', (error) => { clearTimeout(timer); reject(error); });
  });
}

async function stop() {
  if (!child) return;
  const current = child;
  child = null;
  if (current.exitCode !== null) return;
  current.kill('SIGTERM');
  await Promise.race([new Promise<void>((resolve) => current.once('exit', () => resolve())), wait(8000)]);
  if (current.exitCode === null) current.kill('SIGKILL');
}

async function main() {
  if (external) {
    await fetch(base + '/api/health');
    throw new Error('For this suite, omit FLUX_API so it owns its disposable SQLite server.');
  }
  port = await availableLoopbackPort(process.env.FLUX_API_PORT ? Number(process.env.FLUX_API_PORT) : undefined);
  base = `http://127.0.0.1:${port}`;
  dataDir = await mkdtemp(path.join(os.tmpdir(), 'flux-guide-server-'));
  dbPath = path.join(dataDir, 'database.sqlite');
  child = launch();
  await waitHealthy();
  db = new Database(dbPath);

  const stamp = crypto.randomBytes(5).toString('hex');
  const legacyOfficeChecks = ['docs', 'sheets', 'collab'].filter((name) => process.argv.includes(`--office-${name}`));
  const officeFilesMode = process.argv.includes('--office-files') || legacyOfficeChecks.includes('collab');
  const users = [
    { id: `guide_admin_${stamp}`, symbol: `GA${stamp}`, password: crypto.randomBytes(16).toString('hex'), name: 'Synthetic Guide Admin', role: 'ADMIN' },
    { id: `guide_peer_${stamp}`, symbol: `GP${stamp}`, password: crypto.randomBytes(16).toString('hex'), name: 'Synthetic Guide Peer', role: 'ENGINEER_VENT' },
    { id: `guide_outsider_${stamp}`, symbol: `GO${stamp}`, password: crypto.randomBytes(16).toString('hex'), name: 'Synthetic Guide Outsider', role: 'ENGINEER_VENT' },
  ];
  const projectId = `guide_project_${stamp}`;
  const systemId = `guide_system_${stamp}`;
  const monoblockId = `guide_mono_${stamp}`;
  const now = new Date().toISOString();
  const insertUser = db.prepare('INSERT INTO User (id, symbol, password, name, role, isActive, createdAt) VALUES (?, ?, ?, ?, ?, 1, ?)');
  const tx = db.transaction(() => {
    for (const user of users) insertUser.run(user.id, user.symbol, hashPassword(user.password), user.name, user.role, now);
    db.prepare('INSERT INTO Project (id, name, createdAt) VALUES (?, ?, ?)').run(projectId, `Guide fixture ${stamp}`, now);
    const addMember = db.prepare('INSERT INTO ProjectMember (id, projectId, userId, addedBy, addedAt) VALUES (?, ?, ?, ?, ?)');
    addMember.run(`m_admin_${stamp}`, projectId, users[0].id, users[0].id, now);
    addMember.run(`m_peer_${stamp}`, projectId, users[1].id, users[0].id, now);
    db.prepare('INSERT INTO EquipmentSystem (id, name, projectId, category, createdAt) VALUES (?, ?, ?, ?, ?)')
      .run(systemId, 'П1', projectId, 'AHU', now);
    db.prepare('INSERT INTO Monoblock (id, name, systemId, createdAt) VALUES (?, ?, ?, ?)')
      .run(monoblockId, 'МБ-1', systemId, now);
    const insertComponent = db.prepare('INSERT INTO ComponentElement (id, name, itemCode, monoblockId, specs, equipType, status, hasConflict, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)');
    const specs = (airflow: number) => JSON.stringify({ groups: [{ title: 'Аэродинамика', params: [{ key: 'Расход воздуха', value: String(airflow), unit: 'м³/ч' }] }] });
    insertComponent.run(`fan_low_${stamp}`, 'FAN_LOW', 'FAN_LOW', monoblockId, specs(900), 'ВЕНТИЛЯТОР', 'OK', now, now);
    insertComponent.run(`fan_high_${stamp}`, 'FAN_HIGH', 'FAN_HIGH', monoblockId, specs(1200), 'ВЕНТИЛЯТОР', 'OK', now, now);
  });
  tx();
  if (officeFilesMode) {
    db.prepare('UPDATE User SET permissions = ? WHERE id = ?').run(JSON.stringify({
      'admin.users.create': { enabled: true },
      'admin.users.manage': { enabled: true },
    }), users[0].id);
  }

  if (legacyOfficeChecks.length) {
    await assertNativeOfficeAssets();
    for (const name of legacyOfficeChecks) {
      const office = spawn(process.execPath, ['--import', 'tsx', `scripts/test-office-${name}-live.ts`], {
        cwd,
        env: { ...process.env, FLUX_API: base, FLUX_API2: base, FLUX_USER: users[0].symbol, FLUX_PASS: users[0].password, FLUX_TEST_FIXTURE: '1', FLUX_PG: '' },
        stdio: 'inherit',
      });
      const [code] = await once(office, 'exit');
      if (code !== 0) { process.exitCode = typeof code === 'number' ? code : 1; break; }
    }
    await stop();
    db?.close();
    await rm(dataDir, { recursive: true, force: true });
    return;
  }

  if (process.argv.includes('--office-files')) {
    const office = spawn(process.execPath, ['--import', 'tsx', 'scripts/test-office-files-live.ts'], {
      cwd,
      env: { ...process.env, FLUX_API: base, FLUX_USER: users[0].symbol, FLUX_PASS: users[0].password },
      stdio: 'inherit',
    });
    const [code] = await once(office, 'exit');
    await stop();
    db?.close();
    await rm(dataDir, { recursive: true, force: true });
    process.exitCode = typeof code === 'number' ? code : 1;
    return;
  }

  if (process.argv.includes('--office-addon-api')) {
    const office = spawn(process.execPath, ['--import', 'tsx', 'scripts/test-office-api-live.ts'], {
      cwd,
      env: {
        ...process.env,
        FLUX_API: base,
        FLUX_USER: users[0].symbol,
        FLUX_PASS: users[0].password,
        FLUX_PEER_USER: users[1].symbol,
        FLUX_PEER_PASS: users[1].password,
        FLUX_PROJECT_ID: projectId,
      },
      stdio: 'inherit',
    });
    const [code] = await once(office, 'exit');
    await stop();
    db?.close();
    await rm(dataDir, { recursive: true, force: true });
    process.exitCode = typeof code === 'number' ? code : 1;
    return;
  }

  // Файлы Проводника: панель Flux над локальным DOCX/XLSX, байты пишет редактор
  if (process.argv.includes('--office-explorer')) {
    await assertNativeOfficeAssets();
    const fixturePath = await writeFixtureMetadata(users, projectId, systemId);
    const office = spawn(process.execPath, ['--import', 'tsx', 'scripts/test-office-explorer-live.ts', fixturePath], {
      cwd,
      env: { ...process.env, FLUX_OFFICE_NATIVE_READY: '1' },
      stdio: 'inherit',
    });
    const [code] = await once(office, 'exit');
    await stop();
    db?.close();
    await rm(dataDir, { recursive: true, force: true });
    process.exitCode = typeof code === 'number' ? code : 1;
    return;
  }

  if (process.argv.includes('--office-addon-native')) {
    await assertNativeOfficeAssets();
    const fixturePath = await writeFixtureMetadata(users, projectId, systemId);
    const office = spawn(process.execPath, ['--import', 'tsx', 'scripts/test-office-addon-native-live.ts', fixturePath], {
      cwd,
      env: { ...process.env, FLUX_OFFICE_NATIVE_READY: '1' },
      stdio: 'inherit',
    });
    const [code] = await once(office, 'exit');
    await stop();
    db?.close();
    await rm(dataDir, { recursive: true, force: true });
    process.exitCode = typeof code === 'number' ? code : 1;
    return;
  }

  // Keep the disposable server alive for other live suites without exposing
  // its synthetic login details in the terminal or process arguments.
  if (process.argv.includes('--fixture')) {
    const fixturePath = await writeFixtureMetadata(users, projectId, systemId);
    console.log(`Disposable Guide/Office fixture ready: ${base}`);
    console.log(`Private synthetic credentials: ${fixturePath}`);
    await new Promise<void>((resolve) => {
      let closing = false;
      const close = async () => {
        if (closing) return;
        closing = true;
        await stop();
        db?.close();
        await rm(dataDir, { recursive: true, force: true });
        resolve();
      };
      process.once('SIGINT', () => { void close(); });
      process.once('SIGTERM', () => { void close(); });
      child?.once('exit', () => { void close(); });
    });
    return;
  }

  const tokens = new Map<string, string>();
  for (const user of users) {
    const login = await api('', 'POST', '/api/login', { symbol: user.symbol, password: user.password });
    pass(`${user.role} synthetic login`, !!login.json?.token, login.status);
    tokens.set(user.id, login.json?.token || '');
  }
  const admin = users[0], peer = users[1], outsider = users[2];
  const adminToken = tokens.get(admin.id)!, peerToken = tokens.get(peer.id)!, outsiderToken = tokens.get(outsider.id)!;

  const sockets: Socket[] = [];
  const openSocket = async (token: string) => {
    const socket = ioClient(base, { auth: { token }, transports: ['websocket'], reconnection: false });
    sockets.push(socket);
    await waitSocket(socket);
    const events: any[] = [];
    socket.on('chat:message_received', (message) => events.push(message));
    return events;
  };

  try {
    console.log('1. Direct F reply is part of its original private conversation');
    const adminEvents = await openSocket(adminToken);
    const peerEvents = await openSocket(peerToken);
    const outsiderEvents = await openSocket(outsiderToken);
    const question = await api(adminToken, 'POST', '/api/chat/messages', {
      senderId: admin.id, receiverId: peer.id, content: 'Сколько систем в проекте?', guideRequest: true,
    });
    const requestId = String(question.json?.id || '');
    pass('request stored with a stable server message id', !!requestId && question.json?.guideRequest === true, question.status);
    const answer = await api(adminToken, 'POST', '/api/guide/chat-reply', {
      type: 'DIRECT', conversationId: peer.id, requestMessageId: requestId, projectId,
    });
    const replyId = String(answer.json?.replyId || '');
    pass('server publishes the answer for that exact request', answer.status === 200 && answer.json?.published && !!replyId, answer.json);
    pass('system-count intent counts actual systems', /Систем в проекте: 1/.test(String(answer.json?.text || '')), answer.json?.text);
    await wait(150);
    pass('both direct participants receive the reply event', adminEvents.some((m) => m.id === replyId) && peerEvents.some((m) => m.id === replyId));
    pass('outsider receives no reply event', !outsiderEvents.some((m) => m.id === replyId));

    const peerHistory = await api(peerToken, 'GET', `/api/chat/messages?senderId=${admin.id}&receiverId=${peer.id}`);
    pass('counterpart reads F reply from direct history', peerHistory.status === 200 && peerHistory.json.some((m: any) => m.id === replyId), peerHistory.status);
    const adminHistory = await api(adminToken, 'GET', `/api/chat/messages?senderId=${admin.id}&receiverId=${peer.id}`);
    pass('request author reads F reply from direct history', adminHistory.status === 200 && adminHistory.json.some((m: any) => m.id === replyId));
    const index = await api(peerToken, 'GET', '/api/chat/index');
    pass('direct index keeps canonical peer conversation and latest F preview', index.json?.chats?.some((chat: any) => chat.id === `from=${admin.id}` && chat.lastMessage.includes('Flux Guide')));
    pass('service account never becomes a ghost direct conversation', !index.json?.chats?.some((chat: any) => chat.id.includes('flux-guide-service') || chat.peerId === 'flux-guide-service'));
    const search = await api(peerToken, 'GET', '/api/chat/search?q=систем');
    pass('history search finds the service answer in the same direct chat', search.json?.results?.some((row: any) => row.messageId === replyId && row.chatId === `from=${admin.id}`), search.json);
    const deep = await api(peerToken, 'GET', `/api/chat/messages/${replyId}`);
    pass('single-result route loads a deep history result for the counterpart', deep.status === 200 && deep.json?.id === replyId);
    const quoted = await api(peerToken, 'POST', '/api/chat/messages', {
      senderId: peer.id, receiverId: admin.id, content: 'Ссылаюсь на ответ Guide', replyToId: replyId,
    });
    pass('counterpart can quote the F reply in the same direct conversation', quoted.status === 200 && quoted.json?.replyToId === replyId, quoted.status);
    const outsiderHistory = await api(outsiderToken, 'GET', `/api/chat/messages?senderId=${admin.id}&receiverId=${peer.id}`);
    const outsiderDeep = await api(outsiderToken, 'GET', `/api/chat/messages/${replyId}`);
    pass('outsider cannot read conversation or direct reply', outsiderHistory.status === 403 && outsiderDeep.status === 404);

    const anotherQuestion = await api(adminToken, 'POST', '/api/chat/messages', {
      senderId: admin.id, receiverId: peer.id, content: 'Сколько систем ещё раз?', guideRequest: true,
    });
    const secondRequestId = String(anotherQuestion.json?.id || '');
    const simultaneous = await Promise.all([1, 2].map(() => api(adminToken, 'POST', '/api/guide/chat-reply', {
      type: 'DIRECT', conversationId: peer.id, requestMessageId: secondRequestId, projectId,
    })));
    const secondReplyId = simultaneous.find((result) => result.json?.replyId)?.json?.replyId;
    const replyCount = db.prepare('SELECT COUNT(*) AS n FROM GuideReply WHERE requestMessageId = ?').get(secondRequestId)?.n;
    pass('simultaneous retries create one reply tied to the exact request', !!secondReplyId && replyCount === 1, { statuses: simultaneous.map((x) => x.status), count: replyCount });
    const peerQuestion = await api(peerToken, 'POST', '/api/chat/messages', {
      senderId: peer.id, receiverId: admin.id, content: 'Покажи сводку', guideRequest: true,
    });
    const spoof = await api(outsiderToken, 'POST', '/api/guide/chat-reply', {
      type: 'DIRECT', conversationId: admin.id, requestMessageId: String(peerQuestion.json?.id || ''),
      senderId: admin.id,
    });
    pass('request sender cannot be spoofed from request body', spoof.json?.published === false && !spoof.json?.replyId, spoof.json);
    const wrongConversation = await api(adminToken, 'POST', '/api/guide/chat-reply', {
      type: 'DIRECT', conversationId: outsider.id, requestMessageId: requestId, projectId,
    });
    pass('request cannot be rebound to a different direct conversation', wrongConversation.json?.published === false && !wrongConversation.json?.replyId);
    const numericQuestion = await api(adminToken, 'POST', '/api/chat/messages', {
      senderId: admin.id, receiverId: peer.id, content: 'Какой расход воздуха от 1000 до 1200 м³/ч?', guideRequest: true,
    });
    const numericAnswer = await api(adminToken, 'POST', '/api/guide/chat-reply', {
      type: 'DIRECT', conversationId: peer.id, requestMessageId: String(numericQuestion.json?.id || ''), projectId,
    });
    pass('F numeric interval applies both inclusive bounds and returns only the matching component', String(numericAnswer.json?.text || '').includes('FAN_HIGH') && !String(numericAnswer.json?.text || '').includes('FAN_LOW'), numericAnswer.json?.text);
    const convertedQuestion = await api(adminToken, 'POST', '/api/chat/messages', {
      senderId: admin.id, receiverId: peer.id, content: 'Расход воздуха от 300 до 333,34 л/с', guideRequest: true,
    });
    const convertedAnswer = await api(adminToken, 'POST', '/api/guide/chat-reply', {
      type: 'DIRECT', conversationId: peer.id, requestMessageId: String(convertedQuestion.json?.id || ''), projectId,
    });
    pass('F converts both interval bounds from litres per second', String(convertedAnswer.json?.text || '').includes('FAN_HIGH') && !String(convertedAnswer.json?.text || '').includes('FAN_LOW'), convertedAnswer.json?.text);
    const reversedQuestion = await api(adminToken, 'POST', '/api/chat/messages', {
      senderId: admin.id, receiverId: peer.id, content: 'Расход воздуха от 1200 до 1000 м³/ч', guideRequest: true,
    });
    const reversedAnswer = await api(adminToken, 'POST', '/api/guide/chat-reply', {
      type: 'DIRECT', conversationId: peer.id, requestMessageId: String(reversedQuestion.json?.id || ''), projectId,
    });
    pass('F asks for corrected endpoints instead of silently using a reversed interval', /нижняя граница/i.test(String(reversedAnswer.json?.text || '')), reversedAnswer.json?.text);
    const incompatibleQuestion = await api(adminToken, 'POST', '/api/chat/messages', {
      senderId: admin.id, receiverId: peer.id, content: 'Расход воздуха от 1 до 2 кПа', guideRequest: true,
    });
    const incompatibleAnswer = await api(adminToken, 'POST', '/api/guide/chat-reply', {
      type: 'DIRECT', conversationId: peer.id, requestMessageId: String(incompatibleQuestion.json?.id || ''), projectId,
    });
    pass('F rejects a pressure unit for airflow instead of comparing incompatible quantities', /не подходит к характеристике/.test(String(incompatibleAnswer.json?.text || '')), incompatibleAnswer.json?.text);

    const numericParams = new URLSearchParams({ field: 'Расход воздуха', min: '1000', max: '1200', unit: 'м³/ч' });
    const boundedSpec = await api(adminToken, 'GET', `/api/guide/project/${projectId}/spec?${numericParams}`);
    pass('Guide spec API includes values on both interval endpoints', boundedSpec.json?.total === 1 && boundedSpec.json?.items?.[0]?.itemCode === `FAN_HIGH`, boundedSpec.json);
    const endpointParams = new URLSearchParams({ field: 'Расход воздуха', min: '900', max: '900', unit: 'м³/ч' });
    const endpointSpec = await api(adminToken, 'GET', `/api/guide/project/${projectId}/spec?${endpointParams}`);
    pass('Guide spec interval includes an exact value shared by both endpoints', endpointSpec.json?.total === 1 && endpointSpec.json?.items?.[0]?.itemCode === 'FAN_LOW', endpointSpec.json);
    const convertedParams = new URLSearchParams({ field: 'Расход воздуха', min: '300', max: '333.34', unit: 'л/с' });
    const convertedSpec = await api(adminToken, 'GET', `/api/guide/project/${projectId}/spec?${convertedParams}`);
    pass('Guide spec interval converts both bounds from litres per second', convertedSpec.json?.total === 1 && convertedSpec.json?.items?.[0]?.itemCode === 'FAN_HIGH', convertedSpec.json);
    const reversedParams = new URLSearchParams({ field: 'Расход воздуха', min: '1200', max: '1000', unit: 'м³/ч' });
    const reversedSpec = await api(adminToken, 'GET', `/api/guide/project/${projectId}/spec?${reversedParams}`);
    pass('Guide spec API rejects a reversed interval instead of returning a misleading selection', reversedSpec.status === 400 && reversedSpec.json?.code === 'invalid_range', reversedSpec.json);
    const mismatchedUnitParams = new URLSearchParams({ field: 'Расход воздуха', min: '1', max: '2', unit: 'кПа' });
    const mismatchedUnitSpec = await api(adminToken, 'GET', `/api/guide/project/${projectId}/spec?${mismatchedUnitParams}`);
    pass('Guide spec API rejects an interval unit incompatible with its characteristic', mismatchedUnitSpec.status === 400 && mismatchedUnitSpec.json?.code === 'invalid_unit', mismatchedUnitSpec.json);

    for (const socket of sockets) socket.close();
    sockets.length = 0;
    await stop();
    child = launch();
    await waitHealthy();
    const reopened = await api(peerToken, 'GET', `/api/chat/messages?senderId=${admin.id}&receiverId=${peer.id}`);
    pass('F reply persists and is visible after server close/reopen', reopened.status === 200 && reopened.json.some((m: any) => m.id === replyId));

    console.log('2. Group reply audience and per-message ACL revocation');
    const madeGroup = await api(adminToken, 'POST', '/api/chat/groups', { name: `Guide ${stamp}`, type: 'CUSTOM', memberIds: [peer.id] });
    const groupId = String(madeGroup.json?.group?.id || '');
    pass('synthetic group created for owner and member', madeGroup.status === 200 && !!groupId, madeGroup.status);
    const groupRequest = await api(peerToken, 'POST', '/api/chat/group-messages', {
      senderId: peer.id, groupId, content: 'Сколько систем?', guideRequest: true,
    });
    const groupRequestId = String(groupRequest.json?.id || '');
    const groupAnswer = await api(peerToken, 'POST', '/api/guide/chat-reply', {
      type: 'GROUP', conversationId: groupId, requestMessageId: groupRequestId, projectId,
    });
    const groupReplyId = String(groupAnswer.json?.replyId || '');
    pass('group F answer binds to stored request and project', !!groupReplyId && groupAnswer.json?.published, groupAnswer.json);
    const groupHistory = await api(adminToken, 'GET', `/api/chat/group-messages?groupId=${groupId}`);
    pass('other group member reads the answer after reopening history', groupHistory.status === 200 && groupHistory.json.some((m: any) => m.id === groupReplyId));
    const groupOutsider = await api(outsiderToken, 'GET', `/api/chat/group-messages?groupId=${groupId}`);
    pass('nonmember cannot read group F reply', groupOutsider.status === 403);

    const privateGroupResult = await api(adminToken, 'POST', '/api/chat/groups', {
      name: `Guide outsider ${stamp}`, type: 'CUSTOM', memberIds: [peer.id, outsider.id],
    });
    const privateGroupId = String(privateGroupResult.json?.group?.id || '');
    const privateQuestion = await api(adminToken, 'POST', '/api/chat/group-messages', {
      senderId: admin.id, groupId: privateGroupId, content: 'Сколько систем?', guideRequest: true,
    });
    const privateAnswer = await api(adminToken, 'POST', '/api/guide/chat-reply', {
      type: 'GROUP', conversationId: privateGroupId, requestMessageId: String(privateQuestion.json?.id || ''), projectId,
    });
    const privateReply = await api(adminToken, 'GET', `/api/chat/messages/${String(privateAnswer.json?.replyId || '')}`);
    pass('group containing an unauthorized project outsider gets only a generic refusal', privateAnswer.json?.refusal === true && !String(privateReply.json?.content || '').includes('Систем в проекте:') && !privateAnswer.json?.guideReply?.projectId, privateAnswer.json);

    const unknownQuestion = await api(adminToken, 'POST', '/api/chat/messages', {
      senderId: admin.id, receiverId: peer.id, content: 'Который час?', guideRequest: true,
    });
    const unknownAnswer = await api(adminToken, 'POST', '/api/guide/chat-reply', {
      type: 'DIRECT', conversationId: peer.id, requestMessageId: String(unknownQuestion.json?.id || ''), projectId,
    });
    pass('unknown F questions do not get fuzzy unrelated handbook matches', /нет точного ответа|проверенной справке/.test(String(unknownAnswer.json?.text || '')));

    const chatId = `guide_history_${stamp}`;
    const saved = await api(peerToken, 'PUT', `/api/guide/chats/${chatId}`, {
      projectId,
      title: 'Расход в системе П1',
      messages: [
        { id: 'u1', role: 'user', text: 'Сколько систем?', projectId },
        { id: 'a1', role: 'guide', text: 'Систем в проекте: 0', outcome: '0 систем', projectId, source: { label: 'Системы проекта', at: now }, table: { rows: [['secret']] } },
      ],
    });
    pass('Guide history saves for its owner', saved.status === 200, saved.status);
    const secondProjectId = `guide_project_b_${stamp}`;
    const addSecondProject = db.prepare('INSERT INTO Project (id, name, createdAt) VALUES (?, ?, ?)');
    addSecondProject.run(secondProjectId, `Guide project B ${stamp}`, now);
    db.prepare('INSERT INTO ProjectMember (id, projectId, userId, addedBy, addedAt) VALUES (?, ?, ?, ?, ?)')
      .run(`m_peer_b_${stamp}`, secondProjectId, peer.id, admin.id, now);
    const mixedChatId = `guide_mixed_${stamp}`;
    const mixedSaved = await api(peerToken, 'PUT', `/api/guide/chats/${mixedChatId}`, {
      projectId,
      title: 'Secrets from both projects',
      messages: [
        { id: 'a-q', role: 'user', text: 'SECRET_A question', projectId },
        { id: 'a-r', role: 'guide', text: 'SECRET_A answer', outcome: 'SECRET_A outcome', projectId, source: { label: 'SECRET_A source', at: now } },
        { id: 'b-q', role: 'user', text: 'VISIBLE_B question', projectId: secondProjectId },
        { id: 'b-r', role: 'guide', text: 'VISIBLE_B answer', outcome: 'VISIBLE_B outcome', projectId: secondProjectId, source: { label: 'VISIBLE_B source', at: now } },
      ],
    });
    pass('mixed-project transcript saves when owner can see both projects', mixedSaved.status === 200, mixedSaved.status);
    const ownerList = await api(peerToken, 'GET', '/api/guide/chats');
    const outsiderList = await api(outsiderToken, 'GET', '/api/guide/chats');
    const adminList = await api(adminToken, 'GET', '/api/guide/chats');
    pass('only the Guide chat owner sees active history, including admins', ownerList.json?.chats?.some((row: any) => row.id === chatId) && !outsiderList.json?.chats?.some((row: any) => row.id === chatId) && !adminList.json?.chats?.some((row: any) => row.id === chatId));
    const outsiderRead = await api(outsiderToken, 'GET', `/api/guide/chats/${chatId}`);
    const outsiderWrite = await api(outsiderToken, 'PUT', `/api/guide/chats/${chatId}`, { projectId, title: 'spoof', messages: [{ role: 'user', text: 'spoof', projectId }] });
    const adminRead = await api(adminToken, 'GET', `/api/guide/chats/${chatId}`);
    const adminArchive = await api(adminToken, 'POST', `/api/guide/chats/${chatId}/archive`);
    const adminRestore = await api(adminToken, 'POST', `/api/guide/chats/${chatId}/restore`);
    pass('other employee and admin cannot read, edit, archive, or restore owner history', outsiderRead.status === 404 && outsiderWrite.status === 403 && adminRead.status === 404 && adminArchive.status === 404 && adminRestore.status === 404);
    const searchMine = await api(peerToken, 'GET', '/api/guide/chats?q=расход');
    pass('owner search finds matching transcript text', searchMine.json?.chats?.some((row: any) => row.id === chatId));
    const archived = await api(peerToken, 'POST', `/api/guide/chats/${chatId}/archive`);
    const archiveList = await api(peerToken, 'GET', '/api/guide/chats?archived=1');
    const activeAfterArchive = await api(peerToken, 'GET', '/api/guide/chats');
    const outsiderArchiveList = await api(outsiderToken, 'GET', '/api/guide/chats?archived=1');
    const adminArchiveList = await api(adminToken, 'GET', '/api/guide/chats?archived=1');
    const blockedWrite = await api(peerToken, 'PUT', `/api/guide/chats/${chatId}`, { projectId, title: 'changed', messages: [{ role: 'user', text: 'x', projectId }] });
    pass('archive preserves row, isolates archive owner, filters active/archive, and blocks writes', archived.status === 200 && archiveList.json?.chats?.some((chat: any) => chat.id === chatId) && !activeAfterArchive.json?.chats?.some((chat: any) => chat.id === chatId) && !outsiderArchiveList.json?.chats?.some((chat: any) => chat.id === chatId) && !adminArchiveList.json?.chats?.some((chat: any) => chat.id === chatId) && blockedWrite.status === 409);
    const restored = await api(peerToken, 'POST', `/api/guide/chats/${chatId}/restore`);
    pass('owner restores archived Guide history', restored.status === 200);

    const revokeEvents = await openSocket(peerToken);
    db.prepare('DELETE FROM ProjectMember WHERE projectId = ? AND userId = ?').run(projectId, peer.id);
    await api(adminToken, 'POST', '/api/guide/chat-reply', {
      type: 'DIRECT', conversationId: peer.id, requestMessageId: requestId, projectId,
    });
    await wait(150);
    const revokedEvent = revokeEvents.find((message) => message.id === replyId);
    pass('socket resend after ACL revocation is sanitized for that viewer', !!revokedEvent && !String(revokedEvent.content).includes('Систем в проекте:') && String(revokedEvent.content).includes('недоступны'), revokedEvent?.content);
    const revoked = await api(peerToken, 'GET', `/api/chat/group-messages?groupId=${groupId}`);
    const hiddenAnswer = revoked.json?.find((message: any) => message.id === groupReplyId);
    pass('revoked project answer is sanitized in chat history', !!hiddenAnswer && !String(hiddenAnswer.content).includes('Систем в проекте:') && String(hiddenAnswer.content).includes('недоступны'), hiddenAnswer?.content);
    const revokedGuide = await api(peerToken, 'GET', `/api/guide/chats/${chatId}`);
    const safeMessages = revokedGuide.json?.chat?.messages || [];
    pass('revoked Guide transcript masks message, source, result table, and title', revokedGuide.status === 200 && revokedGuide.json?.chat?.title === 'Разговор по проекту' && safeMessages[1]?.source?.label === 'Источник недоступен' && !safeMessages[1]?.table && !String(safeMessages[1]?.text).includes('Систем в проекте'));
    const revokedSearch = await api(peerToken, 'GET', '/api/guide/chats?q=систем');
    pass('revoked transcript is excluded from scoped search', !revokedSearch.json?.chats?.some((chat: any) => chat.id === chatId));
    const mixed = await api(peerToken, 'GET', `/api/guide/chats/${mixedChatId}`);
    const mixedMessages = mixed.json?.chat?.messages || [];
    const mixedList = await api(peerToken, 'GET', '/api/guide/chats');
    const mixedSummary = mixedList.json?.chats?.find((row: any) => row.id === mixedChatId);
    const hiddenSearch = await api(peerToken, 'GET', '/api/guide/chats?q=secret_a');
    const visibleSearch = await api(peerToken, 'GET', '/api/guide/chats?q=visible_b');
    pass('mixed-project history sanitizes only revoked message scopes and source labels', mixed.status === 200 && mixed.json?.chat?.title === 'Разговор по проекту' && !String(mixedMessages[1]?.text).includes('SECRET_A') && mixedMessages[1]?.source?.label === 'Источник недоступен' && mixedMessages[3]?.text === 'VISIBLE_B answer' && mixedMessages[3]?.source?.label === 'VISIBLE_B source');
    pass('mixed-project summary and search use sanitized rows only', mixedSummary?.preview === 'VISIBLE_B outcome' && !hiddenSearch.json?.chats?.some((row: any) => row.id === mixedChatId) && visibleSearch.json?.chats?.some((row: any) => row.id === mixedChatId));

    await api(adminToken, 'DELETE', `/api/chat/groups/${groupId}`);
  } finally {
    for (const socket of sockets) socket.close();
    await stop();
    db?.close();
    if (dataDir) await rm(dataDir, { recursive: true, force: true });
  }
  console.log(failed ? `\n${failed} guide/server check(s) failed` : '\nGuide/server checks passed');
  process.exitCode = failed ? 1 : 0;
}

main().catch(async (error) => {
  console.error(error?.message || error);
  await stop();
  db?.close();
  if (dataDir) await rm(dataDir, { recursive: true, force: true });
  process.exitCode = 1;
});
