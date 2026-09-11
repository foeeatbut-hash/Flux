/**
 * Очередь отправки обращений.
 *
 * Отдельный слой между формой и сервером нужен по одной причине: нажатие
 * «Отправить» не должно зависеть от того, есть ли связь прямо сейчас. У
 * сотрудника отдела связь пропадает буднично — перезагрузили коммутатор,
 * ноутбук ушёл в сон, сервер перезапустили после обновления, — и обращение,
 * которое исчезло вместе с этим, второй раз никто не напишет.
 *
 * Поэтому пакет фиксируется в момент нажатия (текст и набор файлов больше не
 * меняются), кладётся в IndexedDB и живёт там, пока не подтвердится сервером.
 * Перезапуск программы очередь не теряет: состояние лежит рядом с черновиком, а
 * не в памяти окна.
 *
 * Два правила, которые здесь легко нарушить и дорого исправлять:
 *
 * 1. «Отправлено» показывается ТОЛЬКО после подтверждённого ответа на
 *    POST /reports. Полученный uploadId отправкой не является: файл на сервере
 *    есть, а обращения нет, и человек ждёт ответа на то, чего не создано.
 * 2. Молчание сервера не значит «не дошло». При обрыве на отправке сначала
 *    спрашиваем по ключу запроса, есть ли уже карточка, и только потом
 *    повторяем. Иначе одно нажатие даёт две карточки — а именно от этого
 *    заведён ключ.
 */

import { dropDraft, listDrafts, readDraft, saveDraft, type Draft } from './draftDb';
import { ApiError, findByRequest, sendFile, submitReport } from './feedbackApi';
import { reportNumber, type SubmitFeedbackV1 } from '../../feedback/contracts';

/** Состояния пакета. До QUEUED всё это правки в форме, наружу они не идут. */
export type SendState = Draft['state'];

/** Первые пять задержек, дальше — раз в пять минут. */
export const RETRY_STEPS = [2000, 5000, 15000, 30000, 60000];
export const RETRY_SLOW = 5 * 60 * 1000;
/** Больше десяти попыток подряд — значит дело не во временном сбое. */
export const MAX_ATTEMPTS = 10;

/**
 * Когда пробовать снова.
 *
 * Разброс ±20 % не украшение: у пятидесяти сотрудников программа заметит
 * возвращение сервера в одну и ту же секунду и пойдёт в него разом. Случайность
 * `random` подаётся снаружи, чтобы проверка не гадала.
 */
export function nextDelay(attempt: number, random: () => number = Math.random): number {
  const base = attempt < RETRY_STEPS.length ? RETRY_STEPS[attempt] : RETRY_SLOW;
  return Math.round(base * (0.8 + random() * 0.4));
}

/**
 * Куда ведёт отказ.
 *
 * Разделение важнее, чем кажется: повторять до посинения отказ по правам —
 * значит скрыть от человека, что от него что-то требуется. «Войдите заново»,
 * «файл великоват», «прав нет» — это разговор, а не ожидание.
 */
export function stateForError(error: unknown): SendState {
  if (!(error instanceof ApiError)) return 'FAILED_RETRYABLE';
  if (error.status === 401) return 'NEEDS_SIGN_IN';
  if (error.needsPerson) return 'NEEDS_REVIEW';
  return 'FAILED_RETRYABLE';
}

export interface QueueItem {
  key: string;
  state: SendState;
  /** Сколько попыток подряд уже сделано — обнуляется при успехе шага. */
  attempts: number;
  /** Ход по байтам вложений: показывается полоской, а не «идёт отправка». */
  done: number;
  total: number;
  note: string;
  /** Идентификатор готовой карточки, когда отправка подтверждена. */
  reportId?: string;
  /**
   * Номер карточки, каким его называет человек: ОБР-000123.
   *
   * Хранится рядом с идентификатором, а не выводится из него: сказать
   * «Отправлено» без номера — значит оставить человека без единственного
   * способа потом найти своё обращение и спросить, что с ним стало.
   */
  reportNumber?: string;
}

