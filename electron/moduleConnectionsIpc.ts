/**
 * Каналы IPC подключений и журнала программ.
 *
 * Вызывать их может только окно Flux (`trusted`); окно программы к IPC не
 * имеет доступа вовсе, а его сообщения доходят сюда через мост окна Flux, где
 * проверяются по схеме. Решение «разрешить» записывается только здесь и только
 * для подключения, объявленного в проверенном выпуске.
 */
import { ipcMain } from 'electron';
import { connectionsOf, describeConnection, grantKey } from '../modules/connections/model';
import { CONTRACT_VERSION } from '../modules/contract';
import { JOURNAL_CATEGORIES, JOURNAL_LEVELS, JOURNAL_LIMITS, type JournalCategory, type JournalLevel } from '../modules/journal/model';
import { trustedAuthSender } from './authStorage';
import type { ModuleConnections, VerifiedModule } from './moduleConnections';
import type { ModuleGrants } from './moduleGrants';
import type { ModuleProgramCalls } from './moduleProgramCalls';
import type { ModuleJournal } from './moduleJournal';

export interface ConnectionsHost {
  service: ModuleConnections;
  /** Обращения программ друг к другу (flux.programs.call): проверки и журнал */
  programs?: ModuleProgramCalls;
  grants: ModuleGrants;
  journal: ModuleJournal;
  resolve: (moduleId: string, version: string) => Promise<VerifiedModule | null>;
  /** Установленные программы, чьи выпуски проходят проверку: для списка «Разрешения» */
  installed: () => Promise<VerifiedModule[]>;
  userId: () => string;
  ready: Promise<unknown>;
  trusted?: (event: Electron.IpcMainInvokeEvent) => boolean;
}

const refuse = { ok: false, error: 'Доступно только окну Flux.' };
const str = (v: unknown, max = 160) => (typeof v === 'string' && v.length <= max ? v : '');

