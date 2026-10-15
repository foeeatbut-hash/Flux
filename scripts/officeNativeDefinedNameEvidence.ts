import JSZip from 'jszip';

/** Только чтение имён и ссылок из одноразового native fixture и сохранённого OOXML. */
export async function captureNativeDefinedNameEvidence(
  frame: any,
  readRaw: () => Promise<{ status: number; bytes: Buffer }>,
  includeImportState = false,
) {
  const [runtime, file] = await Promise.all([
    frame.locator('body').evaluate((captureImportState: boolean) => {
      const workbook = (window as any).__fluxSheets?.univerRef?.current?.univerAPI?.getActiveWorkbook?.();
      const definitions = workbook?.getDefinedNames?.() || [];
      const lazyState = captureImportState ? (window as any).__lazyState : null;
      const importedNames = lazyState?.file?.definedNames;
      const uninstalledNames = lazyState?.uninstalledDefinedNames;
      return {
        count: definitions.length,
        entries: definitions.slice(0, 20).map((item: any) => {
          let name: any, ref: any, formula: any;
          try { name = item?.getName?.(); } catch { name = null; }
          try { ref = item?.getRef?.(); } catch { ref = null; }
          try { formula = item?.getFormulaOrRefString?.(); } catch { formula = null; }
          return {
            entryType: typeof item,
            keys: item && typeof item === 'object' ? Object.keys(item).slice(0, 20) : [],
            primitiveEntry: item === null || ['string', 'number', 'boolean'].includes(typeof item) ? item : null,
            name: name === null || ['string', 'number', 'boolean'].includes(typeof name) ? name : null,
            nameType: typeof name,
            ref: ref === null || ['string', 'number', 'boolean'].includes(typeof ref) ? ref : null,
            refType: typeof ref,
            formula: formula === null || ['string', 'number', 'boolean'].includes(typeof formula) ? formula : null,
            formulaType: typeof formula,
          };
        }),
        importState: lazyState ? {
          definedNamesCount: Array.isArray(importedNames) ? importedNames.length : null,
          definedNames: Array.isArray(importedNames) ? importedNames.slice(0, 20).map((item: any) => ({
            entryType: typeof item,
            keys: item && typeof item === 'object' ? Object.keys(item).slice(0, 20) : [],
            primitiveEntry: item === null || ['string', 'number', 'boolean'].includes(typeof item) ? item : null,
            name: typeof item?.name === 'string' ? item.name.slice(0, 1000) : ['number', 'boolean'].includes(typeof item?.name) ? item.name : null,
            nameType: typeof item?.name,
            formula: typeof item?.formula === 'string' ? item.formula.slice(0, 1000) : ['number', 'boolean'].includes(typeof item?.formula) ? item.formula : null,
            formulaType: typeof item?.formula,
            sheetIndex: item?.sheetIndex === null || ['string', 'number', 'boolean'].includes(typeof item?.sheetIndex) ? item.sheetIndex : null,
            sheetIndexType: typeof item?.sheetIndex,
          })) : null,
          uninstalledNames: uninstalledNames && typeof uninstalledNames[Symbol.iterator] === 'function'
            ? [...uninstalledNames].slice(0, 20).map((name: unknown) => typeof name === 'string' ? name.slice(0, 255) : null)
            : null,
        } : null,
      };
    }, includeImportState).catch((error: unknown) => ({ error: String(error) })),
    readRaw(),
  ]);
  if (file.status !== 200) return { runtime, ooxmlStatus: file.status, ooxmlDefinedNames: null };
  try {
    const zip = await JSZip.loadAsync(file.bytes);
    const xml = await zip.file('xl/workbook.xml')?.async('string') || '';
    const section = /<definedNames\b[^>]*>([\s\S]*?)<\/definedNames>|<definedNames\b[^>]*\/>/.exec(xml)?.[1] || '';
    const entries = [...section.matchAll(/<definedName\b([^>]*?)(?:\/>|>([\s\S]*?)<\/definedName>)/g)].slice(0, 20).map((match) => {
      const attributes = (match[1] || '').slice(0, 1000);
      const attribute = (key: string) => new RegExp(`\\b${key}="([^"]*)"`).exec(attributes)?.[1] ?? null;
      const name = attribute('name')?.replaceAll('&amp;', '&').replaceAll('&quot;', '"').replaceAll('&apos;', "'").replaceAll('&lt;', '<').replaceAll('&gt;', '>') || '';
      const ref = (match[2] || '').trim().replace(/^=/, '');
      const anchor = /^FLUX_ANCHOR_([0-9a-f_-]{36})$/i.exec(name);
      return { name, anchorId: anchor?.[1]?.replaceAll('_', '-') || null, ref, attributes, hidden: attribute('hidden'), localSheetId: attribute('localSheetId') };
    });
    return { runtime, ooxmlStatus: file.status, ooxmlDefinedNames: { count: entries.length, entries } };
  } catch (error) {
    return { runtime, ooxmlStatus: file.status, ooxmlDefinedNames: null, ooxmlError: String(error) };
  }
}
