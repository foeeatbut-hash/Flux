/**
 * Стенд панели «Переводчик» без настоящих редакторов (scripts/test-office-translator-ui.ts).
 * Фальшивый редактор отвечает по протоколу translation-bridge.ts через те же docsTranslationEditor /
 * sheetsTranslationEditor, что и окна Flux; файл и сервер подменены записью в window.__fake.
 */
import React from 'react';
import { createRoot } from 'react-dom/client';
import '../../src/index.css';
import TextTranslationPanel from '../../src/components/office/TextTranslationPanel';
import { TranslationBridgeProvider } from '../../src/components/office/TranslationBridgeContext';
import { createTranslationFlow } from '../../src/components/office/useOfficeTranslation';
import { TRANSLATION_CHANNELS, createTranslationSlot, docsTranslationEditor, sheetsTranslationEditor } from '../../src/components/office/officeTranslationLinks';
import { useTranslateStore } from '../../src/store/translateStore';

const params = new URLSearchParams(location.search);
const app = params.get('app') === 'sheets' ? 'sheets' : 'docs';
if (params.get('theme') === 'dark') document.documentElement.classList.add('dark');

const chip = String.fromCharCode(0xe5c0);
const hash = (text: string) => `h${text.length}`;
const initialUnits = app === 'docs'
  ? [
      { key: 'p1', source: 'Расход воздуха', location: { blockFrom: 1 }, status: 'new' },
      { key: 'p2', source: `Установка ${chip} в сборе, AHU-01`, location: { blockFrom: 5 }, status: 'new', chips: 1 },
      { key: 'p3', source: 'Давление сети', location: { blockFrom: 9 }, status: 'stale', targetText: 'Network pressure (old)' },
      { key: 'p4', source: 'Температура', location: { blockFrom: 12 }, status: 'current', targetText: 'Temperature' },
    ]
  : [
      { key: 'Лист1!A1', source: 'Наименование', location: { sheetName: 'Лист1', address: 'A1' }, status: 'new' },
      { key: 'Лист1!B1', source: 'Количество', location: { sheetName: 'Лист1', address: 'B1' }, status: 'stale', targetText: 'Qty (old)' },
      { key: 'Лист1!C1', source: 'Примечание', location: { sheetName: 'Лист1', address: 'C1' }, status: 'current', targetText: 'Note' },
    ];

const fake: any = {
  log: [] as string[], units: initialUnits, records: [] as any[], refuseSave: false, applyCode: '', hold: 0, silent: false,
  slot: createTranslationSlot(), requests: [] as any[],
};
(window as any).__fake = fake;
const log = (line: string) => { fake.log.push(line); };

// Движок подменён: нужен порядок «панель → редактор → файл», а не словарь
useTranslateStore.setState({
  many: (text: string) => [{ src: text, dst: `EN[${text}]`, origin: 'glossary', missing: [] }],
  remember: async () => ({ ok: true, count: 0 }),
} as any);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function editorHandle(kind: 'read' | 'apply' | 'rollback', payload: any): Promise<any> {
  fake.requests.push({ kind, payload });
  await sleep(15 + fake.hold);
  if (fake.silent) return null;
  if (kind === 'read') {
    log(`editor.read:${payload.scope}`);
    return { ok: true, units: fake.units.map((unit: any) => {
      const record = fake.records.find((r: any) => r.key === unit.key);
      if (!record) return unit;
      return { ...unit, status: hash(unit.source) === record.sourceHash ? 'current' : 'stale', targetText: record.targetText };
    }) };
  }
  if (kind === 'rollback') { log(`editor.rollback:${payload.stepId}`); return { ok: true }; }
  if (payload.dryRun) {
    log('editor.preview');
    return { ok: true, preview: payload.items.map((item: any) => ({ key: item.key, location: item.location || {}, before: item.source, after: `${item.source}\n${item.targetText}`, target: 'new-block' })) };
  }
  log(`editor.apply:${payload.placement.mode}:${payload.items.length}`);
  if (fake.applyCode) return { ok: false, code: fake.applyCode };
  if (payload.items.some((item: any) => item.confirmed !== true)) return { ok: false, code: 'not-confirmed' };
  const records = payload.items.map((item: any) => ({
    sourceId: 'doc', key: item.key, destination: payload.direction === 'ru-en' ? 'en' : 'ru', revision: 'h1', time: Date.now(), mode: payload.placement.mode,
    scope: payload.placement.scope, targetLocation: {}, targetText: item.targetText, sourceText: item.source, sourceHash: hash(item.source),
  }));
  if (payload.placement.mode === 'new-file') {
    return app === 'docs' ? { ok: true, records, copy: { bytes: new ArrayBuffer(8), suggestedName: 'Перевод.docx' } } : { ok: true, records, copyRequest: { kind: 'sheets-save-as', saved: false } };
  }
  return { ok: true, records, removeRecords: [], stepId: 'step-1' };
}
const eventKind = (name: string) => {
  const table: any = app === 'docs' ? TRANSLATION_CHANNELS.docs : TRANSLATION_CHANNELS.sheets;
  return (Object.keys(table) as Array<'read' | 'apply' | 'rollback'>).find((kind) => table[kind].event === name)!;
};
const editor = app === 'docs'
  ? docsTranslationEditor((event, _answer, _ms, payload) => editorHandle(eventKind(event), payload) as any)
  : sheetsTranslationEditor((channel, payload) => editorHandle(eventKind(channel), payload));

const state = () => ({ baseHash: 'h1', records: fake.records, displayLabels: {}, schema: undefined });
const slot = fake.slot;
const bridge = createTranslationFlow(() => ({
  app, fileId: 'file-1', readOnly: params.get('readonly') === '1', editor, gate: slot.gate,
  file: {
    state: async () => state(),
    committed: () => slot.own(async () => { log(`file.committed:gate=${slot.gate.busy()}`); return state(); }),
    saveWithTranslation: (delta, baseHash) => slot.own(async () => {
      slot.arm({ delta, token: 'tok-1' });
      try {
        log(`file.save:token=${slot.armed()?.token}:base=${baseHash}:records=${delta.records?.length}:gate=${slot.gate.busy()}`);
        await sleep(20);
        if (fake.refuseSave) { slot.settle(false, 'Файл изменили после того, как вы его открыли. Ваши правки не записаны.'); throw new Error(slot.lastError()); }
        fake.records = [...fake.records.filter((r: any) => !(delta.removeRecords || []).some((x: any) => x.key === r.key)), ...(delta.records || [])];
        return true;
      } finally { slot.disarm(); }
    }),
    saveBackup: async () => { log('file.backup'); },
    saveCopy: async (bytes, name, records) => { log(`file.copy:${name}:${bytes.byteLength}:${records?.length}`); },
    saveSheetsCopy: async (records) => { log(`file.sheets-copy:${records.length}`); },
  },
}));

// Обычное сохранение окна: ждёт ворота, пока идёт постановка
(window as any).__ordinarySave = () => slot.beforeSave().then(() => log('ordinary-save'));

createRoot(document.getElementById('root')!).render(
  <div style={{ width: 360, height: 760, display: 'flex', flexDirection: 'column' }} className="border border-slate-200 bg-white dark:border-dark-border dark:bg-dark-bg">
    <div className="px-3 text-sm font-semibold leading-[44px]">Переводчик</div>
    <div className="min-h-0 flex-1 overflow-auto">
      <TranslationBridgeProvider value={bridge}><TextTranslationPanel /></TranslationBridgeProvider>
    </div>
  </div>,
);
