/**
 * Экстренная установка из файла `.fluxupdate` — логика скрытого раздела Flux.
 *
 * Раздел не ходит ни в базу, ни на сервер, ни в сессию: работает, даже если
 * вход в программу не удался и обновления через базу сломаны. Всё, чем он
 * пользуется, — файл, который человек выбрал, и открытый ключ в самой программе.
 *
 * Два шага, между которыми человек видит, что за версия в пакете:
 *   pick    — выбор файла, полная проверка подписи, размера и SHA-256, exe
 *             извлекается во временную папку и только после этого считается
 *             «готовым к установке»;
 *   install — повторная сверка файла на диске (между шагами его могли
 *             подменить), согласие открытых окон закрыться и запуск помощника
 *             подмены, тот же, что у обычного обновления (applyUpdate.ts).
 *
 * Неудача на любом шаге не оставляет ничего установленного: прежний файл
 * программы на месте, временная папка убирается.
 *
 * Модуль без Electron: всё внешнее приходит параметрами, поэтому его проверяет
 * scripts/test-emergency-package.ts.
 */
import fs from 'node:fs';
import path from 'node:path';
import { applyArgs, badPackage } from './updates';
import { sha256File, updateRefusal } from './updateSignature';
import { extractPackage, PackageRefusal } from './updatePackage';

export interface EmergencyDeps {
  keyHex: string;
  /** Версия работающей программы */
  current: () => string;
  /** Где создавать временную папку (`%TEMP%`) */
  tempDir: string;
  /** Путь портативного exe, который запустил человек; пусто — программа не портативная */
  portableExe: () => string;
  pid: number;
  /** Диалог выбора файла главного процесса; null — человек отказался */
  pickFile: () => Promise<string | null>;
  /** Запуск помощника подмены (прежний exe не трогается, пока помощник не дождался ухода) */
  spawnHelper: (exe: string, args: string[]) => Promise<void>;
  /** Согласие открытых окон закрыться: несохранённые правки не теряются */
  approveClose: () => Promise<boolean>;
  quit: () => void;
  log: (level: 'INFO' | 'ERROR', text: string) => void;
  onProgress?: (percent: number) => void;
}

export interface EmergencyPicked { ok: true; version: string; current: string; name: string; sizeMb: number }
export interface EmergencyFailed { ok: false; canceled?: boolean; error: string; deferred?: boolean }
export type EmergencyResult = EmergencyPicked | EmergencyFailed;

const folderName = 'flux-update-';

export function createEmergencyInstaller(d: EmergencyDeps) {
  let staged: { folder: string; exe: string; signature: string; version: string } | null = null;
  let busy = false;

  const discard = () => {
    if (!staged) return;
    // Из этой папки может быть запущен помощник (после install) — тогда Windows не даст её стереть; не страшно, при запуске программы папки старше суток убираются (updateTemp.ts)
    try { fs.rmSync(staged.folder, { recursive: true, force: true }); } catch { /* занято — уберётся позже */ }
    staged = null;
  };
  const wording = (e: unknown) => (e instanceof PackageRefusal ? e.message : `Не удалось подготовить пакет: ${(e as Error)?.message || e}`);

  return {
    /** Выбрать файл и подготовить его к установке */
    async pick(): Promise<EmergencyResult> {
      if (busy) return { ok: false, error: 'Дождитесь завершения текущей операции.' };
      busy = true;
      try {
        discard();
        const file = await d.pickFile();
        if (!file) return { ok: false, canceled: true, error: '' };
        const folder = fs.mkdtempSync(path.join(d.tempDir, folderName));
        const current = d.current();
        const exe = path.join(folder, 'Flux-update.exe');
        try {
          const info = await extractPackage(file, exe, { keyHex: d.keyHex, current, onProgress: d.onProgress });
          staged = { folder, exe, signature: info.signature, version: info.version };
          d.log('INFO', `Экстренный пакет проверен: версия ${info.version}, ${Math.round(info.size / 1048576)} МБ`);
          return { ok: true, version: info.version, current, name: path.basename(file), sizeMb: Math.round(info.size / 104857.6) / 10 };
        } catch (e) {
          try { fs.rmSync(folder, { recursive: true, force: true }); } catch { /* уберётся позже */ }
          d.log('ERROR', `Экстренный пакет не принят: ${wording(e)}`);
          return { ok: false, error: wording(e) };
        }
      } finally { busy = false; }
    },

    /** Поставить подготовленное: помощник подменяет файл программы и запускает новую версию */
    async install(): Promise<EmergencyResult | { ok: true; started: true }> {
      if (busy) return { ok: false, error: 'Дождитесь завершения текущей операции.' };
      if (!staged) return { ok: false, error: 'Сначала выберите файл пакета.' };
      busy = true;
      try {
        const portable = d.portableExe();
        if (!portable || !fs.existsSync(portable)) {
          return { ok: false, error: 'Экстренная установка работает только в портативной сборке Flux. Замените файл программы вручную.' };
        }
        // Файл лежит в общей временной папке: между проверкой и запуском его могли заменить
        let size = 0, sha256 = '';
        try { size = fs.statSync(staged.exe).size; sha256 = await sha256File(staged.exe); } catch { discard(); return { ok: false, error: 'Файл обновления пропал или не читается. Выберите пакет заново.' }; }
        const fd = fs.openSync(staged.exe, 'r'), head = Buffer.alloc(2);
        try { fs.readSync(fd, head, 0, 2, 0); } finally { fs.closeSync(fd); }
        const refusal = badPackage(Array.from(head), size)
          || updateRefusal({ signature: staged.signature, version: staged.version, current: d.current(), size, sha256, keyHex: d.keyHex });
        if (refusal) { discard(); d.log('ERROR', `Экстренная установка остановлена: ${refusal}`); return { ok: false, error: refusal }; }
        if (!await d.approveClose()) return { ok: false, deferred: true, error: 'Установка отложена: сохраните изменения в открытых окнах и повторите.' };
        d.log('INFO', `Экстренная установка ${staged.version}: подменяю ${portable}`);
        await d.spawnHelper(staged.exe, applyArgs(portable, d.pid, { signature: staged.signature, current: d.current() }));
        d.quit();
        return { ok: true, started: true };
      } catch (e) {
        d.log('ERROR', `Не удалось запустить подмену: ${(e as Error)?.message || e}`);
        return { ok: false, error: `Не удалось запустить установку: ${(e as Error)?.message || e}. Прежняя программа на месте.` };
      } finally { busy = false; }
    },

    /** Закрыть раздел: подготовленное убирается */
    discard,
    /** Есть ли подготовленный пакет (для проверок) */
    prepared: () => !!staged,
  };
}
