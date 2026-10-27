/**
 * Поиск почтового сервера по адресу.
 *
 * Подсказка по домену угадывает `imap.<домен>` — и для Гугла с Яндексом это
 * верно, а для почты предприятия почти всегда нет. Человек вводил рабочий
 * адрес, получал «Адрес сервера не найден. Проверьте, правильно ли написан
 * адрес IMAP» и упирался: он-то адрес написал правильно — свой, а не сервера.
 * Про сервер он не знает ничего и знать не должен.
 *
 * Поэтому вместо одной догадки перебираются несколько имён, какими почтовые
 * серверы называют в девяти случаях из десяти, и проверяется, какое из них
 * ОТВЕЧАЕТ. Проверяется соединением, а не именем: имя может разрешаться в
 * заглушку провайдера, а порт при этом молчать.
 *
 * Порядок кандидатов — правило, и его проверяет скрипт
 * (scripts/test-mail-discover.ts): перебор не должен начинаться с редкого
 * варианта, иначе человек ждёт лишние секунды на каждом подключении.
 */
import net from 'net';
import tls from 'tls';

export interface Candidate {
  host: string;
  port: number;
  secure: boolean;
}

/**
 * Имена, под которыми ищут сервер. Порядок — от самого частого к редкому:
 * каждая неудачная попытка стоит человеку секунд ожидания.
 */
export function imapCandidates(domain: string): Candidate[] {
  const d = String(domain || '').toLowerCase().trim().replace(/^@/, '');
  if (!d || !d.includes('.')) return [];
  return [
    { host: `imap.${d}`, port: 993, secure: true },
    { host: `mail.${d}`, port: 993, secure: true },
    { host: d, port: 993, secure: true },
    // Незашифрованный порт — последним и только потому, что у почты
    // предприятия внутри сети он встречается до сих пор
    { host: `mail.${d}`, port: 143, secure: false },
    { host: d, port: 143, secure: false },
  ];
}

/** То же для отправки: у SMTP свои привычные порты */
export function smtpCandidates(domain: string): Candidate[] {
  const d = String(domain || '').toLowerCase().trim().replace(/^@/, '');
  if (!d || !d.includes('.')) return [];
  return [
    { host: `smtp.${d}`, port: 465, secure: true },
    { host: `mail.${d}`, port: 465, secure: true },
    { host: `smtp.${d}`, port: 587, secure: false },
    { host: `mail.${d}`, port: 587, secure: false },
    { host: d, port: 25, secure: false },
  ];
}

/**
 * Шифрование по порту, когда человек его не указал.
 *
 * Форма присылает только порты, а серверы подставляются по домену и подбору:
 * Outlook отдаёт SMTP на 587, подбор находит IMAP на 143. Если всё равно
 * ставить SSL «по умолчанию», такой ящик не подключится вовсе — на этих
 * портах шифрование начинается командой STARTTLS, а не с первого байта.
 */
export function defaultImapSecure(port: number): boolean {
  return Number(port) !== 143;
}
export function defaultSmtpSecure(port: number): boolean {
  return Number(port) === 465;
}

/** Домен из адреса; пустая строка — адрес не похож на адрес */
export function domainOf(email: string): string {
  const at = String(email || '').lastIndexOf('@');
  if (at < 0) return '';
  return email.slice(at + 1).toLowerCase().trim();
}

/**
 * Отвечает ли узел на этом порту.
 *
 * Именно соединением: разрешение имени говорит только о том, что имя кому-то
 * принадлежит. У многих провайдеров любое несуществующее имя разрешается в
 * страницу-заглушку, и проверка «имя нашлось» соврала бы.
 */
export function probe(c: Candidate, timeoutMs = 4000): Promise<boolean> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (ok: boolean, socket?: net.Socket) => {
      if (done) return;
      done = true;
      try { socket?.destroy(); } catch (_) { /* уже закрыт */ }
      resolve(ok);
    };
    try {
      const socket = c.secure
        ? tls.connect({ host: c.host, port: c.port, servername: c.host, rejectUnauthorized: false })
        : net.connect({ host: c.host, port: c.port });
      const timer = setTimeout(() => finish(false, socket), timeoutMs);
      const good = () => { clearTimeout(timer); finish(true, socket); };
      socket.once(c.secure ? 'secureConnect' : 'connect', good);
      socket.once('error', () => { clearTimeout(timer); finish(false, socket); });
      socket.once('timeout', () => { clearTimeout(timer); finish(false, socket); });
    } catch (_) {
      finish(false);
    }
  });
}

export interface Found {
  imap: Candidate | null;
  smtp: Candidate | null;
  /** Что сказать человеку, если ничего не нашлось */
  why: string;
}

/**
 * Найти сервер для адреса. Кандидаты одного назначения пробуются по порядку
 * и по одному: параллельная проверка пяти узлов выглядит быстрее, но у почты
 * предприятия лишние соединения нередко упираются в защиту от перебора.
 */
export async function discover(email: string, timeoutMs = 4000): Promise<Found> {
  const domain = domainOf(email);
  if (!domain || !domain.includes('.')) {
    return { imap: null, smtp: null, why: 'Адрес не похож на почтовый: в нём нет домена после «@».' };
  }
  // Входящие и исходящие ищутся одновременно: это разные порты, и защита от
  // перебора их не путает, а подбор вместо сорока секунд укладывается в двадцать
  const first = async (list: Candidate[]): Promise<Candidate | null> => {
    for (const c of list) {
      if (await probe(c, timeoutMs)) return c;
    }
    return null;
  };
  const [imap, smtp] = await Promise.all([
    first(imapCandidates(domain)),
    first(smtpCandidates(domain)),
  ]);
  const why = imap
    ? ''
    : `Ни один из привычных адресов сервера для «${domain}» не ответил. `
      + 'Спросите у того, кто заводил вам почту: адрес сервера входящих (IMAP) и порт. '
      + 'Их можно вписать вручную — раскройте «Настройки серверов».';
  return { imap, smtp, why };
}
