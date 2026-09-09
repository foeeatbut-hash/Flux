/**
 * Два встроенных сервера на одной базе видят одно и то же.
 *
 * Это не выдуманный случай, а обычный режим работы отдела: у каждого сотрудника
 * своя копия программы со своим встроенным сервером, общая у них только база.
 * Отсюда всё устройство домена — вложения в базе, очередь уведомлений в базе,
 * предел частоты в базе. Проверить это можно только подняв второй сервер.
 *
 * Что здесь ловится: уведомление, отправленное сокетом «своим» окнам, до чужого
 * сервера не дойдёт никогда. Если бы доставка держалась на сокете, обработчик за
 * соседним столом просто не узнал бы об обращении.
 *
 * Нужен поднятый первый сервер: npx tsx server.ts
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { FEATURES } from '../src/lib/permissions';

const BASE = process.env.FLUX_API || 'http://localhost:3000';
const SECOND_PORT = Number(process.env.FLUX_SECOND_PORT || 3101);
const SECOND = `http://localhost:${SECOND_PORT}`;
const LOGIN = { symbol: process.env.FLUX_USER || 'RaupovKhKh', password: process.env.FLUX_PASS || '1122' };

let f = 0;
const ok = (name: string, cond: boolean, detail?: unknown) =>
  cond
    ? console.log('  ✓', name)
    : (f++, console.error('  ✗', name, detail !== undefined ? JSON.stringify(detail).slice(0, 300) : ''));

async function api(base: string, method: string, path: string, token: string, body?: any) {
  const res = await fetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  let json: any = {};
  try { json = text ? JSON.parse(text) : {}; } catch (_) { json = { raw: text.slice(0, 200) }; }
  return { status: res.status, json, text };
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function up(base: string, seconds = 90): Promise<boolean> {
  for (let n = 0; n < seconds; n++) {
    try {
      const r = await fetch(`${base}/api/health`);
      if (r.ok) return true;
    } catch (_) { /* ещё поднимается */ }
    await wait(1000);
  }
  return false;
}

