/**
 * Очередь расчётов всех программ: сколько их идёт одновременно и кому
 * уступать место.
 *
 * Правила (решение владельца 7 ноября 2026: «работать легко для компьютера»):
 * - одновременно идёт не больше «ядра − 1», но не более 4 расчётов: хотя бы
 *   одно ядро остаётся Flux и остальным программам;
 * - расчёт открытого окна («active») идёт раньше фонового; фоновым («background»)
 *   всегда оставлен один свободный слот для открытого окна, а когда слот один —
 *   фоновый ждёт, пока не освободится;
 * - очередь ограничена, и одна программа не может занять её всю: переполнение
 *   — ошибка BUSY, а не рост памяти;
 * - пока расчётов нет, у очереди нет ни таймеров, ни опроса: она просыпается
 *   только от прихода или окончания расчёта (простой — 0 % процессора).
 *
 * Без DOM и Node. Приоритет потока ОС Worker'у из веба не задать, поэтому
 * «пониженный приоритет» — это эта очередь: фоновый расчёт занимает не больше
 * слотов, чем разрешено, и стартует, когда окно свободно (`waitIdle`).
 */
import { ComputeError } from './types';

export type Priority = 'active' | 'background';

export const MAX_QUEUE = 64;
export const MAX_PER_KEY = 8;

/** Сколько расчётов можно вести разом на компьютере с таким числом ядер */
export const slotsFor = (cores: number) => Math.max(1, Math.min(4, (Number.isFinite(cores) ? Math.floor(cores) : 1) - 1));

interface Waiting {
  priority: Priority; key: string; lane: string; start: () => void; reject: (e: ComputeError) => void;
}

export interface SchedulerOptions {
  slots: number;
  /** Не больше стольких расчётов разом на «полосу»: у Python одна среда на все программы — полоса 'python' равна 1 */
  laneLimits?: Record<string, number>;
  /** Дождаться, пока окно свободно (requestIdleCallback); для фоновых расчётов. По умолчанию — сразу */
  waitIdle?: () => Promise<void>;
}

export class ComputeScheduler {
  private running = 0;
  private runningBackground = 0;
  private queue: Waiting[] = [];
  private perKey = new Map<string, number>();
  private lanes = new Map<string, number>();
  /** Журнал последних запусков для проверок и диагностики: порядок и приоритет */
  readonly started: Array<{ key: string; priority: Priority }> = [];

  constructor(private options: SchedulerOptions) {}

  get slots() { return this.options.slots; }
  get backgroundSlots() { return this.options.slots > 1 ? this.options.slots - 1 : 1; }
  get stats() { return { running: this.running, queued: this.queue.length, runningBackground: this.runningBackground }; }

  /**
   * Поставить расчёт в очередь. `task` вызывается, когда есть слот; слот
   * освобождается при любом исходе, включая ошибку.
   */
  run<T>(priority: Priority, key: string, task: () => Promise<T>, lane = ''): Promise<T> {
    if (this.queue.length >= MAX_QUEUE || (this.perKey.get(key) ?? 0) >= MAX_PER_KEY) {
      return Promise.reject(new ComputeError('BUSY', 'очередь расчётов заполнена'));
    }
    this.perKey.set(key, (this.perKey.get(key) ?? 0) + 1);
    return new Promise<T>((resolve, reject) => {
      const entry: Waiting = {
        priority, key, lane, reject,
        start: () => {
          this.running++;
          if (lane) this.lanes.set(lane, (this.lanes.get(lane) ?? 0) + 1);
          if (priority === 'background') this.runningBackground++;
          this.started.push({ key, priority });
          if (this.started.length > 200) this.started.shift();
          const begin = priority === 'background' && this.options.waitIdle ? this.options.waitIdle() : Promise.resolve();
          // Слот освобождается до ответа вызвавшему: тот, получив результат, видит очередь уже свободной
          const finish = () => {
            this.running--;
            if (lane) this.lanes.set(lane, (this.lanes.get(lane) ?? 1) - 1);
            if (priority === 'background') this.runningBackground--;
            this.release(key);
            this.pump();
          };
          begin.then(task).then(value => { finish(); resolve(value); }, error => { finish(); reject(error); });
        },
      };
      this.queue.push(entry);
      this.pump();
    });
  }

  private release(key: string) {
    const n = (this.perKey.get(key) ?? 1) - 1;
    if (n <= 0) this.perKey.delete(key); else this.perKey.set(key, n);
  }

  private laneFree(w: Waiting) {
    const limit = w.lane ? this.options.laneLimits?.[w.lane] : undefined;
    return limit === undefined || (this.lanes.get(w.lane) ?? 0) < limit;
  }

  private pump() {
    for (;;) {
      if (this.running >= this.options.slots) return;
      // Открытое окно раньше фонового, внутри приоритета — по очереди прихода
      let index = this.queue.findIndex(w => w.priority === 'active' && this.laneFree(w));
      if (index < 0) {
        if (this.runningBackground >= this.backgroundSlots) return;
        index = this.queue.findIndex(w => w.priority === 'background' && this.laneFree(w));
      }
      if (index < 0) return;
      this.queue.splice(index, 1)[0].start();
    }
  }

  /** Сбросить ожидающих (закрытие программы, выход из программы): идущие расчёты не трогаются */
  cancelQueued(key: string, code: ConstructorParameters<typeof ComputeError>[0] = 'DENIED') {
    for (let i = this.queue.length - 1; i >= 0; i--) {
      if (this.queue[i].key !== key) continue;
      const [w] = this.queue.splice(i, 1);
      this.release(key);
      w.reject(new ComputeError(code));
    }
  }
}
