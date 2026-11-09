/**
 * Какие адреса подпрограмме открыты: проверка уже РАЗРЕШЁННОГО имени.
 *
 * Имя из объявления проверяется по тому, во что оно превратилось (DNS), а не
 * по написанному: имя `api.example.com`, которое хозяин домена направил на
 * 127.0.0.1 или на облачный адрес метаданных, не должно открыть то, что
 * человек не разрешал. Подключаться затем нужно именно к проверенному адресу
 * (см. electron/moduleNet.ts), иначе между проверкой и подключением имя
 * успеет получить другой адрес.
 */
import { BlockList, isIP } from 'node:net';
import { explicitInternal, parseOrigin, type NetConnection } from './model';

const list = (subnets: Array<[string, number, 'ipv4' | 'ipv6']>) => {
  const out = new BlockList();
  for (const [net, prefix, family] of subnets) out.addSubnet(net, prefix, family);
  return out;
};
/** Не открывается никогда: «этот компьютер» как адрес назначения, метаданные облака, широковещание, группы */
const BLOCKED = list([['0.0.0.0', 8, 'ipv4'], ['169.254.0.0', 16, 'ipv4'], ['224.0.0.0', 4, 'ipv4'], ['240.0.0.0', 4, 'ipv4'],
  ['::', 128, 'ipv6'], ['fe80::', 10, 'ipv6'], ['ff00::', 8, 'ipv6']]);
const LOOPBACK = list([['127.0.0.0', 8, 'ipv4'], ['::1', 128, 'ipv6']]);
const PRIVATE = list([['10.0.0.0', 8, 'ipv4'], ['172.16.0.0', 12, 'ipv4'], ['192.168.0.0', 16, 'ipv4'], ['100.64.0.0', 10, 'ipv4'],
  ['fc00::', 7, 'ipv6'], ['fec0::', 10, 'ipv6'], ['64:ff9b::', 96, 'ipv6']]);

export type AddressClass = 'public' | 'loopback' | 'private' | 'blocked';

/** `::ffff:10.0.0.1` и `::ffff:a00:1` — это IPv4-адрес в обёртке: проверяется он, а не обёртка */
export function unwrapMapped(ip: string): string {
  const lower = ip.toLowerCase();
  const dotted = lower.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (dotted) return dotted[1];
  const hex = lower.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (hex) {
    const hi = parseInt(hex[1], 16), lo = parseInt(hex[2], 16);
    return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
  }
  return ip;
}

export function addressClass(raw: string): AddressClass {
  const ip = unwrapMapped(raw);
  const family = isIP(ip);
  if (!family) return 'blocked';
  const kind = family === 4 ? 'ipv4' : 'ipv6';
  if (BLOCKED.check(ip, kind)) return 'blocked';
  if (LOOPBACK.check(ip, kind)) return 'loopback';
  if (PRIVATE.check(ip, kind)) return 'private';
  return 'public';
}

/**
 * Можно ли подключаться к адресу, в который разрешилось имя из объявления.
 * Публичный — можно; loopback и внутренние — только если объявление само
 * сказало об этом (адрес-литерал, `localhost`, флаг `internal`).
 */
export function addressAllowed(decl: NetConnection, address: string): boolean {
  const cls = addressClass(address);
  if (cls === 'blocked') return false;
  if (cls === 'public') return true;
  const target = parseOrigin(decl.kind, decl.url);
  if (!target || !explicitInternal(decl)) return false;
  // `localhost` открывает только петлю, а не всю внутреннюю сеть
  if (target.host === 'localhost') return cls === 'loopback';
  // Литерал открывает ровно себя: проверка имени ниже не даст подменить его другим адресом
  if (isIP(target.host)) return unwrapMapped(target.host) === unwrapMapped(address);
  return true;
}

/** Результат разрешения имени: адреса, которые можно использовать, либо причина отказа */
export async function pickAddress(decl: NetConnection, lookup: (host: string) => Promise<string[]>): Promise<{ address: string; family: 4 | 6 } | null> {
  const target = parseOrigin(decl.kind, decl.url);
  if (!target) return null;
  const addresses = isIP(target.host) ? [target.host] : await lookup(target.host);
  // Все адреса имени обязаны быть допустимыми: иначе имя с одним внутренним адресом среди публичных обошло бы проверку при смене порядка
  if (!addresses.length || !addresses.every(a => addressAllowed(decl, a))) return null;
  const address = unwrapMapped(addresses[0]);
  return { address, family: isIP(address) === 6 ? 6 : 4 };
}
