import JSZip from 'jszip';
import { createHash } from 'node:crypto';
import { makeDocx, makeXlsx } from './officeHarness';
import { readOfficeBindings, writeOfficeBindings, type OfficePackageBindings } from '../server/officeBindings';

let ok = 0, fail = 0;
const eq = (name: string, got: unknown, want: unknown) => {
  if (JSON.stringify(got) === JSON.stringify(want)) ok++;
  else { fail++; console.error(`  ✗ ${name}\n      получили ${JSON.stringify(got)}\n      ждали    ${JSON.stringify(want)}`); }
};
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
async function partHashes(bytes: Buffer) {
  const zip = await JSZip.loadAsync(bytes), out = new Map<string, string>();
  for (const [name, entry] of Object.entries(zip.files)) if (!entry.dir) out.set(name, sha(await entry.async('uint8array')));
  return out;
}

const schema: OfficePackageBindings = {
  version: 1, schemaVersion: 1, sourceRevision: 'R18',
  anchors: [{ id: 'header-power', kind: 'excel-range', sheet: 'Ведомость', address: 'C2', parts: [{ kind: 'field', binding: { fieldKey: 'power', sourceId: 'equipment', entityType: 'element', entityId: null, sourceRevision: 'R18', unit: 'кВт', anchorId: 'header-power' } }] }],
  rows: [{ entityId: 'EQ-003', entityType: 'element', sourceId: 'equipment', sourceRevision: 'R18', anchorIds: ['header-power'] }],
};

async function check(label: string, original: Buffer) {
  const written = await writeOfficeBindings(original, schema);
  eq(`${label}: метаданные читаются после записи`, await readOfficeBindings(written), schema);
  eq(`${label}: повторная запись схемы не создаёт дубль`, (await readOfficeBindings(await writeOfficeBindings(written, schema)))?.anchors.length, 1);
  const before = await partHashes(original), after = await partHashes(written);
  const allowed = new Set(['customXml/itemFluxOffice.xml', '_rels/.rels', '[Content_Types].xml']);
  const touched = [...new Set([...before.keys(), ...after.keys()])].filter((name) => before.get(name) !== after.get(name));
  eq(`${label}: запись меняет только скрытую часть и связи пакета`, touched.every((name) => allowed.has(name)), true);
  eq(`${label}: исходные части пакета сохранены`, touched.filter((name) => !allowed.has(name)), []);
  const zip = await JSZip.loadAsync(written);
  zip.file('customXml/itemFluxOffice.xml', '<fluxOffice>broken</fluxOffice>');
  eq(`${label}: повреждённая скрытая схема не трактуется как пустая`, await readOfficeBindings(await zip.generateAsync({ type: 'nodebuffer' })).then(() => 'no error', () => 'error'), 'error');
}

(async () => {
  await check('DOCX', await makeDocx());
  await check('XLSX', await makeXlsx());
  console.log(`\n${ok} проверок пройдено, ${fail} провалено`);
  process.exit(fail ? 1 : 0);
})();
