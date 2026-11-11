/**
 * Точка входа FluxStudio-Владелец.exe.
 *
 * Та же оболочка разработчика плюс раздел владельца: окно со всем, что умел
 * отдельный Flux Owner (хранилище ключей, лицензии, выпуск обновлений Flux,
 * подключение к общей базе, диагностика), и разделы, которые перешли из Flux: запросы на публикацию,
 * выпуски и каналы, сертификаты разработчиков, назначение обновлений. Код раздела собирается отдельным
 * файлом и подключается только здесь.
 */
import path from 'node:path';
import { startShell } from './shell/main';

// Не через import: основной бандл остаётся общим с разработчиком, а раздел — отдельный файл рядом
const ownerSection = require(path.join(__dirname, 'owner', 'main.cjs')) as {
  openOwnerWindow: () => Promise<void>;
  openConsole: (tab: string) => Promise<void>;
};

startShell([
  { id: 'publish', title: 'Запросы на публикацию', open: () => ownerSection.openConsole('requests') },
  { id: 'releases', title: 'Выпуски и каналы', open: () => ownerSection.openConsole('releases') },
  { id: 'certificates', title: 'Сертификаты разработчиков', open: () => ownerSection.openConsole('certificates') },
  { id: 'updates', title: 'Обновления Flux', open: () => ownerSection.openConsole('updates') },
  { id: 'owner', title: 'Лицензии и выпуск обновлений', open: () => ownerSection.openOwnerWindow() },
]);