type Listener = (items: QueueItem[]) => void;

/** Собранный пакет: текст уже проверен формой, файлы уже плоские. */
export interface Package {
  key: string;
  draftId: string;
  deploymentId: string;
  userId: string;
  body: Omit<SubmitFeedbackV1, 'uploadIds'>;
  files: Array<{ id: string; name: string; kind: 'IMAGE' | 'FILE' | 'DIAGNOSTICS'; blob: Blob }>;
}

/**
 * Очередь.
 *
 * Одна на окно и по одному пакету за раз. Параллельная отправка здесь ничего не
 * ускоряет — узкое место в кусках файла, — зато ломает единственное, ради чего
 * очередь заведена: понятный человеку ответ на вопрос «что сейчас происходит».
 */
export class SubmissionQueue {
  private items = new Map<string, QueueItem>();
  private packages = new Map<string, Package>();
  private aborts = new Map<string, AbortController>();
  private timers = new Map<string, any>();
  private listeners = new Set<Listener>();
  private running = false;
  private order: string[] = [];
  /** Очередь распущена (выход из программы). Новых ожиданий не заводим. */
  private stopped = false;

  /** Задержка ожидания — подменяется в проверках, чтобы не ждать по-настоящему. */
  wait: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms));

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    listener(this.snapshot());
    return () => { this.listeners.delete(listener); };
  }

  /**
   * Снимок очереди — копии, а не сами записи.
   *
   * Записи правятся на месте, и отдавать их наружу нельзя: окно кладёт запись в
   * своё состояние, а на следующем изменении получает ТОТ ЖЕ объект. React
   * сравнивает по ссылке, видит «ничего не изменилось» и не перерисовывает —
   * форма застывала на первом увиденном шаге навсегда. Со стороны это выглядело
   * как зависшая отправка: обращение уже заведено, записи приложены, а человек
   * смотрит на «Отправляем вложения» и не знает, что всё давно готово.
   */
  snapshot(): QueueItem[] {
    return this.order
      .map((key) => this.items.get(key))
      .filter(Boolean)
      .map((item) => ({ ...(item as QueueItem) }));
  }

  private tell(): void {
    const now = this.snapshot();
    for (const listener of this.listeners) { try { listener(now); } catch (_) { /* слушатель — не условие отправки */ } }
  }

  private async put(key: string, patch: Partial<QueueItem>): Promise<void> {
    const item = this.items.get(key);
    if (!item) return;
    Object.assign(item, patch);
    this.tell();

    /**
     * В хранилище пишется только смена состояния, а не каждый пройденный байт.
     *
     * Ход отправки меняется на каждом куске, а записать черновик — значит
     * переписать его целиком, вместе с приложенными мегабайтами: браузерное
     * хранилище кладёт значение целиком, кусками его не правят. На снимке в
     * несколько мегабайт это превращало отправку в минуты, и человек видел
     * застывшее «Отправляем вложения» там, где всё работало.
     *
     * Терять при этом нечего: байты черновика не меняются, пока он едет, а
     * состояние переживает перезапуск только записанным — его и пишем.
     */
    if (patch.state === undefined && patch.note === undefined) return;
    const draft = await readDraft(key);
    if (draft) await saveDraft({ ...draft, state: item.state, note: item.note });
  }

  /** Поставить собранный пакет в очередь. Возвращает ключ для наблюдения. */
  async enqueue(pack: Package): Promise<string> {
    this.stopped = false;
    this.packages.set(pack.key, pack);
    if (!this.items.has(pack.key)) this.order.push(pack.key);
    const total = pack.files.reduce((sum, f) => sum + (f.blob?.size || 0), 0);
    this.items.set(pack.key, {
      key: pack.key, state: 'QUEUED', attempts: 0, done: 0, total,
      note: 'Отправим при восстановлении связи',
    });
    await this.put(pack.key, {});
    void this.pump();
    return pack.key;
  }

  /**
   * Отменить отправку.
   *
   * Пока файлы едут — обрываем и говорим «не отправлено». Но если пакет уже
   * ушёл на подтверждение, врать нельзя: обращение могло быть создано. Такой
   * пакет доводится до конца, а отзыв делается уже по карточке.
   */
  cancel(key: string): boolean {
    const item = this.items.get(key);
    if (!item) return false;
    if (item.state === 'COMMITTING' || item.state === 'SENT') return false;
    clearTimeout(this.timers.get(key));
    this.timers.delete(key);
    this.aborts.get(key)?.abort();
    void this.put(key, { state: 'CANCELLED', note: 'Отправка отменена' });
    return true;
  }

  /** Повторить руками после того, как автоматические попытки кончились. */
  retry(key: string): void {
    const item = this.items.get(key);
    if (!item || !this.packages.has(key)) return;
    void this.put(key, { state: 'QUEUED', attempts: 0, note: 'Пробуем ещё раз' });
    void this.pump();
  }

  /** Выход из программы: очередь чужому человеку не достаётся. */
  clear(): void {
    for (const controller of this.aborts.values()) { try { controller.abort(); } catch (_) { /* уже завершилась */ } }
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.aborts.clear(); this.timers.clear();
    this.items.clear(); this.packages.clear(); this.order = [];
    this.stopped = true;
    this.tell();
  }

  private waiting(): string | null {
    for (const key of this.order) {
      const item = this.items.get(key);
      if (item && item.state === 'QUEUED' && this.packages.has(key)) return key;
    }
    return null;
  }

  private async pump(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      let key = this.waiting();
      while (key) {
        await this.sendOne(key);
        key = this.waiting();
      }
    } finally { this.running = false; }
  }

  private async sendOne(key: string): Promise<void> {
    const pack = this.packages.get(key)!;
    const item = this.items.get(key)!;
    const controller = new AbortController();
    this.aborts.set(key, controller);
    try {
      await this.put(key, { state: 'UPLOADING', note: 'Отправляем вложения' });
      const uploadIds: string[] = [];
      let sent = 0;
      for (const file of pack.files) {
        if (controller.signal.aborted) return;
        const before = sent;
        /**
         * Ключ загрузки — у КАЖДОГО файла свой.
         *
         * Здесь стоял ключ всей отправки, а сервер считает загрузку по паре
         * «владелец + ключ». Значит второй файл находил чужую готовую загрузку
         * и молча возвращал её: к обращению приезжал только первый. Снимок
         * вместе с записями диагностики человек терял, ничего не заметив, и
         * узнать об этом было неоткуда — форма показывала успех.
         *
         * Идентификатор вложения выдаётся один раз и живёт в черновике,
         * поэтому повтор после обрыва по-прежнему находит свою же загрузку и
         * докачивает недостающее, а не начинает заново.
         */
        const id = await sendFile(file.blob, file.name, file.kind, file.id, pack.draftId,
          (done) => { void this.put(key, { done: before + done }); },
          controller.signal);
        sent += file.blob?.size || 0;
        uploadIds.push(id);
      }
      if (controller.signal.aborted) return;

      await this.put(key, { state: 'COMMITTING', done: item.total, note: 'Подтверждаем отправку' });
      const report = await this.commit(pack, uploadIds);
      await this.put(key, {
        state: 'SENT', attempts: 0, reportId: report?.id, note: 'Отправлено',
        reportNumber: typeof report?.number === 'number' ? reportNumber(report.number) : undefined,
      });
      // Подтверждённое обращение живёт на сервере, и держать его копию в
      // браузере больше незачем: снимки в черновике занимают мегабайты, а
      // двадцать таких черновиков упрутся в предел и не дадут написать новое
      await dropDraft(key);
    } catch (error: any) {
      if (controller.signal.aborted) return;
      await this.afterFailure(key, error);
    } finally { this.aborts.delete(key); }
  }

  /**
   * Подтверждение с одной оговоркой про потерянный ответ.
   *
   * Обрыв на этом запросе — единственное место, где повтор опасен: сервер мог
   * всё сделать и не успеть ответить. Поэтому сначала вопрос по ключу, и только
   * если карточки нет — повтор того же запроса.
   */
  private async commit(pack: Package, uploadIds: string[]): Promise<any> {
    const body: SubmitFeedbackV1 = { ...pack.body, uploadIds } as SubmitFeedbackV1;
    try {
      return await submitReport(body);
    } catch (error: any) {
      if (!(error instanceof ApiError) || error.status !== 0) throw error;
      const found = await findByRequest(pack.body.clientRequestId).catch(() => null);
      if (found?.id) return found;
      throw error;
    }
  }

  private async afterFailure(key: string, error: any): Promise<void> {
    const item = this.items.get(key)!;
    const state = stateForError(error);
    const note = error instanceof ApiError ? error.message : 'Не удалось отправить';
    if (state !== 'FAILED_RETRYABLE') { await this.put(key, { state, note }); return; }

    const attempts = item.attempts + 1;
    if (attempts >= MAX_ATTEMPTS) {
      await this.put(key, { state: 'FAILED_RETRYABLE', attempts, note: `${note}. Нажмите «Повторить»` });
      return;
    }
    await this.put(key, { state: 'FAILED_RETRYABLE', attempts, note: `${note}. Попробуем снова` });
    // Между записью состояния и заводом ожидания очередь могли распустить —
    // тогда ожидание уже некому обслуживать, и оно осталось бы висеть
    if (this.stopped) return;
    const timer = setTimeout(() => {
      this.timers.delete(key);
      const current = this.items.get(key);
      if (!current || current.state !== 'FAILED_RETRYABLE') return;
      void this.put(key, { state: 'QUEUED' });
      void this.pump();
    }, nextDelay(attempts - 1));
    this.timers.set(key, timer);
    // Ожидание не держит очередь: следующий пакет поедет, не дожидаясь этого
  }
}

