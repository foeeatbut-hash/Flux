/** Проверки ручного пакета ВЕЗА: npx tsx scripts/test-catalog-pack-veza2026.ts */
import { veza2026Pack } from '../catalog/packs/veza2026';
import { buildDesignation, parseWithFamily, sameDesignation } from '../catalog/designation';
import { checkConfig } from '../catalog/rules';

let failures = 0;
const check = (label: string, condition: boolean, detail?: unknown) => {
  if (condition) console.log('✓', label);
  else { failures++; console.error('✗', label, detail ?? ''); }
};
const osa300 = veza2026Pack.families.find((family) => family.id === 'veza-osa-300')!;
const osa301 = veza2026Pack.families.find((family) => family.id === 'veza-osa-301')!;

const designation = 'ОСА300-050/Б-50-Н-00400/2-У1-02';
const parsed = parseWithFamily(osa300, designation);
check('sample contains seven independently represented positions', parsed.complete && Object.keys(parsed.values).length === 8, parsed);
check('wheel modification, wheel index, motor code and poles stay separate', [parsed.values.fanSize, parsed.values.wheelMod, parsed.values.wheelIndex, parsed.values.motorIndex, parsed.values.poles, parsed.values.body].join('|') === '050|Б|50|00400|2|02', parsed.values);
const rebuilt = buildDesignation(osa300, parsed.values);
check('sample designation round trips without losing zeroes or slash fields', sameDesignation(rebuilt.text, designation), rebuilt.text);
for (const [family, variant] of [
  [osa300, 'ОСА300-040/А-40-К-00400/2-УХЛ1-01'],
  [osa301, 'ОСА301-071/Е-45-К-00400/6-У2-01'],
] as const) {
  const result = parseWithFamily(family, variant);
  check(`${family.code} alternate marking round trips`, result.complete && sameDesignation(buildDesignation(family, result.values).text, variant), result);
}

for (const [fanSize, valid] of [['063', true], ['071', false]] as const) {
  const result = checkConfig(osa300, { fanSize, poles: '2' });
  check(`2-pole availability for size ${fanSize}`, valid ? !result.some((item) => item.ruleId === 'osa-300-poles-2') : result.some((item) => item.ruleId === 'osa-300-poles-2'), result);
}
for (const [fanSize, valid] of [['071', true], ['063', false]] as const) {
  const result = checkConfig(osa301, { fanSize, poles: '6' });
  check(`6-pole availability for size ${fanSize}`, valid ? !result.some((item) => item.ruleId === 'osa-301-poles-6') : result.some((item) => item.ruleId === 'osa-301-poles-6'), result);
}

check('OSA 301 does not offer explosion-proof or UHL1 marking choices',
  !osa301.params.find((param) => param.key === 'execution')?.values?.some((value) => ['В', 'ВС', 'ВК', 'ВСК'].includes(value.code)) &&
  !osa301.params.find((param) => param.key === 'climate')?.values?.some((value) => value.code === 'УХЛ1'));
check('the only performance row is explicitly verified and cites its page',
  osa300.tables?.find((table) => table.id === 'veza-osa-300-040-2-example')?.rows.length === 1 &&
  osa300.tables?.find((table) => table.id === 'veza-osa-300-040-2-example')?.rows[0].source?.physicalPage === 13 &&
  osa300.tables?.find((table) => table.id === 'veza-osa-300-040-2-example')?.rows[0].values.fanSize === '040' &&
  osa300.tables?.find((table) => table.id === 'veza-osa-300-040-2-example')?.rows[0].values.poles === '2' &&
  osa300.tables?.find((table) => table.id === 'veza-osa-300-040-2-example')?.rows[0].values.motorIndex === '00055');
check('motor code 00055 and 00400 preserve their leading zeroes', osa300.params.find((param) => param.key === 'motorIndex')?.values?.map((value) => value.code).join(',') === '00400,00055');
check('temperature depends on the selected climate code', osa300.specs.find((spec) => spec.key === 'temperature')?.cases?.length === 2 && osa301.specs.find((spec) => spec.key === 'temperature')?.cases?.length === 1);
check('valve delta retains existing independent family marking definitions', veza2026Pack.families.some((family) => family.id === 'veza-regular' && family.positions.some((position) => position.key === 'size')) && veza2026Pack.families.some((family) => family.id === 'veza-klara' && family.positions.some((position) => position.key === 'size')));
for (const family of veza2026Pack.families.filter((item) => item.id.startsWith('veza-') && !item.id.startsWith('veza-osa-'))) {
  for (const example of family.examples || []) {
    const result = parseWithFamily(family, example);
    check(`${family.code} keeps its own marking: ${example}`, result.complete && sameDesignation(buildDesignation(family, result.values).text, example), result);
  }
}
check('only verified valve sections from the 2026 air catalog are included', veza2026Pack.families.some((family) => family.id === 'veza-regular') && !veza2026Pack.families.some((family) => family.id === 'veza-kpu-1n' || family.id === 'veza-germik-t'));
check('KLAB gets the cited section from the 2026 air-valve catalog', veza2026Pack.families.find((family) => family.id === 'veza-klab')?.documents?.some((document) => document.file === 'ВЕЗА_Воздушные клапаны_от 04.06.2026.pdf' && document.edition === '04.06.2026' && document.physicalPage === 54));
check('air-valve references keep physical and printed page numbers distinct', veza2026Pack.families.find((family) => family.id === 'veza-regular')?.documents?.some((document) => document.file === 'ВЕЗА_Воздушные клапаны_от 04.06.2026.pdf' && document.physicalPage === 8 && document.printedPage === '6'));
check('source pack is a partial delta, with no fabricated components or tag rules', veza2026Pack.components.length === 0 && veza2026Pack.tagRules.length === 0);

if (failures) process.exitCode = 1;
else console.log('Все проверки пакета прошли.');
