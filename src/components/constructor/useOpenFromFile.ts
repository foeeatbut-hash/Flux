/**
 * Открытие Конструктора по адресу «?fromFile=…».
 *
 * Отдельным крючком, а не десятком строк в экране: экран Конструктора и так
 * самый большой в программе, а у этого дела своя законченная мысль — принесённый
 * файл превращается в документ ровно один раз, и повторное открытие ведёт в тот
 * же документ, а не в новую копию.
 *
 * Сам разбор — в src/lib/officeOpen.ts (в окне, а не на сервере: серверная ветка
 * звала библиотеку, которой в собранной программе нет).
 */
import { useEffect, useRef } from 'react';
import { openOfficeFile } from '../../lib/officeOpen';

export interface OpenFromFileDeps {
  /** Значение параметра «fromFile» из адреса; пусто — открывать нечего */
  fileId: string;
  projectId: string;
  /** Открыть документ по его идентификатору (меняет адрес на «?doc=…») */
  openDoc: (docId: string) => void;
  /** Убрать параметр из адреса: файл открыть не вышло */
  giveUp: () => void;
  say: (text: string, kind: 'info' | 'success' | 'error') => void;
}

export function useOpenFromFile({ fileId, projectId, openDoc, giveUp, say }: OpenFromFileDeps): void {
  // Какой файл уже открывали: адрес меняется несколько раз подряд, и без этой
  // памяти файл разбирался бы дважды, а документов заводилось бы два
  const doneRef = useRef('');

  useEffect(() => {
    if (!fileId || doneRef.current === fileId) return;
    doneRef.current = fileId;
    (async () => {
      try {
        const meta = await fetch(`/api/files/${encodeURIComponent(fileId)}?meta=1`).then((r) => r.json());
        const file = meta?.file;
        if (!file) throw new Error('Файл не найден');
        // Файл, уже ставший документом, открывается им же — а не второй копией:
        // иначе вчерашних правок человек бы не нашёл
        if (file.refId) { openDoc(String(file.refId)); return; }
        say(`Открываю «${file.name}»…`, 'info');
        const opened = await openOfficeFile(fileId, String(file.name || ''), projectId);
        if (opened.note) say(opened.note, 'info');
        openDoc(opened.docId);
      } catch (err: any) {
        say(err?.message || 'Не удалось открыть файл', 'error');
        giveUp();
      }
    })();
  }, [fileId]); // eslint-disable-line react-hooks/exhaustive-deps
}
