/**
 * Точка входа FluxStudio-Владелец.exe.
 *
 * Та же оболочка разработчика плюс раздел владельца: окно со всем, что умел
 * отдельный Flux Owner (хранилище ключей, лицензии, выпуск обновлений Flux,
 * подключение к общей базе, диагностика). Код раздела собирается отдельным
 * файлом и подключается только здесь.
 */
import path from 'node:path';
import { startShell } from './shell/main';

// Не через import: основной бандл остаётся общим с разработчиком, а раздел — отдельный файл рядом
const ownerSection = require(path.join(__dirname, 'owner', 'main.cjs')) as { openOwnerWindow: () => Promise<void> };

startShell([{ id: 'owner', title: 'Лицензии и обновления Flux', open: () => ownerSection.openOwnerWindow() }]);
