/**
 * Почта: подключение и отправка — то, что ломалось незаметно.
 *
 * Здесь собраны проверки найденных при разборе дефектов, каждая с причиной:
 *
 *  1. Шифрование, не названное явно, определяется портом. Форма шлёт только
 *     порты; на 143 и 587 SSL «по умолчанию» не работает вовсе.
 *  2. Копия в «Отправленные» берётся из письма, которое мы сами собрали и
 *     передали серверу. Раньше её брали из ответа nodemailer, где её нет, и
 *     копия не клалась никогда. Здесь письмо уходит на поддельный SMTP-сервер.
 *  3. Скрытые получатели доходят в конверте, но не видны в тексте письма.
 *  4. Тексты отказов говорят про пару «порт — шифрование», а не только про
 *     «закрытый порт»: это самая частая ошибка настройки.
 *  5. Вложение исходящего письма берётся только из каталогов почты.
 *  6. Два вложения с одним именем не затирают друг друга на диске.
 *
 * Запуск: npx tsx scripts/test-mail-send.ts
 */
import net from 'net';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  deliver, smtpTransportOptions, explainSmtp, verifySmtp,
} from '../server/mail/send';
import { defaultImapSecure, defaultSmtpSecure } from '../server/mail/discover';
import { explainError } from '../server/mail/imap';
import { attachmentFile } from '../server/mail/attachFile';
import { attachable } from '../server/routes/mailCompose';

let failed = 0;
const check = (name: string, cond: boolean, got?: unknown) => {
  if (cond) return;
  failed++;
  console.error(`  ✗ ${name}${got === undefined ? '' : ` — получили ${JSON.stringify(got)}`}`);
};

/** Поддельный SMTP-сервер: запоминает конверт и текст письма. */
interface Seen { rcpt: string[]; from: string; data: string; auth: boolean }
function fakeSmtp(rejectRcpt = ''): Promise<{ port: number; seen: Seen; close: () => void }> {
  const seen: Seen = { rcpt: [], from: '', data: '', auth: false };
  const server = net.createServer((sock) => {
    let buf = '';
    let inData = false;
    let wantAuth = false;
    sock.write('220 fake ESMTP\r\n');
    sock.on('data', (chunk) => {
      buf += chunk.toString('utf-8');
      for (;;) {
        if (inData) {
          const end = buf.indexOf('\r\n.\r\n');
          if (end < 0) return;
          seen.data = buf.slice(0, end);
          buf = buf.slice(end + 5);
          inData = false;
          sock.write('250 queued\r\n');
          continue;
        }
        const nl = buf.indexOf('\r\n');
        if (nl < 0) return;
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 2);
        if (wantAuth) { wantAuth = false; seen.auth = true; sock.write('235 ok\r\n'); continue; }
        if (/^EHLO/i.test(line)) sock.write('250-fake\r\n250 AUTH PLAIN\r\n');
        else if (/^AUTH PLAIN$/i.test(line)) { wantAuth = true; sock.write('334 \r\n'); }
        else if (/^AUTH PLAIN /i.test(line)) { seen.auth = true; sock.write('235 ok\r\n'); }
        else if (/^MAIL FROM/i.test(line)) { seen.from = line; sock.write('250 ok\r\n'); }
        else if (/^RCPT TO/i.test(line)) {
          if (rejectRcpt && line.includes(rejectRcpt)) { sock.write('550 no such user\r\n'); continue; }
          seen.rcpt.push(line.replace(/^RCPT TO:\s*<?|>?\s*$/gi, '').toLowerCase());
          sock.write('250 ok\r\n');
        } else if (/^DATA/i.test(line)) { inData = true; sock.write('354 go\r\n'); }
        else if (/^QUIT/i.test(line)) { sock.write('221 bye\r\n'); sock.end(); }
        else sock.write('250 ok\r\n');
      }
    });
    sock.on('error', () => { /* клиент ушёл */ });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ port: (server.address() as net.AddressInfo).port, seen, close: () => server.close() });
    });
  });
}

