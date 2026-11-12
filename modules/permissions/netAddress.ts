/**
 * Полный адрес из `flux.net.fetch(url)` и проверка того, во что он разрешился.
 *
 * Разрешения `internet` и `lan` открывают не имя, а адрес, в который имя превратилось
 * (DNS): имя публичного сайта, которое хозяин домена направил на 192.168.0.1 или на
 * облачные метаданные, не должно получить доступ, о котором человек не знал. Поэтому
 * проверяются ВСЕ адреса имени, а соединение открывается с одним из проверенных
 * (electron/moduleNet.ts) — между проверкой и соединением имя не успеет получить другой.
 *
 * Правила (классы адресов — modules/connections/address.ts):
 * - публичный адрес — нужно `internet`;
 * - частная сеть (10/8, 172.16/12, 192.168/16, 100.64/10, fc00::/7 и др.) — нужно `lan`;
 * - петля (127/8, ::1), «этот компьютер», 0.0.0.0, link-local с метаданными облака,
 *   широковещательные и групповые — закрыты всегда: петля открывается только явным
 *   подключением `connections` с адресом-литералом, а не разрешением сети.
 */
import { isIP } from 'node:net';
import { addressClass, unwrapMapped } from '../connections/address';

export interface FetchTarget { scheme: 'http' | 'https'; host: string; port: number; /** Путь вместе с запросом */ path: string }
export interface NetGrants { internet: boolean; lan: boolean }

/** Метаданные облаков вне link-local 169.254/16: Alibaba, Oracle, AWS по IPv6 — закрыты даже внутри частной сети */
const METADATA = new Set(['100.100.100.200', '192.0.0.192', 'fd00:ec2::254']);

/** Разбор адреса: только http(s), без учётных данных и фрагмента, без управляющих знаков; иначе null */
export function parseFetchUrl(raw: unknown): FetchTarget | null {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 2048 || /[\u0000- \\]/.test(raw)) return null;
  let url: URL;
  try { url = new URL(raw); } catch { return null; }
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password || url.hash || raw.includes('#')) return null;
  const scheme = url.protocol === 'http:' ? 'http' : 'https';
  const port = url.port ? Number(url.port) : scheme === 'http' ? 80 : 443;
  // IPv6 в URL приходит в квадратных скобках; для проверки и соединения нужен чистый адрес
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!host || !Number.isInteger(port) || port < 1 || port > 65535) return null;
  return { scheme, host, port, path: `${url.pathname}${url.search}` || '/' };
}

/** Можно ли подключаться к этому адресу при таких разрешениях */
export function netAddressAllowed(address: string, grants: NetGrants): boolean {
  const ip = unwrapMapped(address);
  if (METADATA.has(ip.toLowerCase())) return false;
  const cls = addressClass(ip);
  if (cls === 'public') return grants.internet;
  if (cls === 'private') return grants.lan;
  return false;
}

/** Адрес для соединения либо null: имя пустое, адресов нет или хотя бы один из них не разрешён */
export async function pickNetAddress(target: FetchTarget, grants: NetGrants, lookup: (host: string) => Promise<string[]>): Promise<{ address: string; family: 4 | 6 } | null> {
  // «localhost» и всё под ним — этот компьютер, что бы ни ответил резолвер (hosts-файл, прокси, чужой DNS)
  if (target.host === 'localhost' || target.host.endsWith('.localhost')) return null;
  const addresses = isIP(target.host) ? [target.host] : await lookup(target.host);
  // Все адреса обязаны быть допустимыми: имя с одним внутренним адресом среди публичных не должно проходить из-за порядка ответа
  if (!addresses.length || !addresses.every(a => netAddressAllowed(a, grants))) return null;
  const address = unwrapMapped(addresses[0]);
  return { address, family: isIP(address) === 6 ? 6 : 4 };
}