async function main() {
  if (!(await up(BASE, 5))) {
    console.error(`Первый сервер на ${BASE} не отвечает. Поднимите его: npx tsx server.ts`);
    process.exit(2);
  }

  let second: ChildProcess | null = null;
  let authorId = '';
  try {
    console.log(`1. Поднимаем второй сервер на порту ${SECOND_PORT}`);
    second = spawn('npx', ['tsx', 'server.ts'], {
      cwd: process.cwd(),
      env: { ...process.env, PORT: String(SECOND_PORT) },
      stdio: 'ignore',
      detached: false,
    });
    ok('второй сервер отвечает', await up(SECOND), SECOND);
    if (f) throw new Error('второй сервер не поднялся');

    const stamp = Date.now().toString(36).slice(-6);
    const a = (await api(BASE, 'POST', '/api/login', '', LOGIN)).json?.token || '';
    const b = (await api(SECOND, 'POST', '/api/login', '', LOGIN)).json?.token || '';
    ok('вход прошёл на обоих', !!a && !!b);

    // Автор — отдельный сотрудник без права разбора: иначе он же и получатель,
    // а себе о своём действии уведомление не шлётся, и проверять было бы нечего
    const pass = `p${stamp}A!`;
    const perms: Record<string, any> = {};
    for (const feat of FEATURES) perms[feat.id] = { enabled: feat.id !== 'feedback.triage', until: null };
    const mk = await api(BASE, 'POST', '/api/users', a, {
      symbol: `fbm${stamp}`, name: 'Проба Двух Серверов', password: pass, role: 'USER',
      permissions: JSON.stringify(perms),
    });
    authorId = mk.json?.user?.id || mk.json?.id;
    const authorToken = (await api(BASE, 'POST', '/api/login', '', { symbol: `fbm${stamp}`, password: pass })).json?.token || '';
    ok('автор вошёл', !!authorToken, mk.json);

    const metaA = await api(BASE, 'GET', '/api/feedback/meta', a);
    const metaB = await api(SECOND, 'GET', '/api/feedback/meta', b);
    // Признак контура берётся из базы, а не из процесса: иначе черновики с
    // одной машины считались бы чужими на другой
    ok('признак контура у обоих один',
      metaA.json?.data?.deploymentId === metaB.json?.data?.deploymentId,
      [metaA.json?.data?.deploymentId, metaB.json?.data?.deploymentId]);

    console.log('\n2. Обращение, заведённое на первом, видно на втором');
    const made = await api(BASE, 'POST', '/api/feedback/reports', authorToken, {
      schemaVersion: 1, clientRequestId: randomUUID(), deploymentId: metaA.json?.data?.deploymentId,
      type: 'BUG', title: `__два сервера ${stamp}`,
      description: 'Обращение заведено на одном сервере, читается на другом.',
      sectionKey: '/sheet', incidentAt: new Date(Date.now() - 60000).toISOString(),
      appVersion: '1.1.0', frequency: 'ONCE', impact: 'NORMAL', uploadIds: [],
      consent: { technicalEvents: false, appContext: true, reviewedAt: new Date().toISOString() },
    });
    ok('карточка создана на первом', made.status === 201, made.json);
    const id = made.json?.data?.id;
    const onSecond = await api(SECOND, 'GET', `/api/feedback/reports/${id}`, b);
    ok('второй сервер её видит', onSecond.status === 200 && onSecond.json?.data?.id === id, onSecond.status);
    ok('и номер тот же', onSecond.json?.data?.number === made.json?.data?.number,
      [made.json?.data?.number, onSecond.json?.data?.number]);

    console.log('\n3. Ответ, данный на втором, виден на первом');
    const reply = await api(SECOND, 'POST', `/api/feedback/reports/${id}/comments`, b, {
      clientRequestId: randomUUID(), expectedRevision: onSecond.json?.data?.revision,
      text: `ответ со второго сервера ${stamp}`, visibility: 'PUBLIC',
    });
    ok('ответ записан', reply.status === 200, reply.json);
    const back = await api(BASE, 'GET', `/api/feedback/reports/${id}/comments`, a);
    ok('первый сервер его читает', String(back.text).includes(`ответ со второго сервера ${stamp}`),
      back.text.slice(0, 200));

    console.log('\n4. Уведомление доезжает через базу, а не через сокет');
    // Сокет второго сервера про окна первого не знает вовсе: если бы доставка
    // держалась на нём, обработчик за соседним столом ничего бы не получил
    // Обращение завёл рядовой сотрудник на первом сервере; уведомление
    // предназначено администратору и должно быть видно со ВТОРОГО
    const adminId = (await api(BASE, 'GET', '/api/feedback/meta', a)).status === 200
      ? (await api(BASE, 'POST', '/api/login', '', LOGIN)).json?.user?.id : '';
    let delivered = false;
    for (let n = 0; n < 25 && !delivered; n++) {
      await wait(1000);
      const notes = await api(SECOND, 'GET', `/api/notifications?userId=${adminId}`, b);
      delivered = JSON.stringify(notes.json).includes(id);
    }
    ok('уведомление появилось в базе и читается со второго сервера', delivered);

    const unread = await api(SECOND, 'GET', '/api/feedback/unread', b);
    ok('счётчик ждущих посчитан', unread.status === 200 && typeof unread.json?.data?.total === 'number', unread.json);
  } finally {
    if (second && !second.killed) { try { second.kill('SIGTERM'); } catch (_) { /* уже вышел */ } }
    await wait(500);
    if (authorId) {
      const a = (await api(BASE, 'POST', '/api/login', '', LOGIN)).json?.token || '';
      await api(BASE, 'DELETE', `/api/users/${authorId}`, a).catch(() => {});
    }
  }

  console.log(f === 0 ? '\nВСЕ ТЕСТЫ ПРОЙДЕНЫ' : `\nПРОВАЛОВ: ${f}`);
  process.exit(f === 0 ? 0 : 1);
}

void main().catch((error) => { console.error(error); process.exit(1); });
