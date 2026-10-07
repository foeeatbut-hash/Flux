import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NATIVE_SHELL_SCRIPT } from './nativeShellSource';
import { WindowsFilesError } from './filesystem/paths';

export interface NativeHostOptions {
  /** Для проверок: подставной процесс вместо Windows PowerShell. Без него запускается настоящий помощник. */
  command?: string; args?: string[];
  platform?: string;
  startupMs?: number; requestMs?: number; idleMs?: number;
}
interface Pending { id: number; line: string; timeoutMs: number; resolve: (value: unknown) => void; reject: (error: unknown) => void }

const MAX_LINE = 32 * 1024 * 1024;

/**
 * Долгоживущий процесс нативного помощника. Запросы идут по одному (помощник
 * однопоточный, STA — этого требует COM Оболочки), ответы приходят строками JSON.
 *
 * Зависший вызов Оболочки отменить нельзя: расширение стороннего производителя
 * может повесить поток навсегда. Поэтому по истечении времени процесс убивается,
 * а следующий запрос поднимает новый. Так один «плохой» файл не отнимает
 * миниатюры и меню у всех остальных, а сбой не уходит дальше процесса-помощника.
 */
export class NativeShellHost {
  private child: ChildProcessWithoutNullStreams | null = null;
  private ready: Promise<void> | null = null;
  private directory: string | null = null;
  private queue: Pending[] = [];
  private current: { request: Pending; timer: ReturnType<typeof setTimeout> } | null = null;
  private sequence = 0;
  /** Запрос взят из очереди и ещё не завершён — в том числе пока поднимается процесс. */
  private busy = false;
  private buffer = '';
  private stderr = '';
  private idle: ReturnType<typeof setTimeout> | null = null;
  private failures: number[] = [];
  private closed = false;
  constructor(private options: NativeHostOptions = {}) {}

  private get platform() { return this.options.platform ?? process.platform; }
  get running() { return !!this.child; }

  /** Выполняет команду помощника и возвращает её данные. Ошибка помощника — WindowsFilesError с кодом NATIVE_*. */
  call(command: string, args: Record<string, unknown> = {}, timeoutMs?: number): Promise<any> {
    if (this.platform !== 'win32' && !this.options.command) return Promise.reject(new WindowsFilesError('NOT_WINDOWS', 'Эта возможность доступна только в Windows.'));
    if (this.closed) return Promise.reject(new WindowsFilesError('NATIVE_CLOSED', 'Помощник Windows остановлен.'));
    // Прокрутка сетки значков может поставить сотни миниатюр сразу; очередь длиннее — признак того, что помощник завис.
    if (this.queue.length >= 300) return Promise.reject(new WindowsFilesError('NATIVE_BUSY', 'Помощник Windows занят. Повторите через мгновение.'));
    return new Promise((resolve, reject) => {
      const id = ++this.sequence;
      this.queue.push({ id, line: JSON.stringify({ id, cmd: command, args }), timeoutMs: timeoutMs ?? this.options.requestMs ?? 15_000, resolve, reject });
      this.pump();
    });
  }

  private pump() {
    if (this.busy || !this.queue.length) return;
    this.busy = true;
    if (this.idle) { clearTimeout(this.idle); this.idle = null; }
    const request = this.queue.shift()!;
    void this.ensure().then(() => {
      if (!this.child) throw new WindowsFilesError('NATIVE_UNAVAILABLE', 'Помощник Windows не запущен.');
      const timer = setTimeout(() => this.timeout(request), request.timeoutMs);
      this.current = { request, timer };
      this.child.stdin.write(`${request.line}\n`, error => { if (error) this.fail(new WindowsFilesError('NATIVE_CRASHED', 'Помощник Windows оборвал связь.')); });
    }).catch(error => { this.busy = false; request.reject(error); this.pump(); });
  }

