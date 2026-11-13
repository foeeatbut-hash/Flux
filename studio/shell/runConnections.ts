/**
 * Подключения запущенной программы к внешним программам в Studio: HTTP, WebSocket и COM.
 *
 * Не второй вариант кода, а тот же: проверки, пределы и вызовы делает `ModuleConnections` Flux (electron/moduleConnections.ts):
 * объявление берётся из `connections` манифеста запущенного проекта и разбирается заново, адрес проверяется после разрешения
 * имени, COM вне белого списка и опасный без `allowDangerous` отказывают, пределы частоты и числа открытых — те же константы.
 * Отличия от Flux только вокруг: решения человека живут в памяти (`ModuleGrants(null)` — файл grants.json Flux не читается и не
 * пишется), журнал — в памяти (RunJournal), вопрос задаёт окно Studio событием, политики администратора в Studio нет.
 *
 * Ответ человека привязан к тексту разрешения (grantKey): после правки адреса или доступа в манифесте вопрос задаётся заново.
 * «Всегда» и «не разрешать» помнятся до закрытия Studio, «только сейчас» — до закрытия запуска.
 */
import { randomUUID } from 'node:crypto';
import type { ModuleManifest } from '../../modules/contract';
import { connectionsOf, grantKey, type ConnectCall, type ConnectErrorCode, type GrantAsk } from '../../modules/connections/model';
import { ModuleConnections, type VerifiedModule } from '../../electron/moduleConnections';
import { ModuleGrants } from '../../electron/moduleGrants';
import { defaultComBackend, type ComBackend } from '../../electron/moduleCom';
import type { Lookup } from '../../electron/moduleNet';
import { CONNECT_DECISIONS, type ConnectDecision, type RunConnectReply, type RunEvent } from '../shared/runActions';
import type { RunJournal } from './runJournal';

/** Запущенная программа, как её видят подключения: идентификатор запуска и манифест проекта */
export interface RunContext { id: string; manifest: ModuleManifest }

export interface RunConnectionsDeps {
  current: () => RunContext | null;
  emit: (event: RunEvent) => void;
  journal: RunJournal;
  /** Помощник COM; по умолчанию — как во Flux (Windows PowerShell, на других системах COM недоступен); проверки подставляют поддельный */
  com?: () => ComBackend;
  lookup?: Lookup;
  /** Сколько ждать ответа человека, мс; не ответил — «не разрешено» без запоминания */
  askTimeoutMs?: number;
}

/** Человек сидит за Studio один, и «пользователь» запуска — он: ключ решений не зависит от входа в общую базу */
const USER = 'studio';
const OWNER = 'studio';
export const ASK_WAIT_MS = 5 * 60_000;

/** Строка для журнала запуска: что именно не так и что делать, словами; содержимого вызова в ней нет */
export function connectLine(code: ConnectErrorCode, connection: string): string {
  const name = `подключение «${connection.slice(0, 40)}»`;
  switch (code) {
    case 'DENIED': return `${name}: отказ — оно не объявлено в connections манифеста, вызов не подходит к объявлению (вид, путь, адрес, белый список COM, allowDangerous) или имеет неверную форму`;
    case 'NOT_ALLOWED': return `${name}: не разрешено — человек отказал в этом запуске или не ответил. Политики администратора в Studio нет: во Flux подключение может запретить и администратор`;
    case 'LIMIT': return `${name}: предел — слишком частые, большие или одновременные вызовы либо слишком много открытых подключений (пределы те же, что во Flux)`;
    case 'TIMEOUT': return `${name}: время вызова вышло`;
    case 'TARGET': return `${name}: адрес не прошёл проверку (закрытый или не тот, что объявлен); проверьте url в manifest.json`;
    case 'UNAVAILABLE': return `${name}: недоступно — COM есть только на Windows, а HTTP и WebSocket не ответили`;
    default: return `${name}: вызов не удался`;
  }
}

interface Question { id: string; key: string; runId: string; resolve: (decision: ConnectDecision | null) => void; timer: ReturnType<typeof setTimeout> }

export class RunConnections {
  private readonly grants = new ModuleGrants(null);
  private readonly service: ModuleConnections;
  private readonly questions = new Map<string, Question>();
  /** Один вопрос на подключение: параллельные вызовы ждут общий ответ, а не складывают окна друг на друга */
  private readonly asking = new Map<string, Promise<ConnectDecision | null>>();

