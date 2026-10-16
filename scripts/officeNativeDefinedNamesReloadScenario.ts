import { randomUUID } from 'node:crypto';
import JSZip from 'jszip';
import { makeXlsxWithManualRow } from './officeHarness';
import { captureNativeDefinedNameEvidence } from './officeNativeDefinedNameEvidence';

export type NativeDefinedNamesReloadContext = {
  fixture: { projectId: string };
  folderId: string;
  stamp: string;
  created: string[];
  api: (method: string, route: string, body?: unknown) => Promise<any>;
  raw: (method: string, route: string, bytes?: Buffer, headers?: Record<string, string>) => Promise<any>;
  upload: (folderId: string, name: string, type: string, bytes: Buffer) => Promise<string>;
  check: (label: string, good: unknown, detail?: unknown) => void;
  waitFor: (probe: () => Promise<boolean>, timeout?: number) => Promise<boolean>;
  resetPage: (dark?: boolean) => Promise<void>;
  navigateOffice: (page: any, route: string) => Promise<void>;
  openPanel: (page: any, title: string) => Promise<any>;
  waitForSheetFile: (frame: any) => Promise<boolean>;
  clickSheetGrid: (frame: any) => Promise<any>;
  page: () => any;
};

type ExpectedName = { name: string; ref: string };

function hasExpectedNames(evidence: any, expected: ExpectedName[]): boolean {
  if (evidence?.ooxmlStatus !== 200) return false;
  const xmlNames = evidence?.ooxmlDefinedNames?.entries ?? [];
  const runtimeNames = evidence?.runtime?.entries ?? [];
  if (xmlNames.length !== expected.length || runtimeNames.length !== expected.length) return false;
  const normalize = (value: unknown) => String(value ?? '').replaceAll('$', '').toUpperCase();
  return expected.every((item) => {
    const xml = xmlNames.find((entry: any) => entry.name === item.name);
    const runtime = runtimeNames.find((entry: any) => entry.name === item.name);
    return Boolean(
      xml && runtime &&
      normalize(xml.ref).includes(normalize(item.ref)) &&
      normalize(runtime.ref ?? runtime.formula).includes(normalize(item.ref)) &&
      xml.hidden == null &&
      xml.localSheetId == null,
    );
  });
}

async function makeFixtureWithAnchors(): Promise<{ bytes: Buffer; expected: ExpectedName[] }> {
  const zip = await JSZip.loadAsync(await makeXlsxWithManualRow());
  const workbookFile = zip.file('xl/workbook.xml');
  if (!workbookFile) throw new Error('Fixture is missing xl/workbook.xml');
  let workbookXml = await workbookFile.async('string');
  if (!workbookXml.includes('</definedNames>')) {
    throw new Error('Fixture workbook.xml is missing its definedNames collection');
  }

  const expected: ExpectedName[] = [{ name: 'Итого', ref: "'Перечень'!$B$4" }];
  const additions = ['A1', 'A2'].map((address) => {
    const name = `FLUX_ANCHOR_${randomUUID().replaceAll('-', '_')}`;
    const ref = `'Перечень'!$${address[0]}$${address.slice(1)}`;
    expected.push({ name, ref });
    return `<definedName name="${name}">${ref}</definedName>`;
  });
  workbookXml = workbookXml.replace('</definedNames>', `${additions.join('')}</definedNames>`);
  zip.file('xl/workbook.xml', workbookXml);
  return { bytes: await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }), expected };
}

