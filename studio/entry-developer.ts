/**
 * Точка входа FluxStudio.exe — сборка разработчика.
 *
 * Здесь нет ни одного импорта из studio/owner: именно это проверяет
 * scripts/check-studio-bundle.ts по карте сборки и по тексту готового пакета.
 */
import { startShell } from './shell/main';

startShell();
