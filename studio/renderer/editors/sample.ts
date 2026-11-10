/**
 * Образец черновика для стенда и проверок: подпрограмма «Параметры позиции» из modules/fixtures,
 * дополненная вводом (единица, допустимые значения, условие показа), чтобы было что править.
 */
import type { ContractDraft, FormDef, ModuleDraft } from './types';

export const sampleContract = (): ContractDraft => ({
  version: 1,
  reads: ['project', 'equipment', 'tag'],
  state: [
    { name: 'recalculations', type: 'integer', description: 'сколько раз пересчитано' },
    { name: 'mode', type: 'string', description: 'режим расчёта' },
    { name: 'airflow', type: 'number', unit: 'м³/ч', description: 'расход воздуха, введённый вручную' },
  ],
  outputs: [
    { name: 'parameterCount', type: 'integer', description: 'число параметров позиции' },
    { name: 'pressure', type: 'number', unit: 'Па' },
  ],
});

export const sampleForm = (): FormDef => ({
  version: 1,
  groups: [
    {
      title: 'Позиция оборудования',
      fields: [
        { label: 'Проект', bind: 'flux.project.name' },
        { label: 'Наименование', bind: 'flux.equipment.name' },
        { label: 'Код позиции', bind: 'flux.equipment.itemCode', kind: 'code' },
        { label: 'Тег', bind: 'flux.tag.identifier', kind: 'code' },
      ],
    },
    {
      title: 'Расчёт',
      fields: [
        { label: 'Режим', bind: 'state.mode', allowed: ['зима', 'лето'], required: true, hint: 'От режима зависят поправки к расходу.' },
        { label: 'Расход воздуха', bind: 'state.airflow', unit: 'м³/ч', min: 0, max: 100000, placeholder: '1200', visibleIf: { bind: 'state.mode', op: 'filled' } },
        { label: 'Параметров', bind: 'calc.out.parameterCount' },
        { label: 'Пересчётов', bind: 'state.recalculations' },
      ],
    },
  ],
  tables: [
    {
      title: 'Параметры',
      bind: 'flux.equipment.params',
      columns: [
        { label: 'Группа', key: 'group' },
        { label: 'Параметр', key: 'key' },
        { label: 'Значение', key: 'value', align: 'end' },
        { label: 'Единица', key: 'unit' },
      ],
    },
  ],
});

export const sampleLogic = `import type { ModuleApi } from '../contract';

export function setup({ flux, state, calc }: ModuleApi) {
  state.recalculations ??= 0;
  flux.on('changed', async () => {
    const equipment = await flux.read('equipment');
    state.recalculations = Number(state.recalculations) + 1;
    calc.out = { parameterCount: equipment?.params.length || 0 };
  });
}
`;

export const samplePython = `def compute(input):
    equipment = (input.get("flux") or {}).get("equipment") or {}
    return {"state": {}, "calc": {"out": {"parameterCount": len(equipment.get("params") or [])}}}
`;

export const sampleDraft = (): ModuleDraft => ({
  form: sampleForm(),
  code: [{ path: 'logic/main.ts', language: 'typescript', text: sampleLogic }],
  contract: sampleContract(),
});

/** Данные для предпросмотра: то, что Flux отдал бы форме */
export const sampleData = () => ({
  flux: {
    project: { id: 'p1', name: 'Школа №12', code: 'SCH-12' },
    equipment: {
      id: 'e1', name: 'Вентилятор приточный', itemCode: 'AHU-01', equipType: 'fan', version: 1, tags: [], composition: [],
      params: [
        { group: 'Воздух', key: 'Расход', value: '1200', unit: 'м³/ч' },
        { group: 'Воздух', key: 'Напор', value: '450', unit: 'Па' },
        { group: 'Электрика', key: 'Мощность', value: '1.5', unit: 'кВт' },
      ],
    },
    tag: { id: 't1', identifier: 'AHU-01.S1', name: 'Подача', parentId: null },
  },
  state: { mode: 'зима', airflow: '1200', recalculations: 3 },
  calc: { out: { parameterCount: 3, pressure: 450 } },
});
