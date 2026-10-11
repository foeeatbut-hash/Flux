import assert from 'node:assert/strict';
import { fieldsFromCatalog, toProjectQuery, type OfficeQuery } from '../src/components/office/fluxData';

const query: OfficeQuery = {
  projectId: 'project-a', sources: ['equipment'], types: ['PUMP', 'VALVE'],
  filters: [{ fieldKey: 'status', op: 'notEquals', value: 'retired' }, { fieldKey: 'name', op: 'contains', value: 'Насос' }],
  sort: [{ fieldKey: 'equipType', direction: 'asc' }, { fieldKey: 'itemCode', direction: 'desc' }],
  excludedEntityIds: ['element-9'], limit: 500,
};
assert.deepEqual(toProjectQuery(query), {
  entity: 'element', columns: [],
  filters: [
    { field: 'status', op: 'neq', value: 'retired' },
    { field: 'name', op: 'contains', value: 'Насос' },
    { field: 'equipType', op: 'in', value: 'PUMP|VALVE' },
  ],
  sort: [{ field: 'equipType', dir: 'asc' }, { field: 'itemCode', dir: 'desc' }],
  excludedEntityIds: ['element-9'], limit: 500,
});

const tagQuery = toProjectQuery({ ...query, sources: ['tags'], types: [] });
assert.equal(tagQuery.entity, 'tag');
assert.equal((tagQuery.filters as any[]).some((item) => item.field === 'equipType'), false);
assert.throws(() => toProjectQuery({ ...query, sources: ['vdr'] }), /не поддерживается/);

const fields = fieldsFromCatalog({
  tagFields: [{ path: 'identifier', title: 'Тег' }],
  elementFields: [{ path: 'equipType', title: 'Тип оборудования' }],
  params: [{ group: 'Электрика', key: 'Мощность', unit: 'кВт' }],
  aliases: [{ path: 'param:@Номинал', title: 'Номинал', unit: 'кВт' }],
  metaKeys: [{ key: 'procurement.stage' }],
});
assert.deepEqual(fields.map(({ sourceId, entityType, fieldKey }) => [sourceId, entityType, fieldKey]), [
  ['tags', 'tag', 'identifier'], ['equipment', 'element', 'equipType'],
  ['equipment', 'element', 'param:Электрика|Мощность'], ['equipment', 'element', 'param:@Номинал'],
  ['tags', 'tag', 'meta:procurement.stage'],
]);
assert.equal(fields[2].unit, 'кВт');
console.log('Office UI query and catalog contracts: PASS');
