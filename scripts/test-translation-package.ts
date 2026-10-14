import assert from 'node:assert/strict';
import JSZip from 'jszip';
import { FLUX_PART, putFluxPart } from '../office/fluxPart.js';
import { mergeOfficeTranslationPackage, readOfficeTranslationPackage } from '../src/lib/officeTranslationPackage.js';
import type { OfficeTranslationRecord } from '../src/translate/placement.js';

void (async () => {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', '<Types></Types>');
  zip.file('_rels/.rels', '<Relationships></Relationships>');
  zip.file('word/document.xml', '<document/>');
  const seed = Buffer.from(await zip.generateAsync({ type: 'nodebuffer' }));
  const originalBindings = {
    version: 1, schemaVersion: 1, sourceRevision: 'source-r1',
    anchors: [{ id: 'a1', kind: 'word-row', parts: ['p1'] }],
    rows: [{ entityId: 'entity-1', entityType: 'item', sourceId: 'source-1', sourceRevision: 'r1', anchorIds: ['a1'] }],
    template: { templateId: 'template-1', appliedAt: '2026-10-01T00:00:00.000Z', anchors: [{ id: 'a1', kind: 'word-row', parts: ['p1'] }] },
    translations: [], translationBindings: [], displayLabels: {},
  };
  const withFlux = await putFluxPart(seed, `<fluxOffice xmlns="urn:flux:office:v1">${JSON.stringify(originalBindings).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')}</fluxOffice>`);
  const record: OfficeTranslationRecord = {
    sourceId: 'paragraph:1', key: 'word:1:range:0-5', destination: 'ru', revision: 'rev-1', time: 12,
    mode: 'after-paragraph', scope: 'document', targetLocation: { anchorId: 'paragraph:1', targetLocation: 'paragraph:2' },
    targetText: 'Привет', sourceText: 'Hello',
  };
  const delta = { records: [record], bindings: [{ sourceId: record.sourceId, key: record.key, targetText: record.targetText, targetLocation: record.targetLocation }], displayLabels: { [record.key]: 'Абзац 1' } };
  const merged = await mergeOfficeTranslationPackage(withFlux, delta);
  const metadata = await readOfficeTranslationPackage(merged, 'sha-1');
  assert.equal(metadata.records.length, 1);
  assert.equal(metadata.records[0].targetText, 'Привет');
  assert.equal(metadata.displayLabels[record.key], 'Абзац 1');
  assert.equal(metadata.bindings.length, 1);
  const parsed = await JSZip.loadAsync(merged);
  const part = await parsed.file(FLUX_PART)!.async('string');
  const json = JSON.parse(part.match(/^<fluxOffice xmlns="urn:flux:office:v1">([\s\S]*)<\/fluxOffice>$/)![1].replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&'));
  assert.equal(json.rows[0].entityId, 'entity-1', 'existing source metadata survives translation writes');
  assert.equal(json.template.templateId, 'template-1', 'template snapshot survives translation writes');
  const repeated = await mergeOfficeTranslationPackage(merged, delta);
  assert.equal((await readOfficeTranslationPackage(repeated, 'sha-2')).records.length, 1, 'repeat writes do not duplicate a translation record');

  const corrupted = await putFluxPart(seed, '<fluxOffice xmlns="urn:flux:office:v1">{bad</fluxOffice>');
  await assert.rejects(() => readOfficeTranslationPackage(corrupted, 'sha-3'), /повреждена/);
  console.log('office translation package: metadata merge, preservation, dedupe, and malformed-part rejection passed');
})();
