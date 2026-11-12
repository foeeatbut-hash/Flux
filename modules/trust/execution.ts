/**
 * Файлы логики внутри пакета: что владелец подписывает и что Flux запускает.
 *
 * Подпись выпуска покрывает ВЕСЬ пакет побайтно (SHA-256 всех кусков, см.
 * verify.ts), в том числе `logic/main.py` и `logic/main.wasm`. Здесь —
 * проверка смысла: файл логики есть и подходит языку, контрольные примеры
 * читаются. Так модуль, у которого «язык python», а файл — чужой, не доходит
 * до подписи владельца, а не только до запуска.
 */
import { bundleText, type BundleFiles } from './bundle';
import type { ModuleManifest } from '../contract';
import { CONTROLS_FILE, LIMITS, LOGIC_BUILD_FILE, LOGIC_FILES, languageOf } from '../engine/types';
import { parseControls } from '../engine/controls';
import { wasmProblem } from '../engine/wasmInspect';
import { pageProblem } from '../page/model';
import { needsLogicBuild } from '../programs/model';
import { RUNTIME_FILE } from './bundle';

/** Возвращает причину словами или '' */
export function executionProblem(manifest: ModuleManifest, files: BundleFiles): string {
  const language = languageOf(manifest);
  const logic = files[LOGIC_FILES[language]];
  if (language !== 'typescript') {
    if (!logic?.length) return `В пакете нет ${LOGIC_FILES[language]}`;
    if (language === 'python') {
      if (logic.length > LIMITS.pythonFileBytes) return 'Файл Python больше 1 МиБ';
      if (bundleText(files, LOGIC_FILES.python) === null) return 'logic/main.py не в кодировке UTF-8';
    } else {
      const problem = wasmProblem(logic);
      if (problem) return `logic/main.wasm: ${problem}`;
    }
    if (!files[CONTROLS_FILE]?.length) return `Для ${language === 'python' ? 'Python' : 'WebAssembly'} нужны контрольные примеры: ${CONTROLS_FILE}`;
  } else if (!logic?.length && files[LOGIC_FILES.typescript] !== undefined) return `Файл ${LOGIC_FILES.typescript} пуст`;
  // Метод для других программ — чистая функция «JSON → JSON» вне окна программы. Flux не компилирует TypeScript: метод исполняет
  // собранный `build/logic.js` пакета (его кладёт сборка Flux или Studio), и, как Python и WebAssembly, только после контрольных примеров.
  // Без `exports` у программы на TypeScript ничего этого не требуется: прежние выпуски и их отпечатки остаются годными.
  if (needsLogicBuild(manifest)) {
    if (!logic?.length) return `exports: методам на TypeScript нужен исходник ${LOGIC_FILES.typescript}`;
    const built = files[LOGIC_BUILD_FILE];
    if (!built?.length) return `exports: методам на TypeScript нужен собранный ${LOGIC_BUILD_FILE} (соберите программу в Studio или Flux)`;
    if (built.length > LIMITS.tsFileBytes) return `${LOGIC_BUILD_FILE} больше 1 МиБ`;
    const text = bundleText(files, LOGIC_BUILD_FILE);
    if (text === null) return `${LOGIC_BUILD_FILE} не в кодировке UTF-8`;
    if (!text.includes('__fluxLogic')) return `${LOGIC_BUILD_FILE} не похож на собранную логику: его собирает Flux или Studio`;
    if (!files[CONTROLS_FILE]?.length) return `Для методов на TypeScript нужны контрольные примеры: ${CONTROLS_FILE}`;
  }
  if (files[CONTROLS_FILE]) {
    const controls = parseControls(bundleText(files, CONTROLS_FILE) ?? '');
    if (typeof controls === 'string') return controls;
  }
  return '';
}

/**
 * Что запускает оболочка: форма — собранный build/runtime.js, страница (договор v2) — ui/index.html со своими файлами.
 * Страница и runtime.js взаимно исключают друг друга: подписан ровно один вид интерфейса.
 */
export function interfaceProblem(manifest: ModuleManifest, files: BundleFiles): string {
  if (manifest.ui === 'page') {
    if (files[RUNTIME_FILE]) return `Для страницы ${RUNTIME_FILE} не нужен: уберите его из пакета`;
    return pageProblem(files, manifest.pages);
  }
  return files[RUNTIME_FILE]?.length ? '' : `В пакете нет ${RUNTIME_FILE}`;
}
