/**
 * Какие каналы оболочки окно может звать через общий мост.
 *
 * Раньше мост пропускал любой канал, и это превращало любую ошибку в окне в
 * доступ ко всему, что умеет оболочка: записать файл и открыть его, скачать и
 * запустить «обновление», снять экран. Одна не заэкранированная строка в
 * письме — и чужой текст получал всё это разом.
 *
 * Поэтому общий мост знает только то, что окно действительно зовёт им сейчас.
 * У остального свои именные методы (`games`, `logs`, `windowControls`…), а
 * новый канал добавляется сюда осознанно — или получает свой метод.
 */
export const INVOKE_CHANNELS: ReadonlySet<string> = new Set([
  'app:get-server-url',
  'app:set-server-url',
  'app:set-database',
  'app:relaunch',
  'license:status',
  'license:activate',
  'chat:open-file',
  'database:select-file',
  'dialog:openDirectory',
  'print:to-pdf',
  'shell:open-external',
  'desktop:capture',
  'feedback:capture-window',
  'feedback:capture-region',
]);

export const SEND_CHANNELS: ReadonlySet<string> = new Set([
  'window:open-sticker',
]);

/** События оболочки, которые окно может слушать через общий мост */
export const LISTEN_CHANNELS: ReadonlySet<string> = new Set([
  'notify:open',
  'updater:status',
  'updater:error',
  'window:maximized-changed',
]);

export const refused = (channel: string) =>
  new Error(`Канал оболочки «${String(channel).slice(0, 60)}» окну не открыт`);
