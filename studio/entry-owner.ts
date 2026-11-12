/**
 * Точка входа FluxStudio-Владелец.exe.
 *
 * Та же оболочка разработчика плюс раздел владельца: окно со всем, что умел
 * отдельный Flux Owner (хранилище ключей, лицензии, выпуск обновлений Flux,
 * подключение к общей базе, диагностика), и разделы, которые перешли из Flux: программы на проверку,
 * назначение обновлений. Код раздела собирается отдельным файлом и подключается только здесь.
 */
import path from 'node:path';
import { startShell } from './shell/main';

// Не через import: основной бандл остаётся общим с разработчиком, а раздел — отдельный файл рядом
const ownerSection = require(path.join(__dirname, 'owner', 'main.cjs')) as {
  openOwnerWindow: () => Promise<void>;
  openConsole: (tab: string) => Promise<void>;
};

// Три пункта: что прислали разработчики, обновления Flux, лицензии. Окно лицензий открывается из пункта «Лицензии» окна разделов
// (хранилище и подключение у них общие), поэтому отдельного пункта оболочки у него нет.
startShell([
  { id: 'programs', title: 'Программы на проверку', open: () => ownerSection.openConsole('programs') },
  { id: 'updates', title: 'Flux: обновления', open: () => ownerSection.openConsole('updates') },
  { id: 'licenses', title: 'Лицензии', open: () => ownerSection.openConsole('licenses') },
]);