  constructor(private readonly deps: RunConnectionsDeps) {
    this.service = new ModuleConnections({
      resolve: async (moduleId, version): Promise<VerifiedModule | null> => {
        const run = this.deps.current();
        // Манифест запущенного проекта — единственный источник объявления; выпуска и подписи у пробного запуска нет, поэтому verifiedAt = 0
        return run && run.manifest.id === moduleId && String(run.manifest.version) === version
          ? { manifest: run.manifest, version, author: String(run.manifest.author ?? ''), verifiedAt: 0 } : null;
      },
      userId: () => USER,
      grants: this.grants,
      journal: deps.journal,
      comFor: deps.com ?? (() => defaultComBackend()),
      lookup: deps.lookup,
    });
  }

  async call(args: { connection?: unknown; call?: unknown }): Promise<RunConnectReply> {
    const run = this.deps.current();
    if (!run) return { ok: false, code: 'DENIED', line: 'подключение: программа не запущена' };
    const connection = typeof args.connection === 'string' && args.connection.length <= 40 ? args.connection : '';
    const request = { moduleId: run.manifest.id, version: String(run.manifest.version), session: run.id, connection, call: args.call as ConnectCall };
    const refuse = (code: ConnectErrorCode): RunConnectReply => ({ ok: false, code, line: connectLine(code, connection) });
    let reply = await this.service.call(OWNER, request);
    if ('ask' in reply) {
      const { ask } = reply;
      // Вопрос строится по манифесту запущенного проекта, а не по словам окна: окно присылает только ответ
      const decl = connectionsOf(run.manifest).find(c => c.id === ask.connection);
      const decision = decl ? await this.ask(run.id, ask) : null;
      // Запуск закрыт или заменён, пока человек думал: ответ относится к уже не существующему запуску
      if (!decl || !decision || this.deps.current()?.id !== run.id) return refuse('NOT_ALLOWED');
      await this.grants.decide(USER, run.manifest.id, decl.id, grantKey(decl), `${OWNER}:${run.id}`, decision);
      reply = await this.service.call(OWNER, request);
    }
    if (!('code' in reply)) return { ok: true, data: reply.data };
    // После записанного решения вопроса быть не должно; если он всё же вернулся, это отказ, а не бесконечный вопрос
    return refuse(reply.code === 'ASK' ? 'NOT_ALLOWED' : reply.code);
  }

  private ask(runId: string, ask: GrantAsk): Promise<ConnectDecision | null> {
    const key = `${runId}:${ask.connection}`;
    const existing = this.asking.get(key);
    if (existing) return existing;
    const promise = new Promise<ConnectDecision | null>(resolve => {
      const id = randomUUID();
      const timer = setTimeout(() => this.settle(id, null), this.deps.askTimeoutMs ?? ASK_WAIT_MS);
      timer.unref?.();
      this.questions.set(id, { id, key, runId, resolve, timer });
      this.deps.emit({ kind: 'connectAsk', id, ask });
    });
    this.asking.set(key, promise);
    return promise;
  }

  private settle(id: string, decision: ConnectDecision | null): boolean {
    const q = this.questions.get(id);
    if (!q) return false;
    clearTimeout(q.timer);
    this.questions.delete(id);
    this.asking.delete(q.key);
    this.deps.emit({ kind: 'connectAskClose', id });
    q.resolve(decision);
    return true;
  }

  /** Ответ человека из окна. false — вопроса уже нет (снят, истёк или на него уже ответили) */
  answer(id: unknown, decision: unknown): boolean {
    if (typeof id !== 'string' || !(CONNECT_DECISIONS as readonly unknown[]).includes(decision)) return false;
    return this.settle(id, decision as ConnectDecision);
  }

  /** Запуск закрыт: вопросы снимаются, сокеты закрываются, объекты COM освобождаются, «только сейчас» кончилось */
  async closeRun(runId: string): Promise<void> {
    for (const q of [...this.questions.values()]) if (q.runId === runId) this.settle(q.id, null);
    await this.service.closeSession(OWNER, runId);
  }

  /** Выход из Studio: всё закрыто, помощник COM остановлен */
  async shutdown(): Promise<void> {
    for (const q of [...this.questions.values()]) this.settle(q.id, null);
    await this.service.shutdown();
  }
}
