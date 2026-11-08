/**
 * Пакеты примера «статистика числовых параметров» на всех языках логики Flux.
 * Один и тот же расчёт, один и тот же набор контрольных примеров
 * (modules/fixtures/stats/controls.json) — на TypeScript, Python, C, C++, Rust, Go и C#.
 */
import fs from 'node:fs';
import path from 'node:path';
import { parseControls, type Controls } from '../../modules/engine/controls';
import { packBundle } from '../../modules/trust/bundle';

export const FIXTURE_LANGUAGES = ['typescript', 'python', 'c', 'cpp', 'rust', 'go', 'csharp'] as const;
export type FixtureLanguage = typeof FIXTURE_LANGUAGES[number];
export const WASM_LANGUAGES = ['c', 'cpp', 'rust', 'go', 'csharp'] as const;
const ROOT = path.join(__dirname, '..', '..', 'modules', 'fixtures');
/** Исходники, которые владелец смотрит вместе с .wasm */
const SOURCES: Record<FixtureLanguage, string[]> = {
  typescript: [], python: [], c: ['src/main.c', 'build.sh'], cpp: ['src/main.cpp', 'build.sh'],
  rust: ['src/lib.rs', 'Cargo.toml', 'build.sh'], go: ['main.go', 'go.mod', 'build.sh'], csharp: ['Program.cs', 'FluxStats.csproj', 'build.sh'],
};
const read = (...parts: string[]) => fs.readFileSync(path.join(ROOT, ...parts));

export const statsControlsText = () => read('stats', 'controls.json').toString('utf8');
export const statsControls = () => parseControls(statsControlsText()) as Controls;
export const fixtureManifest = (lang: FixtureLanguage) => JSON.parse(read(lang, 'manifest.json').toString('utf8'));
export const logicBytes = (lang: FixtureLanguage) => new Uint8Array(read(lang, fixtureManifest(lang).logic));

export function languageFiles(lang: FixtureLanguage, patch: Record<string, unknown> = {}, extra: Record<string, Uint8Array | string> = {}): Record<string, Uint8Array | string> {
  const manifest = { ...fixtureManifest(lang), ...patch };
  const files: Record<string, Uint8Array | string> = {
    'manifest.json': JSON.stringify(manifest, null, 2),
    'form.json': read('stats', 'form.json').toString('utf8'),
    'examples/controls.json': statsControlsText(),
    [manifest.logic]: new Uint8Array(read(lang, manifest.logic)),
    'build/runtime.js': `/* runtime ${manifest.id} */`,
  };
  for (const source of SOURCES[lang]) files[source] = read(lang, source).toString('utf8');
  return { ...files, ...extra };
}
export const languageBundle = (lang: FixtureLanguage, patch: Record<string, unknown> = {}, extra: Record<string, Uint8Array | string> = {}) => packBundle(languageFiles(lang, patch, extra));
