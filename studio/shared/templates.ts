/**
 * Заготовки проекта подпрограммы под каждый язык, который исполняет Flux.
 *
 * Заготовка — рабочий пример «статистика числовых параметров» из modules/fixtures:
 * тот же расчёт, та же форма и те же контрольные примеры на всех языках, поэтому новый
 * проект сразу проходит проверку перед отправкой и его есть от чего отталкивать. Для
 * языков, которые собираются в WebAssembly, в проект кладётся и готовый `.wasm`, и
 * исходник с `build.sh`: Studio компилятор не содержит, разработчик собирает своим.
 *
 * Корень с файлами примеров приходит параметром: в репозитории это `modules/fixtures`,
 * в упакованной Studio — каталог `templates` рядом с программой (studio/build-assets.cjs).
 */
import fs from 'node:fs';
import path from 'node:path';
import { LOGIC_FILES, type ModuleLanguage, type SourceLanguage } from '../../modules/engine/types';
import { MODULE_ID } from '../../modules/trust/claims';
import { PAGE_MIN_FLUX } from '../../modules/page/model';
import { fluxPageTypes, FLUX_TYPES_FILE } from '../../modules/page/types';
import { PAGE_INDEX, PAGE_SCRIPT, PAGE_STYLE } from './pageTemplate';

/** form — экран из form.json (договор v1); page — свой экран кодом в ui/ (договор v2) */
export type ProjectKind = 'form' | 'page';

export const TEMPLATE_IDS = ['typescript', 'python', 'c', 'cpp', 'rust', 'go', 'csharp', 'translator'] as const;
export type TemplateId = typeof TEMPLATE_IDS[number];
export type ProjectFiles = Record<string, Uint8Array>;

export interface TemplateInfo {
  id: TemplateId; title: string; language: ModuleLanguage; sourceLanguage?: SourceLanguage; note: string;
  /** Готовый проект целиком (modules/fixtures/<папка>): файлы берутся как есть, меняются только id, название, версия и автор */
  fixture?: string;
  /** Что записать в «что нового» нового проекта: пример проходит проверку перед отправкой без доработок */
  changelog?: string;
}

export const TEMPLATES: readonly TemplateInfo[] = [
  { id: 'typescript', title: 'JavaScript / TypeScript', language: 'typescript', note: 'Логика в одном файле logic/main.ts исполняется в изолированном окне подпрограммы.' },
  { id: 'python', title: 'Python', language: 'python', note: 'Исполняется общей средой Python во Flux; контрольные примеры обязательны.' },
  { id: 'c', title: 'C', language: 'wasm', sourceLanguage: 'c', note: 'Исходник src/main.c; готовый logic/main.wasm собирается build.sh на вашем компьютере.' },
  { id: 'cpp', title: 'C++', language: 'wasm', sourceLanguage: 'cpp', note: 'Исходник src/main.cpp; готовый logic/main.wasm собирается build.sh на вашем компьютере.' },
  { id: 'rust', title: 'Rust', language: 'wasm', sourceLanguage: 'rust', note: 'Крейт в Cargo.toml и src/lib.rs; цель wasm32-unknown-unknown.' },
  { id: 'go', title: 'Go (TinyGo)', language: 'wasm', sourceLanguage: 'go', note: 'main.go собирается TinyGo с целью wasm-unknown.' },
  {
    id: 'translator', title: 'Пример: Переводчик терминов (TypeScript)', language: 'typescript', fixture: 'translator',
    note: 'Готовая программа с кодом, формой, контрольными примерами и снимками: переводит технические термины RU и EN по словарю в logic/main.ts. Проходит проверку перед отправкой без доработок.',
    changelog: 'Первая версия: перевод технических терминов между русским и английским по встроенному словарю (КИПиА, трубопроводы, электрика, документация), поиск по части слова, подсказки похожих, перевод списка строк и список слов, которых нет в словаре.',
  },
  { id: 'csharp', title: 'C# (.NET 8)', language: 'wasm', sourceLanguage: 'csharp', note: 'Program.cs собирается как WASI-команда; результат больше остальных.' },
];

/** Исходники рядом с .wasm: владелец проверяет их вместе с собранным файлом */
const SOURCES: Record<TemplateId, string[]> = {
  typescript: [], translator: [], python: [], c: ['src/main.c', 'build.sh'], cpp: ['src/main.cpp', 'build.sh'],
  rust: ['src/lib.rs', 'Cargo.toml', 'build.sh'], go: ['main.go', 'go.mod', 'build.sh'], csharp: ['Program.cs', 'FluxStats.csproj', 'build.sh'],
};

