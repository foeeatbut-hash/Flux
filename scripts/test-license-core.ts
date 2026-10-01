/**
 * Лицензия на сотрудников: запрос → ключ владельца → состояние человека.
 * Ключи здесь одноразовые, создаются в самом наборе.
 */
import crypto from 'crypto';
import {
  makeRequest, readRequest, signLicense, readLicense, personLicense, publicHexOf, WARN_DAYS,
} from '../license/node/core';

let ok = 0, fail = 0;
const eq = (name: string, got: any, want: any) => {
  const pass = JSON.stringify(got) === JSON.stringify(want);
  if (pass) ok++; else { fail++; console.log(`✗ ${name}\n   получено: ${JSON.stringify(got)}\n   ожидалось: ${JSON.stringify(want)}`); }
};

const owner = crypto.generateKeyPairSync('ed25519').privateKey;
const stranger = crypto.generateKeyPairSync('ed25519').privateKey;
const hex = publicHexOf(owner);
const DAY = 86400000;
const now = 1_900_000_000_000;

// Запрос
const req = makeRequest({ inst: 'inst-A', org: 'ООО Вент', people: [{ login: 'Ivanov', name: 'Иванов И.' }, { login: ' ', name: 'пусто' }], at: now });
const back = readRequest(req);
eq('запрос читается обратно', back?.inst, 'inst-A');
eq('пустые логины в запрос не попадают', back?.people.map((p) => p.login), ['Ivanov']);
eq('запрос с переносами строк читается', readRequest(req.replace(/(.{20})/g, '$1\n'))?.org, 'ООО Вент');
eq('мусор не читается как запрос', readRequest('FLUXREQ1.???'), null);

// Ключ
const key = signLicense({ inst: 'inst-A', org: 'ООО Вент', logins: ['Ivanov', 'PETROV', 'ivanov'], exp: now + 90 * DAY }, owner);
const p = readLicense(key, hex);
eq('ключ владельца принимается', !!p, true);
eq('логины в ключе без повторов и в нижнем регистре', p?.logins, ['ivanov', 'petrov']);
eq('ключ чужим закрытым ключом не принимается', readLicense(signLicense({ inst: 'inst-A', org: '', logins: ['ivanov'], exp: now + DAY }, stranger), hex), null);
const [pre, body, sig] = key.split('.');
const forged = JSON.parse(Buffer.from(body.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString());
forged.logins.push('hacker'); forged.exp += 3650 * DAY;
const forgedBody = Buffer.from(JSON.stringify(forged)).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
eq('дописанный в ключ логин или срок ломает подпись', readLicense(`${pre}.${forgedBody}.${sig}`, hex), null);
eq('старый код FLUX1 не выдаётся за новый ключ', readLicense('FLUX1.abc.def', hex), null);

// Состояние человека
const keys = [p!];
eq('Иванов с лицензией', personLicense('IVANOV', 'inst-A', keys, now).licensed, true);
eq('дней осталось', personLicense('ivanov', 'inst-A', keys, now).daysLeft, 90);
eq('без предупреждения, пока далеко', personLicense('ivanov', 'inst-A', keys, now).warn, false);
eq('предупреждение за две недели', personLicense('ivanov', 'inst-A', keys, now + (90 - WARN_DAYS) * DAY).warn, true);
eq('после срока — истекла', personLicense('ivanov', 'inst-A', keys, now + 91 * DAY).reason, 'expired');
eq('чужого логина нет в ключе', personLicense('sidorov', 'inst-A', keys, now).reason, 'none');
eq('ключ другой установки не подходит', personLicense('ivanov', 'inst-B', keys, now).reason, 'other_install');
const longer = readLicense(signLicense({ inst: 'inst-A', org: '', logins: ['ivanov'], exp: now + 400 * DAY }, owner), hex)!;
eq('из двух ключей берётся более длинный', personLicense('ivanov', 'inst-A', [p!, longer], now).daysLeft, 400);

console.log(`\n${ok} проверок пройдено, ${fail} провалено`);
process.exit(fail ? 1 : 0);
