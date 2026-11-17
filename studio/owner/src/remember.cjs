'use strict';
/**
 * Что Studio владельца помнит между запусками, чтобы не спрашивать одно и то же:
 * адрес общей базы и пароль хранилища ключей.
 *
 * Оба значения секретные (в адресе пароль базы, пароль открывает закрытые ключи подписи), поэтому на диск
 * они попадают только зашифрованными защитой учётной записи Windows (Electron safeStorage, DPAPI): другая
 * учётная запись и другой компьютер их не расшифруют. Если защищённого хранилища нет (на Linux Electron
 * молча пишет открытым текстом, `basic_text`), не запоминается ничего: удобство не стоит открытого пароля.
 *
 * Когда пароль спрашивается снова:
 *  - прошли сутки с прошлого ввода;
 *  - компьютер заблокирован (главный процесс зовёт `forgetPassword` по событию ОС);
 *  - владелец сам нажал «Запереть» или «Забыть сохранённое»;
 *  - сохранённый пароль больше не открывает хранилище (его сменили на другом компьютере).
 * Адрес базы сроков не имеет: он нужен каждый раз, когда подключаются, и защищён так же.
 *
 * Без Electron: защищённое хранилище, время и папка приходят параметрами — проверяет
 * scripts/test-studio-owner-console.ts.
 */
const fs = require('node:fs');
const path = require('node:path');

const DAY = 24 * 3600 * 1000;

function createRemember({ dir, storage, now = Date.now, ttl = DAY }) {
  const file = path.join(dir, 'remembered.json');
  const usable = () => {
    try { return !!storage?.isEncryptionAvailable() && storage.getSelectedStorageBackend?.() !== 'basic_text'; } catch { return false; }
  };
  const read = () => {
    try { const data = JSON.parse(fs.readFileSync(file, 'utf8')); return data?.v === 1 ? data : { v: 1 }; } catch { return { v: 1 }; }
  };
  const write = data => {
    if (!data.server && !data.password) { fs.rmSync(file, { force: true }); return; }
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    // Через временный файл: оборванная запись не оставит половину JSON и не сотрёт то, что было
    const temp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(data), { mode: 0o600 });
    fs.renameSync(temp, file);
  };
  const seal = text => storage.encryptString(text).toString('base64');
  const open = secret => { try { return storage.decryptString(Buffer.from(secret, 'base64')); } catch { return ''; } };

  const api = {
    /** Можно ли запоминать на этом компьютере вообще */
    available: usable,

    /** Запомнить адрес базы; false — защищённого хранилища нет, ничего не записано */
    rememberServer(uri, display) {
      if (!usable() || typeof uri !== 'string' || !uri) return false;
      const data = read();
      data.server = { display: String(display || '').slice(0, 200), secret: seal(uri) };
      write(data); return true;
    },
    /** Запомненный адрес: {uri, display} либо null (нет, не расшифровался в этой учётной записи) */
    server() {
      if (!usable()) return null;
      const s = read().server;
      const uri = s ? open(s.secret) : '';
      return uri ? { uri, display: s.display || '' } : null;
    },
    /** Что показать на экране, не трогая секрет: «сервер/база» без пароля */
    serverDisplay() { return read().server?.display || ''; },

    /** Запомнить пароль хранилища на сутки с этого мгновения */
    rememberPassword(password) {
      if (!usable() || typeof password !== 'string' || !password) return false;
      const data = read();
      data.password = { secret: seal(password), at: now() };
      write(data); return true;
    },
    /** Пароль, если срок не вышел; пустая строка — спросить человека. Просроченный пароль стирается сразу */
    password() {
      if (!usable()) return '';
      const saved = read().password;
      if (!saved) return '';
      if (!(now() - saved.at < ttl) || saved.at > now() + 60_000) { api.forgetPassword(); return ''; }
      return open(saved.secret);
    },
    /** До какого времени пароль не спросят; 0 — не запомнен */
    passwordUntil() { const saved = read().password; return saved && api.password() ? saved.at + ttl : 0; },

    forgetPassword() { const data = read(); if (data.password) { delete data.password; write(data); } },
    forgetServer() { const data = read(); if (data.server) { delete data.server; write(data); } },
    forgetAll() { fs.rmSync(file, { force: true }); },

    /** Состояние для окна: без секретов */
    info() { return { available: usable(), server: api.serverDisplay(), keptUntil: api.passwordUntil() }; },
  };
  return api;
}

module.exports = { createRemember, DAY };