const encode = (text: string) => new TextEncoder().encode(text);

/**
 * Пример логики на TypeScript считает через `compute` (по ней идут контрольные примеры), а форму наполняет обработчик
 * `setup`: окно подпрограммы вызывает его при каждом изменении данных и берёт `calc.out` в привязки формы. На других
 * языках форму наполняет сам расчёт — окно Flux вызывает его само, поэтому обработчика там нет.
 */
const TYPESCRIPT_SETUP = `
// Обработчик для формы: при открытии и при каждом изменении данных Flux читает позицию и кладёт результат в calc.out
export function setup({ flux, calc }: { flux: { read(resource: string): Promise<unknown>; on(event: 'changed', listener: () => void | Promise<void>): void }; calc: { out: Record<string, unknown> } }) {
  flux.on('changed', async () => {
    const equipment = await flux.read('equipment');
    calc.out = compute({ flux: { equipment } } as Input).calc.out;
  });
}
`;

export function validProjectId(id: string): string {
  return MODULE_ID.test(id) ? '' : 'Идентификатор — латинские строчные буквы, цифры и дефис, начинается с буквы, не длиннее 64 знаков.';
}

/** Новый проект из заготовки. Идентификатор, имя и автор подставляются в manifest.json */
export function createFromTemplate(root: string, template: TemplateId, p: { id: string; name: string; author: string }, kind: ProjectKind = 'form'): ProjectFiles {
  const info = TEMPLATES.find(item => item.id === template);
  if (!info) throw new Error('Неизвестная заготовка.');
  const bad = validProjectId(p.id);
  if (bad) throw new Error(bad);
  const name = p.name.trim();
  if (!name || name.length > 80) throw new Error('Название — от 1 до 80 знаков.');
  const read = (...parts: string[]) => new Uint8Array(fs.readFileSync(path.join(root, ...parts)));
  if (info.fixture && kind === 'page') throw new Error('Заготовка-пример собрана с формой; для своей страницы выберите язык.');
  if (info.fixture) return createFromFixture(path.join(root, info.fixture), p, name);
  const sample = JSON.parse(Buffer.from(read(template, 'manifest.json')).toString('utf8'));
  const manifest = {
    ...sample, id: p.id, name, version: '0.1.0', author: p.author.trim().slice(0, 80) || 'Разработчик',
    store: { category: 'calc', summary: 'Считает статистику числовых параметров выбранной позиции оборудования.' },
  };
  const files: ProjectFiles = {
    'manifest.json': encode(`${JSON.stringify(manifest, null, 2)}\n`),
    'form.json': read('stats', 'form.json'),
    'examples/controls.json': read('stats', 'controls.json'),
    [LOGIC_FILES[info.language]]: template === 'typescript' ? encode(Buffer.from(read(template, sample.logic)).toString('utf8') + TYPESCRIPT_SETUP) : read(template, sample.logic),
  };
  for (const source of SOURCES[template]) files[source] = read(template, source);
  if (kind === 'page') {
    // Страница вместо формы: договор v2, логика и контрольные примеры те же, а экран рисует ui/
    delete files['form.json'];
    files['manifest.json'] = encode(`${JSON.stringify({ ...manifest, contractVersion: 2, ui: 'page', store: { category: 'calc', summary: 'Считает статистику чисел и рисует график.', requires: { flux: PAGE_MIN_FLUX } } }, null, 2)}\n`);
    files['ui/index.html'] = encode(PAGE_INDEX);
    files['ui/app.js'] = encode(PAGE_SCRIPT);
    files['ui/style.css'] = encode(PAGE_STYLE);
    files[FLUX_TYPES_FILE] = encode(fluxPageTypes());
  }
  return files;
}

/** Все файлы папки проекта с относительными путями через «/» */
function walk(dir: string, prefix = ''): ProjectFiles {
  const out: ProjectFiles = {};
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) Object.assign(out, walk(path.join(dir, entry.name), `${prefix}${entry.name}/`));
    else out[`${prefix}${entry.name}`] = new Uint8Array(fs.readFileSync(path.join(dir, entry.name)));
  }
  return out;
}

function createFromFixture(dir: string, p: { id: string; author: string }, name: string): ProjectFiles {
  const files = walk(dir);
  const sample = JSON.parse(Buffer.from(files['manifest.json']).toString('utf8'));
  files['manifest.json'] = encode(`${JSON.stringify({ ...sample, id: p.id, name, version: '0.1.0', author: p.author.trim().slice(0, 80) || 'Разработчик' }, null, 2)}\n`);
  return files;
}