  private ensure(): Promise<void> {
    if (this.child && this.ready) return this.ready;
    const recent = this.failures.filter(at => Date.now() - at < 30_000);
    // Помощник, который трижды подряд не запустился (политика Windows запрещает PowerShell, нет .NET), не стоит опрашивать на каждую миниатюру.
    if (recent.length >= 3) return Promise.reject(new WindowsFilesError('NATIVE_UNAVAILABLE', 'Помощник Windows недоступен: политика компьютера или повреждённая установка. Повторите позже.'));
    this.ready = (async () => {
      let command = this.options.command; let args = this.options.args ?? [];
      if (!command) {
        this.directory = await mkdtemp(join(tmpdir(), 'flux-shell-host-'));
        const script = join(this.directory, 'host.ps1');
        // Windows PowerShell 5.1 распознаёт UTF-8 по BOM; код фиксирован и не содержит данных renderer.
        await writeFile(script, `﻿${NATIVE_SHELL_SCRIPT}`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
        command = 'powershell.exe';
        args = ['-NoLogo', '-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass', '-File', script];
      }
      const child = spawn(command, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
      this.child = child; this.buffer = ''; this.stderr = '';
      child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
      child.stdout.on('data', chunk => this.onData(String(chunk)));
      child.stderr.on('data', chunk => { this.stderr = (this.stderr + chunk).slice(-4096); });
      child.stdin.on('error', () => undefined); // обрыв канала разбирается по событию exit
      child.on('exit', () => { if (this.child === child) this.onExit(); });
      child.on('error', () => { if (this.child === child) this.onExit(); });
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => { reject(new WindowsFilesError('NATIVE_UNAVAILABLE', 'Помощник Windows не успел запуститься.')); this.kill(); }, this.options.startupMs ?? 45_000);
        this.onReady = () => { clearTimeout(timer); resolve(); };
        this.onStartFailed = () => { clearTimeout(timer); reject(new WindowsFilesError('NATIVE_UNAVAILABLE', 'Помощник Windows не запустился. Файлы доступны без миниатюр и меню Windows.')); };
      });
    })().catch(error => { this.failures.push(Date.now()); this.ready = null; this.kill(); throw error; });
    return this.ready;
  }
  private onReady: (() => void) | null = null;
  private onStartFailed: (() => void) | null = null;
  private started = false;

  private onData(chunk: string) {
    this.buffer += chunk;
    if (this.buffer.length > MAX_LINE) { this.fail(new WindowsFilesError('NATIVE_CRASHED', 'Помощник Windows прислал слишком большой ответ.')); this.kill(); return; }
    for (let end = this.buffer.indexOf('\n'); end >= 0; end = this.buffer.indexOf('\n')) {
      const line = this.buffer.slice(0, end).replace(/\r$/u, ''); this.buffer = this.buffer.slice(end + 1);
      if (line) this.onLine(line);
    }
  }
  private onLine(line: string) {
    let message: any;
    try { message = JSON.parse(line); } catch { return; } // посторонняя строка (предупреждение PowerShell) не ломает обмен
    if (message?.ready === true && !this.started) { this.started = true; this.onReady?.(); return; }
    const current = this.current;
    if (!current || message?.id !== current.request.id) return; // ответ на уже отменённый запрос
    clearTimeout(current.timer); this.current = null; this.busy = false;
    if (message.ok === true) current.request.resolve(message.data);
    else {
      const code = typeof message.code === 'string' && /^[A-Z_]{1,40}$/u.test(message.code) ? message.code : 'HELPER_FAILED';
      const error = new WindowsFilesError(`NATIVE_${code}`, NATIVE_MESSAGES[code] ?? 'Windows не выполнила действие. Файлы не тронуты.');
      Object.assign(error, { nativeDiagnostic: { stage: message.stage, type: message.type, hresult: message.hresult } });
      current.request.reject(error);
    }
    this.afterRequest();
  }
  private afterRequest() {
    if (this.queue.length) { this.pump(); return; }
    // Помощник не нужен, пока им не пользуются: освобождается память и запущенный процесс PowerShell.
    this.idle = setTimeout(() => this.kill(), this.options.idleMs ?? 120_000); this.idle.unref?.();
  }
  private timeout(request: Pending) {
    if (this.current?.request !== request) return;
    this.current = null; this.busy = false; request.reject(new WindowsFilesError('NATIVE_TIMEOUT', 'Windows не ответила вовремя. Расширение оболочки могло зависнуть; повторите действие.'));
    this.kill(); this.pump();
  }
  private fail(error: WindowsFilesError) {
    const current = this.current; this.current = null;
    if (current) { this.busy = false; clearTimeout(current.timer); current.request.reject(error); }
  }
  private onExit() {
    const starting = !this.started; const diagnostic = this.stderr.match(/FLUX_SHELL_HOST_FAILED:([A-Za-z]{1,48}):([A-F0-9]{8})/u);
    this.child = null; this.ready = null; this.started = false;
    if (starting) this.onStartFailed?.();
    this.fail(new WindowsFilesError('NATIVE_CRASHED', 'Помощник Windows неожиданно завершился. Повторите действие.'));
    if (diagnostic) this.lastFailure = `${diagnostic[1]}:${diagnostic[2]}`;
    if (this.stderr) this.lastStderr = this.stderr;
    void this.cleanup();
    this.pump();
  }
  /** Тип и код сбоя запуска (без путей) — для журнала диагностики. */
  lastFailure = '';
  /** Хвост stderr последнего упавшего процесса: ошибка сборки C# видна только здесь. Человеку не показывается. */
  lastStderr = '';
  private kill() {
    const child = this.child; this.child = null; this.ready = null; this.started = false;
    if (this.idle) { clearTimeout(this.idle); this.idle = null; }
    if (child) { try { child.stdin.end(); } catch { /* уже закрыт */ } child.kill(); }
    void this.cleanup();
  }
  private async cleanup() {
    const directory = this.directory; this.directory = null;
    if (directory) await rm(directory, { recursive: true, force: true }).catch(() => undefined);
  }
  /** Остановка при выходе из программы: ожидающие запросы получают отказ, процесс не остаётся сиротой. */
  close() {
    this.closed = true;
    for (const request of this.queue.splice(0)) request.reject(new WindowsFilesError('NATIVE_CLOSED', 'Помощник Windows остановлен.'));
    this.fail(new WindowsFilesError('NATIVE_CLOSED', 'Помощник Windows остановлен.'));
    this.kill();
  }
}

const NATIVE_MESSAGES: Record<string, string> = {
  STA_REQUIRED: 'Помощник Windows запущен неверно.',
  MENU_EXPIRED: 'Меню устарело. Откройте его снова.',
  MENU_CHANGED: 'Меню изменилось. Откройте его снова.',
  HANDLER_NOT_FOUND: 'Программа больше не предлагается для этого файла.',
  BIN_ITEM_NOT_FOUND: 'Объект не найден в корзине Windows: его могли уже восстановить или удалить.',
  UNKNOWN_COMMAND: 'Помощник Windows не знает эту команду.',
  HELPER_FAILED: 'Windows не выполнила действие. Файлы не тронуты.',
};
