'use strict';
/**
 * Запросы разделов владельца (запросы на публикацию, сертификаты, обновления) к локальному
 * серверу Flux. Токен владельца живёт только в главном процессе; окно называет маршрут, а
 * этот список решает, можно ли. Сервер всё равно проверяет владельца сам.
 */
const http = require('node:http');
const https = require('node:https');
const { serverUrl } = require('./network.cjs');

const ID = '[A-Za-z0-9_-]{1,100}';
/** [метод, шаблон маршрута]: ничего, кроме того, что нужно разделам владельца */
const ROUTES = [
  ['GET', /^\/api\/modules\/requests$/],
  ['GET', new RegExp(`^/api/modules/requests/${ID}$`)],
  ['GET', new RegExp(`^/api/modules/requests/${ID}/(?:bundle|diff)$`)],
  ['POST', new RegExp(`^/api/modules/requests/${ID}/(?:return|reject|release)$`)],
  ['POST', /^\/api\/modules\/requests$/],
  ['GET', /^\/api\/modules\/(?:releases|certificates|testers|me)$/],
  ['PUT', /^\/api\/modules\/testers$/],
  ['POST', /^\/api\/modules\/(?:revocations|certificates|promotions|pins)$/],
  ['GET', /^\/api\/modules\/certificate-requests$/],
  ['POST', /^\/api\/modules\/certificate-requests\/decline$/],
  ['GET', /^\/api\/updates\/devices$/],
  ['POST', /^\/api\/updates\/campaigns$/],
];
const routeAllowed = (method, route) => typeof route === 'string' && route.length < 300 && ROUTES.some(([m, re]) => m === method && re.test(route));
const MAX_RESPONSE = 24 * 1024 * 1024;

/** Ответ JSON либо байты (`binary`): пакет программы приходит как есть */
function consoleRequest(origin, method, route, { body = null, token = '', binary = false, signal = null } = {}) {
  if (!routeAllowed(method, route)) return Promise.reject(new Error('Маршрут недоступен разделу владельца.'));
  if (!token) return Promise.reject(new Error('Подключитесь к общей БД компании.'));
  const base = serverUrl(origin), url = new URL(route, base), transport = url.protocol === 'https:' ? https : http;
  const json = body === null ? null : Buffer.from(JSON.stringify(body));
  return new Promise((resolve, reject) => {
    const headers = { Accept: binary ? 'application/octet-stream' : 'application/json', Authorization: `Bearer ${token}` };
    if (json) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = json.length; }
    const req = transport.request(url, { method, headers, timeout: 60000 }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400) { res.resume(); return reject(new Error('Перенаправление сервера отклонено.')); }
      const chunks = []; let size = 0;
      res.on('data', chunk => { size += chunk.length; if (size > MAX_RESPONSE) { req.destroy(); reject(new Error('Ответ сервера слишком велик.')); } else chunks.push(chunk); });
      res.on('end', () => {
        const data = Buffer.concat(chunks);
        if (res.statusCode < 200 || res.statusCode >= 300) {
          let message = `Ошибка сервера ${res.statusCode}.`;
          try { const parsed = JSON.parse(data.toString('utf8')); if (typeof parsed.error === 'string') message = parsed.error.slice(0, 1000); } catch { /* тело не JSON */ }
          return reject(Object.assign(new Error(message), { status: res.statusCode }));
        }
        if (binary) return resolve(new Uint8Array(data));
        try { resolve(JSON.parse(data.toString('utf8'))); } catch { reject(new Error('Сервер вернул неверный формат ответа.')); }
      });
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('Сервер не ответил вовремя.')));
    req.on('error', reject);
    signal?.addEventListener('abort', () => req.destroy(new Error('Операция отменена.')), { once: true });
    req.end(json || undefined);
  });
}
module.exports = { routeAllowed, consoleRequest };
