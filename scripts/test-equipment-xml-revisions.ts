import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { XMLValidator } from 'fast-xml-parser';
import { parseEquipmentXML } from '../server/equipmentParser.js';
import { applyEquipmentSourceDecisions, diffEquipmentSource, sourceDecisionStatus } from '../server/equipmentSourceReview.js';
import { decodeVerifiedSource, groupsForTarget } from '../server/routes/equipmentXmlSources.js';

let checks = 0;
function check(name: string, actual: unknown, expected: unknown): void {
  checks++;
  assert.deepEqual(actual, expected, name);
  console.log(`✓ ${name}`);
}

const xml = `<project><system name="Л23"><group title="Параметры"><param name="Расход" value="1,2" unit="м³/с"/><param name="Мощность" value="1200" unit="Вт"/></group><monoblock name="М1"><block name="FAN-1"><group title="Двигатель"><param name="Ток" value="2" unit="А"/></group></block></monoblock></system></project>`;
const bytes = Buffer.from(xml, 'utf8');
const sha256 = createHash('sha256').update(bytes).digest('hex');
const verified = decodeVerifiedSource({ base64: bytes.toString('base64'), sha256, size: bytes.length });
check('сервер проверяет SHA исходных байтов до разбора', verified.sha256, sha256);
check('сервер декодирует проверенный XML', verified.text, xml);
assert.throws(() => decodeVerifiedSource({ base64: bytes.toString('base64'), sha256: '0'.repeat(64), size: bytes.length }), /изменился/);
checks++; console.log('✓ подмена содержимого не проходит проверку контрольной суммы');
assert.throws(() => decodeVerifiedSource({ base64: bytes.toString('base64'), sha256, size: bytes.length - 1 }), /Размер или кодировка/);
checks++; console.log('✓ объявленный размер сверяется с исходными байтами');
assert.notEqual(XMLValidator.validate('<system><block>'), true);
checks++; console.log('✓ оборванный XML распознаётся до любого сравнения');

const parsed = parseEquipmentXML(xml);
check('installation Tag берёт характеристики корня, не теги вложенных блоков', groupsForTarget(parsed, { targetType: 'system' }, 'Л23')[0].params.map((p: any) => p.key), ['Расход', 'Мощность']);
check('component Tag находит только точный вложенный блок', groupsForTarget(parsed, { targetType: 'component' }, 'FAN-1')[0].params.map((p: any) => p.key), ['Ток']);
assert.throws(() => groupsForTarget(parsed, { targetType: 'system' }, 'Л230'), /точным тегом/);
checks++; console.log('✓ короткий тег не совпадает с похожим длинным');

const current = JSON.stringify({ groups: [{ title: 'Воздух', params: [
  { key: 'Расход', value: '4320', unit: 'м³/ч' },
  { key: 'Старый параметр', value: 'да', unit: '' },
] }, { title: 'Мотор', params: [{ key: 'Мощность', value: '1,2', unit: 'кВт' }] }] });
const proposed = [{ title: 'Воздух', params: [
  { key: 'Расход', value: '1,2', unit: 'м³/с' },
  { key: 'Новый параметр', value: '8', unit: 'Па' },
] }, { title: 'Мотор', params: [{ key: 'Мощность', value: '1200', unit: 'Вт' }] }];
const changes = diffEquipmentSource(current, proposed, null);
check('совместимые единицы не создают ложное отличие', changes.map(change => change.key), ['Новый параметр', 'Старый параметр']);
check('новый параметр сначала считается ожидающим решения', sourceDecisionStatus(changes, {}), 'pending');
const newChange = changes.find(change => change.key === 'Новый параметр')!;
const missing = changes.find(change => change.kind === 'missing')!;
const partial = { [newChange.id]: { action: 'accept' as const, userId: 'u1' } };
check('частичное решение сохраняет незавершённую ревизию', sourceDecisionStatus(changes, partial), 'partial');
const afterPartial = applyEquipmentSourceDecisions(current, proposed, changes, partial);
check('частичный приём добавляет только явно выбранное значение', JSON.parse(afterPartial).groups[0].params.map((p: any) => p.key), ['Расход', 'Старый параметр', 'Новый параметр']);
const kept = { [newChange.id]: { action: 'keep' as const }, [missing.id]: { action: 'keep' as const } };
check('все решения keep получают отдельный завершённый статус', sourceDecisionStatus(changes, kept), 'keepResolved');
const acceptedMissing = { [newChange.id]: { action: 'accept' as const }, [missing.id]: { action: 'accept_missing' as const } };
const afterMissing = JSON.parse(applyEquipmentSourceDecisions(current, proposed, changes, acceptedMissing));
check('параметр отсутствующий в XML удаляется только после явного решения', afterMissing.groups.flatMap((g: any) => g.params).some((p: any) => p.key === 'Старый параметр'), false);

const manualChanges = diffEquipmentSource(current, proposed, JSON.stringify({ 'Воздух|Новый параметр': 'руками' }));
const manual = manualChanges.find(change => change.key === 'Новый параметр')!;
check('ручной override использует сохранённый составной адрес с двойным разделителем', diffEquipmentSource(current, proposed, JSON.stringify({ 'Воздух||Новый параметр': 'руками' })).find(change => change.key === 'Новый параметр')?.current?.value, 'руками');
const manualChangesWithOverride = diffEquipmentSource(current, proposed, JSON.stringify({ 'Воздух||Новый параметр': 'руками' }));
assert.throws(() => applyEquipmentSourceDecisions(current, proposed, manualChangesWithOverride, { [manual.id]: { action: 'accept' } }), /изменён вручную/);
checks++; console.log('✓ ручное значение нельзя заменить без явного подтверждения');
const legacyArray = JSON.stringify([{ title: 'Воздух', params: [{ key: 'Расход', value: '1,2', unit: 'м³/с' }] }]);
check('старый формат массива групп сохраняет параметры при сравнении', diffEquipmentSource(legacyArray, [{ title: 'Воздух', params: [{ key: 'Расход', value: '1,2', unit: 'м³/с' }] }], null), []);
const legacyFlat = JSON.stringify({ 'Расход': { value: '1,2', unit: 'м³/с' }, 'Режим': 'Авто' });
check('старый плоский формат характеристик участвует в сравнении', diffEquipmentSource(legacyFlat, [{ title: 'Параметры', params: [{ key: 'Расход', value: '1,2', unit: 'м³/с' }, { key: 'Режим', value: 'Авто' }] }], null), []);
const manualOnly = diffEquipmentSource(null, [], JSON.stringify({ 'Ручные||Только поле': 'сохранено' }));
check('ручной адрес без сырого XML не теряется из списка отличий', manualOnly.map(change => [change.group, change.key, change.kind, change.current?.value, change.manual]), [['Ручные', 'Только поле', 'missing', 'сохранено', true]]);
assert.throws(() => applyEquipmentSourceDecisions(null, [], manualOnly, { [manualOnly[0].id]: { action: 'accept_missing' } }), /изменён вручную/);
checks++; console.log('✓ ручное поле без исходного XML требует явного разрешения на удаление');
assert.throws(() => diffEquipmentSource('{broken', proposed, null), /повреждены/);
checks++; console.log('✓ повреждённые сохранённые характеристики блокируют источник, а не считаются пустыми');
check('повторный разбор одинаковой ревизии даёт тот же список отличий', diffEquipmentSource(current, proposed, null).map(c => c.id), changes.map(c => c.id));

console.log(`\n${checks} проверок пройдено, 0 провалено`);