export async function runNativeDefinedNamesReloadScenario(
  ctx: NativeDefinedNamesReloadContext,
): Promise<void> {
  const { folderId, stamp, created, upload, check, waitFor, resetPage, navigateOffice, openPanel,
    waitForSheetFile, clickSheetGrid, raw } = ctx;
  const { bytes, expected } = await makeFixtureWithAnchors();
  const fileId = await upload(folderId, `__native_defined_names_reload_${stamp}.xlsx`, 'XLSX', bytes);
  created.push(fileId);
  const route = `/office-sheet?file=${encodeURIComponent(fileId)}`;

  await resetPage(false);
  let page = ctx.page();
  await navigateOffice(page, route);
  let frame = await openPanel(page, 'Flux Office — Таблица');
  check('native workbook opened', await waitForSheetFile(frame));
  await clickSheetGrid(frame);

  const capture = () => captureNativeDefinedNameEvidence(
    frame,
    () => raw('GET', `/api/files/${encodeURIComponent(fileId)}/raw`),
  );
  let evidence: any;
  const checkNames = async (stage: string, label: string, names: ExpectedName[]) => {
    const passed = await waitFor(async () => {
      evidence = await capture();
      return hasExpectedNames(evidence, names);
    });
    if (!passed) console.error('NATIVE_DEFINED_NAMES_RELOAD_DIAGNOSTIC', JSON.stringify({ stage, expected: names, evidence }));
    check(label, passed, { expected: names, evidence });
  };
  await checkNames('initial-import', 'fixture names imported', expected);

  const runtimeName = `FLUX_ANCHOR_${randomUUID().replaceAll('-', '_')}`;
  const runtimeRef = "'Перечень'!$A$3";
  const commandTrace = await frame.locator('body').evaluate(() => {
    const win = window as any;
    const api = win.__fluxSheets?.univerRef?.current?.univerAPI;
    const eventType = api?.Event?.CommandExecuted;
    if (!api || eventType === undefined || typeof api.addEvent !== 'function') {
      return { available: false, eventType: eventType ?? null };
    }
    const trace: any = { available: true, eventType, command: null };
    win.__fluxDefinedNameCommandTrace = trace;
    api.addEvent(eventType, (...args: any[]) => {
      if (trace.command) return;
      const command = args.find((arg) => arg && typeof arg === 'object' && ('id' in arg || 'params' in arg)) ?? args[0];
      try {
        const snapshot = JSON.parse(JSON.stringify(command));
        if (JSON.stringify(snapshot).includes(win.__fluxDefinedNameCommandName)) {
          trace.command = { id: snapshot?.id ?? null, params: snapshot?.params ?? null, raw: snapshot };
        }
      } catch { /* объект команды может содержать непередаваемое состояние runtime */ }
    });
    win.__fluxDefinedNameCommandName = '';
    return { available: true, eventType };
  }).catch((error: unknown) => ({ available: false, error: String(error) }));
  await frame.locator('body').evaluate((name: string) => { (window as any).__fluxDefinedNameCommandName = name; }, runtimeName);
  const insertion = await frame.locator('body').evaluate(
    ({ name, ref }: { name: string; ref: string }) => {
      const api = (window as any).__fluxSheets?.univerRef?.current?.univerAPI;
      const workbook = api?.getActiveWorkbook?.();
      const insert = workbook?.insertDefinedName;
      if (!workbook || typeof insert !== 'function') {
        return { ok: false, availableWorkbook: Boolean(workbook), insertType: typeof insert };
      }
      try {
        const result = insert.call(workbook, name, ref);
        return { ok: true, availableWorkbook: true, insertType: typeof insert, returnType: typeof result };
      } catch (error: any) {
        return { ok: false, availableWorkbook: true, insertType: typeof insert,
          error: String(error?.message || error), stack: String(error?.stack || '').slice(0, 3000) };
      }
    },
    { name: runtimeName, ref: runtimeRef },
  ).catch((error: unknown) => ({ ok: false, availableWorkbook: null, insertType: null,
    error: String(error), stack: String((error as any)?.stack || '').slice(0, 3000) }));
  if (!insertion.ok) console.error('NATIVE_DEFINED_NAME_INSERT_DIAGNOSTIC', JSON.stringify({ name: runtimeName, ref: runtimeRef, ...insertion }));
  check('runtime defined name inserted', insertion.ok, { name: runtimeName, ref: runtimeRef, ...insertion });
  const commandEvidence = await frame.locator('body').evaluate(() => (window as any).__fluxDefinedNameCommandTrace || null)
    .catch((error: unknown) => ({ error: String(error) }));
  console.log('NATIVE_DEFINED_NAME_COMMAND_TRACE', JSON.stringify({ subscription: commandTrace, command: commandEvidence?.command ?? null }));
  check('insertDefinedName command event observed', Boolean(commandTrace.available && commandEvidence?.command?.id && commandEvidence?.command?.params), {
    name: runtimeName, subscription: commandTrace, command: commandEvidence,
  });
  const allExpected = [...expected, { name: runtimeName, ref: runtimeRef }];

  await page.keyboard.press('Control+s');
  check('save settled', await waitForSheetFile(frame));
  await checkNames('after-save', 'saved raw and runtime names retained', allExpected);

  await resetPage(false);
  page = ctx.page();
  await navigateOffice(page, route);
  frame = await openPanel(page, 'Flux Office — Таблица');
  check('reloaded workbook opened', await waitForSheetFile(frame));
  await clickSheetGrid(frame);
  await checkNames('after-reload', 'all defined names retained after reload', allExpected);
}
