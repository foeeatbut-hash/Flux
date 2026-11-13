import React from 'react';
import { createRoot } from 'react-dom/client';
import ModuleFrame from '../../src/components/modules/ModuleFrame';
import { moduleCompute, createPythonRunner, createWasmRunner } from '../../src/services/moduleComputeHost';
import { createProgramCaller } from '../../src/services/moduleProgramCall';

// Данные Flux подставные: настоящая оболочка и мост, но без сервера
const equipment = { id: 'e', name: 'Вентилятор', itemCode: 'бл1', equipType: 'ВЕНТИЛЯТОР', version: 1, tags: [], composition: [],
  params: ['1200', '3.5', '0.25'].map((value, i) => ({ group: 'Основные', key: `П${i + 1}`, value, unit: 'ед' })) };
const data: Record<string, unknown> = { project: { id: 'p', name: 'Тестовый проект', code: 'P' }, equipment, tag: null, specification: { rows: [] }, catalog: { families: [] } };
document.cookie = 'flux_parent_cookie=private; SameSite=Strict';
localStorage.setItem('flux_parent_storage', 'private');
const w = window as any;
w.__compute = moduleCompute();
w.__python = createPythonRunner;
w.__wasm = createWasmRunner();
// Обращение программы к программе тем же вызывающим, что в окне Flux: настоящие IPC главного процесса, контрольные примеры и общий moduleCompute
w.__programCall = (caller: { moduleId: string; version: string }, request: any) => createProgramCaller(caller)(request);
w.__sha = async (bytes: Uint8Array) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))).map(b => b.toString(16).padStart(2, '0')).join('');
const manifestText = new URLSearchParams(location.search).get('manifest');
if (manifestText) {
  createRoot(document.getElementById('root')!).render(<div style={{ height: '100vh', display: 'flex', flexDirection: 'column' }}>
    <ModuleFrame manifest={JSON.parse(manifestText)} context={{ projectId: 'p', entry: 'equipment', entityId: 'e' }} theme="light"
      createReadCycle={() => async (resource: string) => data[resource] as never} />
  </div>);
}