export function registerConnectionsIpc(host: ConnectionsHost) {
  const trusted = host.trusted ?? trustedAuthSender;
  const owners = new Set<number>();
  const ownerOf = (event: Electron.IpcMainInvokeEvent) => {
    const id = event.sender.id;
    if (!owners.has(id)) {
      owners.add(id);
      // Окно закрыто или перезагружено: всё, что программы в нём открыли, закрывается
      event.sender.once('destroyed', () => { owners.delete(id); void host.service.closeOwner(String(id)); });
    }
    return String(id);
  };

  ipcMain.handle('modules:connect', async (event, data: any) => {
    if (!trusted(event)) return { ok: false, code: 'DENIED' };
    await host.ready;
    return host.service.call(ownerOf(event), { moduleId: str(data?.moduleId, 64), version: str(data?.version, 40), session: str(data?.session, 160), connection: str(data?.connection, 40), call: data?.call });
  });
  /** Обращение по полному адресу (flux.net.fetch(url)): разрешение — `permissions` проверенного манифеста, решает главный процесс */
  ipcMain.handle('modules:net', async (event, data: any) => {
    if (!trusted(event)) return { ok: false, code: 'DENIED' };
    await host.ready;
    return host.service.net(ownerOf(event), { moduleId: str(data?.moduleId, 64), version: str(data?.version, 40), session: str(data?.session, 160), call: data?.call });
  });
  /** Обращение к другой программе: проверки и место в пределах (begin), затем итог и журнал (end); сам расчёт идёт в окне */
  ipcMain.handle('modules:program-begin', async (event, data: any) => {
    if (!trusted(event) || !host.programs) return { ok: false, code: 'FAILED' };
    await host.ready;
    return host.programs.begin({ moduleId: str(data?.moduleId, 64), version: str(data?.version, 40), call: data?.call });
  });
  ipcMain.handle('modules:program-end', async (event, data: any) => {
    if (!trusted(event) || !host.programs) return { ok: false };
    return { ok: host.programs.end({ ticket: str(data?.ticket, 40), outcome: str(data?.outcome, 40), bytesOut: data?.bytesOut }) };
  });
  ipcMain.handle('modules:connect-close', async (event, data: any) => {
    if (!trusted(event)) return refuse;
    await host.service.closeSession(ownerOf(event), str(data?.session));
    return { ok: true };
  });

  /** Решение человека. Подключение берётся из проверенного выпуска, а не из слов окна */
  ipcMain.handle('modules:grant', async (event, data: any) => {
    if (!trusted(event)) return refuse;
    await host.ready;
    const decision = String(data?.decision);
    if (!['always', 'once', 'never', 'ask'].includes(decision)) return { ok: false, error: 'Неизвестное решение.' };
    const verified = await host.resolve(str(data?.moduleId, 64), str(data?.version, 40));
    const decl = verified && connectionsOf(verified.manifest).find(c => c.id === str(data?.connection, 40));
    if (!verified || !decl || !host.userId()) return { ok: false, error: 'Такого подключения у проверенной программы нет.' };
    await host.grants.decide(host.userId(), verified.manifest.id, decl.id, grantKey(decl), `${ownerOf(event)}:${str(data?.session)}`, decision as 'always');
    host.journal.add({ moduleId: verified.manifest.id, version: verified.version, userId: host.userId(), category: 'permission', level: 'info', event: 'grant',
      detail: `${describeConnection(decl)} · ${decl.access}`, outcome: decision, ms: 0, bytesIn: 0, bytesOut: 0 });
    return { ok: true };
  });

  /** Список для страницы программы и настроек: что объявлено, что решено, что запрещено политикой */
  ipcMain.handle('modules:grants', async event => {
    if (!trusted(event)) return refuse;
    await host.ready;
    const user = host.userId();
    const rows = [];
    for (const item of await host.installed()) {
      for (const decl of connectionsOf(item.manifest)) {
        const state = host.grants.state(user, item.manifest.id, decl.id, grantKey(decl), '');
        rows.push({ moduleId: item.manifest.id, moduleName: item.manifest.name, version: item.version, connection: decl.id, app: decl.app, does: decl.does,
          access: decl.access, technical: describeConnection(decl), state, byPolicy: host.grants.isDeniedByPolicy(item.manifest.id, decl.id) });
      }
    }
    return { ok: true, rows, contract: CONTRACT_VERSION };
  });
  ipcMain.handle('modules:grants-reset', async (event, data: any) => {
    if (!trusted(event)) return refuse;
    await host.ready;
    await host.grants.resetAll(host.userId(), str(data?.moduleId, 64) || undefined);
    return { ok: true };
  });
  /** Политика администратора приходит с сервера через окно; она только запрещает, поэтому подделка окна не расширяет доступ */
  ipcMain.handle('modules:policy', async (event, data: any) => {
    if (!trusted(event)) return refuse;
    host.grants.setPolicy(Array.isArray(data?.denied) ? data.denied.filter((d: any) => typeof d?.moduleId === 'string' && typeof d?.connection === 'string') : []);
    return { ok: true };
  });

  // ── Журнал ──
  ipcMain.handle('modules:journal-add', async (event, data: any) => {
    if (!trusted(event)) return refuse;
    await host.ready;
    const user = host.userId();
    let accepted = 0;
    for (const e of (Array.isArray(data?.entries) ? data.entries : []).slice(0, 50)) {
      if (!JOURNAL_CATEGORIES.includes(e?.category as JournalCategory) || !JOURNAL_LEVELS.includes(e?.level as JournalLevel)) continue;
      // Подключения и решения пишет главный процесс сам: окно не может «дописать» себе чужие события
      if (e.category === 'connection' || e.category === 'permission') continue;
      const verified = await host.resolve(str(e.moduleId, 64), str(e.version, 40));
      if (!verified) continue;
      if (host.journal.add({ moduleId: verified.manifest.id, version: verified.version, userId: user, category: e.category, level: e.level, event: String(e.event ?? ''), detail: String(e.detail ?? '').slice(0, JOURNAL_LIMITS.detail),
        outcome: String(e.outcome ?? ''), ms: Number(e.ms) || 0, bytesIn: Number(e.bytesIn) || 0, bytesOut: Number(e.bytesOut) || 0 }, 'window')) accepted++;
    }
    return { ok: true, accepted };
  });
  ipcMain.handle('modules:journal-pending', async event => {
    if (!trusted(event)) return refuse;
    await host.ready;
    return { ok: true, entries: host.journal.pending() };
  });
  ipcMain.handle('modules:journal-ack', async (event, data: any) => {
    if (!trusted(event)) return refuse;
    host.journal.ack(Number(data?.upTo));
    return { ok: true };
  });
  ipcMain.handle('modules:journal-recent', async (event, data: any) => {
    if (!trusted(event)) return refuse;
    await host.ready;
    return { ok: true, entries: host.journal.recent(Math.min(500, Number(data?.limit) || 200)) };
  });
}
