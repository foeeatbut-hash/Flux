/**
 * Запись документа: общая часть таблицы и текстового редактора.
 *
 * Оба редактора писали одно и то же своими руками — запрос, разбор ответа,
 * разбор конфликта, — и расходились в мелочах. Одно такое расхождение стоило
 * дефекта: текстовый редактор при закрытии отправлял снимок БЕЗ версии, и
 * сервер, который сверяет версию только когда она есть, молча клал устаревший
 * текст поверх работы коллеги.
 *
 * Поэтому запрос, разбор ответа и страховка черновиком живут здесь, а в
 * редакторах остаётся своё: что считать снимком и что делать после успеха.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { readSaveResponse, canCloseAfter, saveResultText, type SaveResult } from '../../lib/saveResult';
import { saveDraft, clearDraft, readDraft, worthRestoring, type DocDraft } from '../../lib/docDraft';
import { guardClose } from '../../lib/closeGuard';

/** Что отправляем и чем это закончилось. */
export interface PutOutcome {
  result: SaveResult;
  /** Тело успешного ответа — редактору нужен обновлённый документ */
  doc?: any;
}

/**
 * Отправить снимок и разобрать ответ.
 *
 * Черновик ведётся здесь же: успех его убирает, любой неуспех — откладывает.
 * Это и есть страховка от потери правки, и делать её в двух местах по-разному
 * — тот самый случай, из-за которого понадобился этот модуль.
 */
