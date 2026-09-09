/**
 * Запись диагностики в файлы: очередь, ротация, уборка.
 *
 * Три вещи, которые здесь легко сделать неправильно и трудно заметить.
 *
 * Первая — предел. Очередь без потолка при шторме ошибок съедает память
 * процесса, а файлы без потолка съедают диск сотрудника. Поэтому потолков
 * четыре: по числу записей, по объёму очереди, по размеру файла и по объёму
 * всей папки. Отдельный запас отведён поломкам: иначе тысяча успешных запросов
 * вытеснит из очереди единственную ошибку, ради которой всё и писалось.
 *
 * Вторая — ротация. Проверять размер надо перед каждой строкой, а не перед
 * пачкой: одна пачка на пару мегабайт иначе переваливает порог целиком, и файл
 * вырастает вдвое против объявленного.
 *
 * Третья — уборка. Удаляем только файлы своего формата и только внутри своей
 * папки, и смотрим на них через lstat: ссылка, подложенная в папку, не должна
 * увести удаление куда-то ещё.
 *
 * Сбор не имеет права ни изменить результат операции, ни бросить свою ошибку —
 * поэтому каждый шаг здесь в своём try, а отказ диска превращается в счётчик,
 * а не в исключение.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { cleanFields } from '../event';
import { SCHEMA_VERSION, type EventName, type SafeFields } from '../contracts';
import { BoundedQueue, RateLimit, RepeatFilter, isFailure, passesMode, type Data } from '../policy';

/** Состояние записи. Показывается человеку в Настройках: потери должны быть видны. */
export interface SinkStatus {
  session: string;
  source: string;
  queued: number;
  queuedBytes: number;
  dropped: number;
  failures: number;
  written: number;
  bytesOnDisk: number;
  freeDiskBytes: number;
  detailed: boolean;
  detailedUntil: number;
  workerAlive: boolean;
}

export interface DiagnosticsSink {
  record<E extends EventName>(event: E, fields?: SafeFields<E>): void;
  status(): SinkStatus;
  flush(): Promise<void>;
  close(): Promise<void>;
  setDetailed(seconds: number): void;
}

/** Размер файла, после которого начинается следующий. */
const FILE_BYTES = 8 * 1024 * 1024;
/** Сколько всего диска отведено диагностике на установку. */
const TOTAL_BYTES = 128 * 1024 * 1024;
/** Сколько дней держим сырые файлы. Что раньше — то и срабатывает. */
const KEEP_DAYS = 7;
/** Ниже этого свободного места подробная запись прекращается. */
const FREE_FLOOR = 100 * 1024 * 1024;
/** Потолок очереди обычных событий: вместе с запасом поломок это 16 МиБ. */
const MAIN_ITEMS = 20000;
const MAIN_BYTES = 14 * 1024 * 1024;
/** Отдельный запас поломок: их не должен вытеснить поток успешных запросов. */
const FAIL_ITEMS = 1000;
const FAIL_BYTES = 2 * 1024 * 1024;
/** Больше этого числа событий в секунду от одного источника не пишем. */
const PER_SECOND = 1000;

/** Имя файла диагностики: источник, сеанс, номер части. */
const FILE_NAME = /^[a-z][a-z0-9-]{0,20}-[0-9a-f-]{36}-\d{6}\.jsonl$/;

const sizeOf = (text: string) => Buffer.byteLength(text, 'utf8');

export class FileWriter implements DiagnosticsSink {
  readonly session = randomUUID();
  private seq = 0;
  private readonly main = new BoundedQueue(MAIN_ITEMS, MAIN_BYTES);
  private readonly fails = new BoundedQueue(FAIL_ITEMS, FAIL_BYTES);
  private readonly rate: RateLimit;
  private readonly repeats = new RepeatFilter();
  private failures = 0;
  private written = 0;
  private part = 0;
  private bytes = 0;
  private bytesOnDisk = 0;
  private freeDisk = Number.MAX_SAFE_INTEGER;
  private detailedUntil = 0;
  private busy: Promise<void> | undefined;
  private buffer = '';
  private readonly timer: ReturnType<typeof setInterval>;

  constructor(
    readonly dir: string,
    readonly source: string,
    private readonly fileBytes = FILE_BYTES,
    private readonly totalBytes = TOTAL_BYTES,
    perSecond = PER_SECOND,
  ) {
    this.rate = new RateLimit(perSecond);
    this.timer = setInterval(() => { void this.flush(); }, 1000);
    if (typeof this.timer.unref === 'function') this.timer.unref();
  }

  /** Подробный режим на N секунд. Бесконечным он не бывает: он дорогой. */
  setDetailed(seconds: number): void {
    this.detailedUntil = seconds > 0 ? Date.now() + Math.min(seconds, 300) * 1000 : 0;
  }

  private get detailed(): boolean {
    // Кончилось место — подробности прекращаются, обычная запись остаётся:
    // именно при кончающемся диске ошибки и начинаются
    return this.detailedUntil > Date.now() && this.freeDisk > FREE_FLOOR;
  }

