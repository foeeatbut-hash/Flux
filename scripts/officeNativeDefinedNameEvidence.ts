import JSZip from 'jszip';

/** Только чтение имён и ссылок из одноразового native fixture и сохранённого OOXML. */
export async function captureNativeDefinedNameEvidence(frame: any, readRaw: () => Promise<{ status: number; bytes: Buffer }>) {
  const [runtime, file] = await Promise.all([
    frame.locator('body').evaluate(() => {
      const workbook = (window as any).__fluxSheets?.univerRef?.current?.univerAPI?.getActiveWorkbook?.();
      const definitions = workbook?.getDefinedNames?.() || [];
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
      };
    }).catch((error: unknown) => ({ error: String(error) })),
    readRaw(),
  ]);
  if (file.status !== 200) return { runtime, ooxmlStatus: file.status, ooxmlDefinedNames: null };
  try {
    const zip = await JSZip.loadAsync(file.bytes);
    const xml = await zip.file('xl/workbook.xml')?.async('string') || '';
    const section = /<definedNames\b[^>]*>([\s\S]*?)<\/definedNames>|<definedNames\b[^>]*\/>/.exec(xml)?.[1] || '';
    const entries = [...section.matchAll(/<definedName\b([^>]*?)(?:\/>|>([\s\S]*?)<\/definedName>)/g)].slice(0, 20).map((match) => {
      const name = /\bname="([^"]*)"/.exec(match[1] || '')?.[1]?.replaceAll('&amp;', '&').replaceAll('&quot;', '"').replaceAll('&apos;', "'").replaceAll('&lt;', '<').replaceAll('&gt;', '>') || '';
      const ref = (match[2] || '').trim().replace(/^=/, '');
      const anchor = /^FLUX_ANCHOR_([0-9a-f_-]{36})$/i.exec(name);
      return { name, anchorId: anchor?.[1]?.replaceAll('_', '-') || null, ref };
    });
    return { runtime, ooxmlStatus: file.status, ooxmlDefinedNames: { count: entries.length, entries } };
  } catch (error) {
    return { runtime, ooxmlStatus: file.status, ooxmlDefinedNames: null, ooxmlError: String(error) };
  }
}