export async function putDoc(
  docId: string,
  body: Record<string, any>,
  snapshot: string,
): Promise<PutOutcome> {
  try {
    const res = await fetch(`/api/constructor/docs/${docId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (res.ok) {
      const doc = await res.json();
      clearDraft(docId);
      return { result: { kind: 'saved', at: doc?.doc?.updatedAt || '' }, doc };
    }
    const data = await res.json().catch(() => ({}));
    const result = readSaveResponse(res.status, data);
    if (snapshot) saveDraft(docId, snapshot, saveResultText(result));
    return { result };
  } catch (_) {
    if (snapshot) saveDraft(docId, snapshot, 'нет связи с сервером');
    return { result: { kind: 'error', status: 0, text: 'Нет связи с сервером' } };
  }
}

/**
 * Крестик рамы дописывает документ и не закрывает окно на отказе.
 *
 * Раньше крестик просто убирал окно из списка: движок размонтировался, таймер
 * автосохранения гас, и правка последних двух с половиной секунд исчезала.
 * `beforeunload` тут не срабатывает вовсе — закрывается окно ВНУТРИ страницы,
 * и браузер об этом ничего не знает.
 *
 * `save` берётся ссылкой: страж живёт дольше отрисовки и обязан звать свежую.
 */
export function useCloseGuard(
  paneId: string,
  save: () => Promise<SaveResult>,
  say: (text: string, kind?: 'success' | 'error' | 'info') => void,
): void {
  const saveRef = useRef(save);
  saveRef.current = save;
  const sayRef = useRef(say);
  sayRef.current = say;

  useEffect(() => {
    if (!paneId.startsWith('win:')) return;
    return guardClose(paneId.slice(4), async () => {
      const r = await saveRef.current();
      if (canCloseAfter(r)) return true;
      sayRef.current(`${saveResultText(r)}. Окно оставлено открытым, чтобы правка не пропала`, 'error');
      return false;
    });
  }, [paneId]);
}

/**
 * Черновик прошлой сессии: прочитать, предложить, убрать.
 *
 * Держится здесь, а не в редакторах, по той же причине, что и запись: правило
 * одно, а редакторов два, и разойтись им нельзя.
 */
export function useDocDraft(
  docId: string,
  /** Поставить снимок в движок — это единственное, что у редакторов разное */
  rebuild: (snapshot: string) => void,
  say: (text: string, kind?: 'success' | 'error' | 'info') => void,
) {
  const [pending, setPending] = useState<DocDraft | null>(null);
  const rebuildRef = useRef(rebuild); rebuildRef.current = rebuild;
  const sayRef = useRef(say); sayRef.current = say;

  /** Зовётся после загрузки документа: сравнивать есть с чем только тогда */
  const checkAfterLoad = useCallback((serverSnapshot: string) => {
    const d = readDraft(docId);
    if (worthRestoring(d, serverSnapshot)) setPending(d);
    else if (d) clearDraft(docId);
  }, [docId]);

  const dismiss = useCallback(() => { clearDraft(docId); setPending(null); }, [docId]);

  /**
   * Вернуть отложенную правку. Записью это не считается: человек увидит её и
   * решит сам, сохранять ли. Черновик до сохранения остаётся на месте.
   */
  const restore = useCallback(() => {
    setPending((cur) => {
      if (!cur) return null;
      try { rebuildRef.current(cur.snapshot); sayRef.current('Правка возвращена — сохраните её', 'success'); }
      catch (_) { sayRef.current('Черновик не читается — правка осталась только в нём', 'error'); }
      return null;
    });
  }, []);

  return { pending, checkAfterLoad, dismiss, restore };
}

/**
 * Последний рывок при закрытии вкладки или программы.
 *
 * Две вещи, которые здесь легко сделать неправильно и которые были сделаны
 * неправильно в текстовом редакторе.
 *
 * Первая: версия. Запрос уходил БЕЗ `baseUpdatedAt`, а сервер сверяет версию
 * только когда она есть, — и этот путь тихо клал устаревший снимок поверх
 * более новой работы коллеги, в обход всего разбора конфликтов.
 *
 * Вторая: `keepalive` — не гарантия. Браузер может не довезти запрос, ответа
 * мы всё равно не увидим, и помечать снимок записанным нельзя. Поэтому он
 * одновременно ложится в местный черновик: успешное открытие документа его
 * уберёт, а неуспешное — предложит вернуть.
 */
export function useFlushOnClose(opts: {
  docId: string;
  snapshot: () => string;
  /** Уже записанный снимок: одинаковый слать незачем */
  saved: () => string;
  base: () => string;
}): void {
  const ref = useRef(opts);
  ref.current = opts;

  useEffect(() => {
    const flush = () => {
      try {
        const { docId, snapshot, saved, base } = ref.current;
        const snap = snapshot();
        if (!snap || snap === saved()) return;
        saveDraft(docId, snap, 'окно закрылось до подтверждения записи');
        fetch(`/api/constructor/docs/${docId}`, {
          method: 'PUT', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ workbook: snap, baseUpdatedAt: base() }),
          keepalive: true,
        }).catch(() => {});
      } catch (_) { /* закрытие не повод падать */ }
    };
    window.addEventListener('beforeunload', flush);
    window.addEventListener('pagehide', flush);
    return () => {
      window.removeEventListener('beforeunload', flush);
      window.removeEventListener('pagehide', flush);
    };
  }, []);
}

/**
 * Три выхода из столкновения версий — одинаковые у таблицы и у текста.
 *
 * Ни один не теряет молча: копия сохраняет обе работы, «своё» уводит чужую
 * правку в историю версий, «его» теряет только то, что человек прямо сейчас
 * видит на экране, — и об этом сказано прямо в окне.
 *
 * Важное правило, ради которого это вынесено: разбор снимается ТОЛЬКО после
 * подтверждённой записи. Раньше здесь стоял безусловный зелёный тост, и на
 * отказ сервера человек получал тот же ответ, что на успех.
 */
export function resolveSaveChoice(choice: 'theirs' | 'mine' | 'copy', hooks: {
  save: () => Promise<SaveResult>;
  fork: () => Promise<void>;
  copyName: string;
  reload: () => void;
  keepConflict: (who: string) => void;
  clearConflict: () => void;
  say: (text: string, kind?: 'success' | 'error' | 'info') => void;
}): Promise<void> {
  const { save, fork, copyName, reload, keepConflict, clearConflict, say } = hooks;
  if (choice === 'theirs') { clearConflict(); reload(); return Promise.resolve(); }

  if (choice === 'mine') {
    return save().then((r) => {
      if (r.kind === 'saved') {
        clearConflict();
        say('Сохранено. Правка коллеги — в истории версий', 'success');
      } else {
        keepConflict(r.kind === 'conflict' ? r.who : '');
        say(saveResultText(r) || 'Не удалось сохранить', 'error');
      }
    });
  }

  // Копия: своё уходит отдельным документом, а это окно перечитывает чужую
  // правку — обе работы целы и лежат раздельно
  return fork().then(
    () => { clearConflict(); say(`Ваша правка сохранена документом «${copyName}»`, 'success'); reload(); },
    (e: any) => { keepConflict(''); say(e?.message || 'Не удалось создать копию — правка осталась на экране', 'error'); },
  );
}