  record<E extends EventName>(event: E, fields?: SafeFields<E>): void {
    try {
      const now = Date.now();
      const data = cleanFields(event, fields as Record<string, unknown>);
      if (!data) return; // событие не объявлено — записать нечего
      if (!passesMode(event, data, this.detailed)) return;
      if (!this.repeats.accept(event, data, now)) return;
      const failure = isFailure(event, data);
      if (!failure && !this.rate.allow(now)) { this.main.countDropped(1); return; }
      this.put(event, data, failure);
    } catch (_) { this.failures++; }
  }

  private put(event: string, data: Data, failure: boolean): void {
    const line = `${JSON.stringify({
      v: SCHEMA_VERSION,
      time: new Date().toISOString(),
      session: this.session,
      seq: ++this.seq,
      source: this.source,
      event,
      data,
    })}\n`;
    (failure ? this.fails : this.main).push(line, sizeOf(line));
  }

  status(): SinkStatus {
    return {
      session: this.session,
      source: this.source,
      queued: this.main.length + this.fails.length,
      queuedBytes: this.main.size + this.fails.size,
      dropped: this.main.dropped + this.fails.dropped,
      failures: this.failures,
      written: this.written,
      bytesOnDisk: this.bytesOnDisk,
      freeDiskBytes: this.freeDisk,
      detailed: this.detailed,
      detailedUntil: this.detailedUntil,
      workerAlive: false,
    };
  }

  flush(): Promise<void> {
    if (this.busy) return this.busy;
    // Свёртки закрываются перед сбросом: иначе последняя серия повторов
    // потеряется при закрытии программы
    for (const agg of this.repeats.drain(Date.now())) this.put(agg.event, agg.data, false);
    if (!this.main.length && !this.fails.length) return Promise.resolve();
    // Поломки идут первыми: если запись оборвётся, они уже на диске
    const failed = this.fails.take();
    const normal = this.main.take();
    const lines = (failed.batch + normal.batch).split('\n').filter(Boolean).map((l) => `${l}\n`);
    const count = failed.count + normal.count;
    this.busy = this.write(lines)
      .then(() => { this.written += count; })
      .catch(() => { this.failures++; this.main.countDropped(count); })
      .finally(() => { this.busy = undefined; });
    return this.busy;
  }

  /** Порог проверяется перед каждой строкой: пачка не должна переваливать его целиком. */
  private async write(lines: string[]): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true });
    for (const line of lines) {
      const size = sizeOf(line);
      if (this.bytes > 0 && this.bytes + size > this.fileBytes) {
        await this.drop();
        this.part++;
        this.bytes = 0;
        await this.sweep();
      }
      this.buffer += line;
      this.bytes += size;
    }
    await this.drop();
    if (this.part === 0 && this.bytesOnDisk === 0) await this.sweep();
  }

  private async drop(): Promise<void> {
    if (!this.buffer) return;
    const batch = this.buffer;
    this.buffer = '';
    await fs.appendFile(path.join(this.dir, this.fileName()), batch, 'utf8');
  }

  private fileName(): string {
    return `${this.source}-${this.session}-${String(this.part).padStart(6, '0')}.jsonl`;
  }

  /**
   * Уборка: срок и общий объём. Считаем и удаляем только свои файлы, и только
   * то, на что смотрит lstat, — ссылка внутри папки не должна увести удаление
   * в чужое место.
   */
  private async sweep(): Promise<void> {
    try {
      const names = (await fs.readdir(this.dir)).filter((n) => FILE_NAME.test(n));
      const mine = this.fileName();
      const files: Array<{ name: string; bytes: number; at: number }> = [];
      for (const name of names) {
        try {
          const stat = await fs.lstat(path.join(this.dir, name));
          if (!stat.isFile()) continue;
          files.push({ name, bytes: stat.size, at: stat.mtimeMs });
        } catch (_) { /* файл исчез между чтением каталога и проверкой */ }
      }
      const oldest = Date.now() - KEEP_DAYS * 24 * 3600 * 1000;
      files.sort((a, b) => a.at - b.at);
      let total = files.reduce((sum, f) => sum + f.bytes, 0);
      for (const file of files) {
        const tooOld = file.at < oldest;
        const tooMuch = total > this.totalBytes;
        if (!tooOld && !tooMuch) break;
        if (file.name === mine) continue; // свой текущий не трогаем
        try { await fs.unlink(path.join(this.dir, file.name)); total -= file.bytes; } catch (_) { /* уже удалён */ }
      }
      this.bytesOnDisk = total;
      await this.checkFree();
    } catch (_) { this.failures++; }
  }

  private async checkFree(): Promise<void> {
    try {
      // statfs есть не везде: старый Node и часть файловых систем его не знают
      const stat = await (fs as unknown as { statfs?: (p: string) => Promise<{ bavail: number; bsize: number }> }).statfs?.(this.dir);
      if (stat) this.freeDisk = stat.bavail * stat.bsize;
    } catch (_) { /* не узнали — считаем, что место есть */ }
  }

  async close(): Promise<void> {
    clearInterval(this.timer);
    for (const agg of this.repeats.drain(Date.now(), true)) this.put(agg.event, agg.data, false);
    await this.flush();
    await this.flush(); // второй раз: первый мог застать занятую запись
  }
}
