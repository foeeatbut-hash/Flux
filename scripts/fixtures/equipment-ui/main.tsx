import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import Equipment from '../../../src/screens/Equipment';
import ExportBuilder from '../../../src/components/equipment/ExportBuilder';
import { PaneContext } from '../../../src/lib/paneTitle';
import { useStore } from '../../../src/store/store';
import { useToastStore } from '../../../src/store/toastStore';
import { buildExportSources, type ExportSystem } from '../../../src/lib/exportWorkspace';
import './fixture.css';

type FixtureComponent = ExportSystem['monoblocks'][number]['components'][number] & {
  version: number;
  hasConflict: boolean;
  status: string;
};
type FixtureMonoblock = Omit<ExportSystem['monoblocks'][number], 'components'> & { id: string; components: FixtureComponent[] };
type FixtureSystem = Omit<ExportSystem, 'monoblocks'> & { fileName?: string; monoblocks: FixtureMonoblock[] };

const systems: FixtureSystem[] = [
  { id: 'ahu-1', name: 'AHU-101', category: 'AHU', fileName: 'расчёт-ahU-101.xlsx', monoblocks: [{ id: 'mb-1', name: 'Приток', components: [
    { id: 'block-1', itemCode: 'B-1', name: 'Вентиляторная секция', equipType: 'Вентилятор ВР-80', role: 'БЛОК', version: 2, hasConflict: false, status: 'OK', tags: [{ id: 'tag-1', identifier: 'AHU-101-FAN' }], specs: JSON.stringify({ groups: [
      { title: 'Аэродинамика', params: [{ key: 'Расход воздуха', value: '12500', unit: 'м³/ч' }, { key: 'Полное давление', value: '850', unit: 'Па' }] },
      { title: 'Электродвигатель', params: [{ key: 'Мощность', value: '5.5', unit: 'кВт' }, { key: 'Напряжение', value: '400', unit: 'В' }] },
      { title: 'Габариты', params: [{ key: 'Ширина', value: '820', unit: 'мм' }, { key: 'Высота', value: '760', unit: 'мм' }] },
    ] }) },
    { id: 'motor-1', itemCode: 'M-1', name: 'Электродвигатель 160М6', equipType: 'Электродвигатель', role: 'ДВИГАТЕЛЬ', parentElementId: 'block-1', version: 1, hasConflict: false, status: 'OK', tags: [{ id: 'tag-2', identifier: 'AHU-101-M1' }], specs: JSON.stringify({ groups: [{ title: 'Электрические', params: [{ key: 'Мощность', value: '5.5', unit: 'кВт' }] }] }) },
  ] }] },
  { id: 'fan-1', name: 'FAN-201', category: 'FAN', monoblocks: [{ id: 'mb-2', name: '__unit__', components: [
    { id: 'fan-unit', itemCode: '__unit__', name: 'Параметры установки', equipType: 'Радиальный вентилятор', role: 'БЛОК', version: 1, hasConflict: false, status: 'OK', tags: [{ id: 'tag-3', identifier: 'FAN-201' }], specs: JSON.stringify({ groups: [{ title: 'Производительность', params: [{ key: 'Расход воздуха', value: '4200', unit: 'м³/ч' }, { key: 'Давление', value: '650', unit: 'Па' }] }] }) },
  ] }] },
];

const sources = buildExportSources(systems, [
  { id: 'AHU', label: 'Центральные кондиционеры' },
  { id: 'FAN', label: 'Радиальные вентиляторы' },
  { id: 'VALVE', label: 'Клапаны' },
  { id: 'CURTAIN', label: 'Воздушные завесы' },
]);
useStore.setState({ user: { id: 'equipment-fixture', name: 'Проверка', symbol: 'TEST', role: 'ADMIN' } as any, activeProject: { id: 'equipment-fixture', name: 'Пробный проект' } as any });

function Fixture() {
  const [screen, setScreen] = useState<'equipment' | 'export'>('equipment');
  const say = useToastStore((state) => state.addToast);
  return <MemoryRouter initialEntries={['/equipment']}><PaneContext.Provider value="win:equipment-fixture">
    <div className="flex h-full min-h-0 flex-col bg-white text-slate-800 dark:bg-slate-950 dark:text-slate-100">
      <nav className="flex h-9 shrink-0 items-center gap-2 border-b border-slate-200 px-3 dark:border-slate-800" aria-label="Экран пробы">
        <button type="button" aria-pressed={screen === 'equipment'} onClick={() => setScreen('equipment')} className="fx-btn fx-btn-sm">Оборудование</button>
        <button type="button" aria-pressed={screen === 'export'} onClick={() => setScreen('export')} className="fx-btn fx-btn-sm">Выгрузка</button>
      </nav>
      <div className="min-h-0 flex-1">
        {screen === 'equipment'
          ? <Equipment />
          : <ExportBuilder projectId="equipment-fixture" projectName="Пробный проект" initialScope="all" scopes={sources.scopes} rowsOf={sources.rows} say={say} onClose={() => setScreen('equipment')} />}
      </div>
    </div>
  </PaneContext.Provider></MemoryRouter>;
}

createRoot(document.getElementById('root')!).render(<Fixture />);
