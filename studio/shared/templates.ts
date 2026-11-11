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

export const TEMPLATE_IDS = ['typescript', 'python', 'c', 'cpp', 'rust', 'go', 'csharp'] as const;
export type TemplateId = typeof TEMPLATE_IDS[number];
export type ProjectFiles = Record<string, Uint8Array>;

export interface TemplateInfo { id: TemplateId; title: string; language: ModuleLanguage; sourceLanguage?: SourceLanguage; note: string }

export const TEMPLATES: readonly TemplateInfo[] = [
  { id: 'typescript', title: 'JavaScript / TypeScript', language: 'typescript', note: 'Логика в одном файле logic/main.ts исполняется в изолированном окне подпрограммы.' },
  { id: 'python', title: 'Python', language: 'python', note: 'Исполняется общей средой Python во Flux; контрольные примеры обязательны.' },
  { id: 'c', title: 'C', language: 'wasm', sourceLanguage: 'c', note: 'Исходник src/main.c; готовый logic/main.wasm собирается build.sh на вашем компьютере.' },
  { id: 'cpp', title: 'C++', language: 'wasm', sourceLanguage: 'cpp', note: 'Исходник src/main.cpp; готовый logic/main.wasm собирается build.sh на вашем компьютере.' },
  { id: 'rust', title: 'Rust', language: 'wasm', sourceLanguage: 'rust', note: 'Крейт в Cargo.toml и src/lib.rs; цель wasm32-unknown-unknown.' },
  { id: 'go', title: 'Go (TinyGo)', language: 'wasm', sourceLanguage: 'go', note: 'main.go собирается TinyGo с целью wasm-unknown.' },
  { id: 'csharp', title: 'C# (.NET 8)', language: 'wasm', sourceLanguage: 'csharp', note: 'Program.cs собирается как WASI-команда; результат больше остальных.' },
];

/** Исходники рядом с .wasm: владелец проверяет их вместе с собранным файлом */
const SOURCES: Record<TemplateId, string[]> = {
  typescript: [], python: [], c: ['src/main.c', 'build.sh'], cpp: ['src/main.cpp', 'build.sh'],
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
export function createFromTemplate(root: string, template: TemplateId, p: { id: string; name: string; author: string }): ProjectFiles {
  const info = TEMPLATES.find(item => item.id === template);
  if (!info) throw new Error('Неизвестная заготовка.');
  const bad = validProjectId(p.id);
  if (bad) throw new Error(bad);
  const name = p.name.trim();
  if (!name || name.length > 80) throw new Error('Название — от 1 до 80 знаков.');
  const read = (...parts: string[]) => new Uint8Array(fs.readFileSync(path.join(root, ...parts)));
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
  return files;
}