async function main() {
  console.log('Шифрование по порту');
  {
    check('993 — SSL', defaultImapSecure(993) === true);
    check('143 — без SSL с первого байта', defaultImapSecure(143) === false);
    check('465 — SSL', defaultSmtpSecure(465) === true);
    check('587 — STARTTLS', defaultSmtpSecure(587) === false);
    check('25 — без SSL', defaultSmtpSecure(25) === false);
  }

  console.log('Параметры соединения SMTP');
  {
    const t = { connection: 1, socket: 1 };
    const base = { smtpHost: 'mail.corp.test', login: 'l', password: 'p' };
    const starttls = smtpTransportOptions({ ...base, smtpPort: 587, smtpSecure: false }, t);
    // Без этого сервер, не предложивший STARTTLS, получил бы пароль открытым текстом
    check('на 587 шифрование обязательно', starttls.requireTLS === true);
    check('на порту 25 без SSL шифрование тоже обязательно', smtpTransportOptions({ ...base, smtpHost: 'mail.corp.test', smtpPort: 25, smtpSecure: false }, t).requireTLS === true);
    check('на 465 SSL', smtpTransportOptions({ ...base, smtpPort: 465, smtpSecure: true }, t).secure === true);
    check('на 465 requireTLS не нужен', smtpTransportOptions({ ...base, smtpPort: 465, smtpSecure: true }, t).requireTLS === false);
    check('порт 0 не уходит серверу', smtpTransportOptions({ ...base, smtpPort: 0, smtpSecure: true }, t).port === 465);
    check('порт 0 без SSL — 587', smtpTransportOptions({ ...base, smtpPort: 0, smtpSecure: false }, t).port === 587);
  }

  console.log('Отправка: письмо уходит и копия получается');
  {
    const srv = await fakeSmtp('bad@');
    const sent = await deliver(
      { smtpHost: '127.0.0.1', smtpPort: srv.port, smtpSecure: false, login: 'u', password: 'p' },
      {
        from: { name: 'Иванов И.И.', address: 'ivanov@example.ru' },
        to: ['petrov@example.ru', 'bad@example.ru'],
        cc: ['copy@example.ru'],
        bcc: ['secret@example.ru'],
        subject: 'Смета',
        html: '<p>Здравствуйте</p>',
        text: 'Здравствуйте',
        attachments: [{ filename: 'a.txt', path: __filename }],
        headers: { 'In-Reply-To': '<orig@x>', References: '<orig@x>' },
      },
    );
    srv.close();
    const raw = sent.raw.toString('utf-8');
    check('копия для «Отправленных» собрана', sent.raw.length > 100, sent.raw.length);
    check('в копии есть Message-ID', /^Message-ID:/im.test(raw));
    check('и он тот же, что вернули', raw.toLowerCase().includes(sent.messageId.toLowerCase()), sent.messageId);
    check('цепочка ответа в копии', /^In-Reply-To: <orig@x>/im.test(raw));
    check('вложение в копии', /filename="?a\.txt/i.test(raw));
    // Скрытый получатель не должен быть виден в письме, но обязан получить его
    check('скрытый получатель не виден в тексте', !/secret@example\.ru/i.test(raw));
    check('скрытый получатель в конверте', srv.seen.rcpt.includes('secret@example.ru'), srv.seen.rcpt);
    check('получатель в копии в конверте', srv.seen.rcpt.includes('copy@example.ru'));
    check('основной получатель в конверте', srv.seen.rcpt.includes('petrov@example.ru'));
    check('отвергнутый адрес не теряется молча', sent.rejected.some((a) => a.includes('bad@example.ru')), sent.rejected);
    check('отправитель в конверте — адрес ящика', /ivanov@example\.ru/.test(srv.seen.from), srv.seen.from);
    check('сервер получил письмо', srv.seen.data.includes('Смета') || /Subject:/i.test(srv.seen.data));
    check('вошли с паролем', srv.seen.auth === true);
  }

  console.log('Проверка SMTP: понятные отказы');
  {
    const none = await verifySmtp({ smtpHost: '', smtpPort: 465, smtpSecure: true, login: 'a', password: 'b' });
    check('пустой сервер назван', !none.ok && none.error.includes('SMTP'), none);
    // Порт, где никто не слушает: ответ должен быть понятным, а не сырым ECONNREFUSED
    const dead = await new Promise<number>((r) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = (s.address() as net.AddressInfo).port; s.close(() => r(p)); }); });
    const refused = await verifySmtp({ smtpHost: '127.0.0.1', smtpPort: dead, smtpSecure: false, login: 'a', password: 'b' });
    check('закрытый порт объяснён', !refused.ok && /порт/i.test(refused.error) && !/ECONNREFUSED/.test(refused.error), refused);
  }

  console.log('Тексты отказов SMTP');
  {
    check('несовпадение порта и шифрования подсказано',
      /465.*587/.test(explainSmtp({ code: 'ETIMEDOUT', message: 'Greeting never received' })));
    check('ошибка протокола — та же подсказка',
      /465.*587/.test(explainSmtp({ code: 'ESOCKET', message: 'ssl3_get_record:wrong version number' })));
    check('сертификат не выдаётся за таймаут',
      explainSmtp({ code: 'ESOCKET', message: 'self-signed certificate' }).includes('сертификат'));
    check('неизвестное имя сервера', explainSmtp({ code: 'EDNS', message: 'getaddrinfo ENOTFOUND smtp.x.ru' }).includes('не найден'));
    check('слишком большое письмо', explainSmtp({ response: '552 5.3.4 Message size exceeds fixed limit' }).includes('большое'));
    check('номер 535 не ловится внутри чужого числа', !explainSmtp({ message: 'Размер 15350 байт' }).includes('пароль'));
    check('нет STARTTLS — сказано прямо', explainSmtp({ message: 'Server did not offer STARTTLS' }).includes('STARTTLS'));
  }

  console.log('Тексты отказов IMAP');
  {
    check('обрыв при несовпадении шифрования', /993.*143/.test(explainError({ message: 'write EPROTO wrong version number' })));
    check('сброс соединения', /993.*143/.test(explainError({ code: 'ECONNRESET', message: 'read ECONNRESET' })));
    check('таймаут называет порты', /993.*143/.test(explainError({ message: 'Greeting timeout' })));
    check('неверный пароль', explainError({ authenticationFailed: true, responseText: 'Invalid credentials (Failure)' }).includes('пароль'));
    check('сертификат', explainError({ message: 'self signed certificate' }).includes('сертификат'));
    check('пароль в тексте ошибки не выдумывается', !explainError({ message: 'x' }).includes('undefined'));
  }

  console.log('Вложения на диске');
  {
    const a = attachmentFile('/data', 'acc', 'msg', 'att-1', 'image.png');
    const b = attachmentFile('/data', 'acc', 'msg', 'att-2', 'image.png');
    check('одинаковые имена — разные файлы', a !== b, [a, b]);
    check('лежат в каталоге письма', path.dirname(a) === path.join('/data', 'mail_files', 'acc', 'msg'), a);
    const tricky = attachmentFile('/data', 'acc', 'msg', 'att-3', '../../etc/passwd');
    check('имя с обходом каталога остаётся внутри письма', path.dirname(tricky) === path.join('/data', 'mail_files', 'acc', 'msg'), tricky);
    check('пустое имя заменяется', attachmentFile('/d', 'a', 'm', 'i', '').endsWith('_файл'));
  }

  console.log('Какие файлы можно вложить в исходящее письмо');
  {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'flux-mail-'));
    try {
      fs.mkdirSync(path.join(root, 'mail_files', 'a'), { recursive: true });
      fs.mkdirSync(path.join(root, 'mail_out'), { recursive: true });
      const ok1 = path.join(root, 'mail_files', 'a', 'x.pdf');
      const ok2 = path.join(root, 'mail_out', 'y.pdf');
      const bad = path.join(root, 'mail.key');
      fs.writeFileSync(ok1, '1'); fs.writeFileSync(ok2, '2'); fs.writeFileSync(bad, 'secret');
      check('файл вложений почты проходит', attachable(root, ok1));
      check('файл исходящих проходит', attachable(root, ok2));
      // Ключ шифрования паролей лежит рядом с базой — наружу его отдавать нельзя
      check('ключ шифрования не проходит', !attachable(root, bad));
      check('обход через ../ не проходит', !attachable(root, path.join(root, 'mail_out', '..', 'mail.key')));
      check('системный файл не проходит', !attachable(root, '/etc/passwd'));
      check('несуществующий не проходит', !attachable(root, path.join(root, 'mail_out', 'nope')));
      const link = path.join(root, 'mail_out', 'link');
      try {
        fs.symlinkSync(bad, link);
        check('ссылка наружу не проходит', !attachable(root, link));
      } catch (_) { /* ссылки недоступны — пропуск */ }
      check('сам каталог не проходит', !attachable(root, path.join(root, 'mail_out')));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }

  if (failed) {
    console.error(`\nПровалено проверок: ${failed}`);
    process.exit(1);
  }
  console.log('\nВсё сошлось.');
}

main().catch((err) => { console.error(err); process.exit(1); });