export const submissionQueue = new SubmissionQueue();

/** Состояния, из которых отправка ещё не закончилась ничем определённым. */
const UNFINISHED: SendState[] = ['QUEUED', 'UPLOADING', 'COMMITTING', 'FAILED_RETRYABLE'];

/**
 * Собрать пакет обратно из записанного черновика.
 *
 * Пакет не хранится отдельно намеренно: черновик и так содержит всё, что было
 * зафиксировано нажатием, а вторая копия тех же данных однажды разойдётся с
 * первой — и отправится не то, что человек видел на предпросмотре.
 */
export function packageFromDraft(draft: Draft): Package | null {
  const body = draft.fields as unknown as Package['body'];
  if (!draft.clientRequestId || !body?.title) return null;
  return {
    key: draft.id,
    draftId: draft.draftId,
    deploymentId: draft.deploymentId,
    userId: draft.userId,
    body: { ...body, clientRequestId: draft.clientRequestId },
    files: (draft.attachments || []).map((a) => ({ id: a.id, name: a.name, kind: a.kind, blob: a.blob })),
  };
}

/**
 * Продолжить после перезапуска программы.
 *
 * Берутся только незаконченные черновики этого человека в этом контуре: чужой
 * пакет не должен уехать под чужим именем, а начатое на другом сервере — в
 * этот. `COMMITTING` тоже возвращается в очередь, и это безопасно: перед
 * повтором спрашивается, не создана ли карточка.
 */
export async function resumeQueue(
  deploymentId: string, userId: string,
  queue: SubmissionQueue = submissionQueue,
): Promise<number> {
  const mine = await listDrafts(deploymentId, userId);
  let resumed = 0;
  for (const draft of mine) {
    if (!UNFINISHED.includes(draft.state)) continue;
    const pack = packageFromDraft(draft);
    if (!pack) continue;
    await queue.enqueue(pack);
    resumed++;
  }
  return resumed;
}
