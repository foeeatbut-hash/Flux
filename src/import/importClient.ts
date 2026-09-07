// Клиент фонового распознавания: прячет Web Worker за простым API и всегда имеет
// откат на главный поток. Если воркер недоступен (старый браузер, ошибка сборки,
// краш) — всё считается синхронно, импорт не ломается.

import type { ExtractedDoc, DraftResult } from './types';
import type { LearnedEntry } from './dictionary';
import { getSymbolRules } from './learn';

type Learned = Record<string, LearnedEntry>;

let worker: Worker | null = null;
let workerBroken = false;
let seq = 0;
const pending = new Map<number, { resolve: (d: DraftResult) => void; reject: (e: any) => void }>();

function getWorker(): Worker | null {
  if (workerBroken) return null;
  if (worker) return worker;
  if (typeof Worker === 'undefined') { workerBroken = true; return null; }
  try {
    worker = new Worker(new URL('./recognize.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (e: MessageEvent<any>) => {
      const { id, type, draft, message } = e.data || {};
      const p = pending.get(id);
      if (!p) return;
      pending.delete(id);
      if (type === 'result') p.resolve(draft);
      else p.reject(new Error(message || 'Ошибка фонового распознавания'));
    };
    worker.onerror = () => {
      // Воркер сломался — уходим в синхронный режим и отклоняем всё висящее,
      // чтобы вызвавшие промисы откатились на главный поток.
      workerBroken = true;
      for (const [, p] of pending) p.reject(new Error('Фоновый распознаватель недоступен'));
      pending.clear();
      try { worker?.terminate(); } catch { /* ignore */ }
      worker = null;
    };
    return worker;
  } catch {
    workerBroken = true;
    return null;
  }
}

// Справочник обозначений отдела едет вместе с задачей: воркер — отдельный
// поток со своим модульным состоянием, там его иначе не будет.
function post(msg: Record<string, unknown>): Promise<DraftResult> {
  msg = { ...msg, symbols: getSymbolRules() };
  const w = getWorker();
  if (!w) return Promise.reject(new Error('no worker'));
  const id = ++seq;
  return new Promise<DraftResult>((resolve, reject) => {
    pending.set(id, { resolve, reject });
    try {
      w.postMessage({ ...msg, id });
    } catch (err) {
      pending.delete(id);
      reject(err);
    }
  });
}

/** recognize(doc) в фоне; при недоступности воркера — синхронно на главном потоке */
export async function recognizeAsync(doc: ExtractedDoc, learned?: Learned): Promise<DraftResult> {
  try {
    return await post({ type: 'recognize', doc, learned });
  } catch {
    const { recognize } = await import('./recognize');
    const { setLearned } = await import('./dictionary');
    setLearned(learned);
    return recognize(doc);
  }
}

/**
 * Извлечение «чистого» формата (xlsx/xls/csv/xml) + распознавание в фоне.
 * Буфер копируется структурным клоном (не передаётся), чтобы исходный остался цел.
 */
export async function extractRecognizeAsync(ext: string, buffer: ArrayBuffer, learned?: Learned): Promise<DraftResult> {
  try {
    return await post({ type: 'extractRecognize', ext, buffer, learned });
  } catch {
    const { extractXlsx, extractXml } = await import('./extractors');
    const { recognize } = await import('./recognize');
    const { setLearned } = await import('./dictionary');
    setLearned(learned);
    const doc = ext === 'xml'
      ? extractXml(new TextDecoder('utf-8').decode(buffer))
      : extractXlsx(buffer);
    return recognize(doc);
  }
}
