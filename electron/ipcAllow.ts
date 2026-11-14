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
  'auth:read-session',
  'auth:write-session',
  'owner:select-key',
  'owner:sign-login',
  // Выпуски модулей: проверка и кэш в главном процессе, подпись владельца из хранилища (electron/modules.ts)
  'modules:state',
  'modules:sync',
  'modules:activate',
  'modules:install',
  'modules:remove',
  'modules:rollback',
  'modules:synced',
  // Итог контрольных примеров выпуска на этом компьютере (electron/moduleControls.ts)
  'modules:controls',
  'modules:controls-result',
  'modules:controls-reset',
  // Подключения программ к внешним программам, решения человека и журнал (electron/moduleConnectionsIpc.ts)
  'modules:connect',
  'modules:net',
  'modules:program-begin',
  'modules:program-end',
  'modules:connect-close',
  'modules:grant',
  'modules:grants',
  'modules:grants-reset',
  'modules:policy',
  'modules:journal-add',
  'modules:journal-pending',
  'modules:journal-ack',
  'modules:journal-recent',
  // Файл пользователя для программы: диалог показывает главный процесс (electron/modulePickFile.ts)
  'modules:pick-file',
  // Программы из разработки («Запустить во Flux» из Studio): список, согласие, «Убрать» (electron/moduleDevRunsIpc.ts)
  'modules:devRuns',
  'modules:devAccept',
  'modules:devRemove',
  // Хранилище самостоятельной программы на диске: чтение, запись, очистка, объём (electron/moduleStorageIpc.ts)
  'modules:state-load',
  'modules:state-keep',
  'modules:state-clear',
  'modules:state-usage',
  'app:get-server-url',
  'app:get-database',
  'app:probe-database',
  'app:set-database',
  'app:set-local-database-path',
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
  'taskbar:window-thumb',
]);

export const SEND_CHANNELS: ReadonlySet<string> = new Set([
  'window:open-sticker',
]);

/** События оболочки, которые окно может слушать через общий мост */
export const LISTEN_CHANNELS: ReadonlySet<string> = new Set([
  'drafts:toggle',
  'notify:open',
  'updater:status',
  'updater:error',
  'window:maximized-changed',
  // Пакет из разработки появился, истёк или убран (electron/modules.ts)
  'modules:devChanged',
]);

export const refused = (channel: string) =>
  new Error(`Канал оболочки «${String(channel).slice(0, 60)}» окну не открыт`);
