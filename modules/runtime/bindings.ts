import { resources, type ReadData, type Resource } from '../contract';
import type { ModuleForm } from './form';

export function boundResources(form: ModuleForm): Resource[] {
  const paths = [
    ...form.groups.flatMap(group => group.fields.map(field => field.bind)),
    ...form.tables.map(table => table.bind),
  ];
  const found = new Set<Resource>();
  for (const path of paths) {
    const [root, resource] = path.split('.');
    if (root !== 'flux') continue;
    if (!resources.includes(resource as Resource)) throw new Error('UNKNOWN_BINDING');
    found.add(resource as Resource);
  }
  return [...found];
}

export async function readFormBindings(
  form: ModuleForm,
  read: (resource: Resource) => Promise<ReadData[Resource]>,
): Promise<Partial<ReadData>> {
  // Привязки принадлежат оболочке: наличие обработчика в logic не влияет
  // на чтение Flux и не позволяет подменить его значения результатом расчёта.
  const entries = await Promise.all(boundResources(form).map(async resource => [resource, await read(resource)]));
  return Object.fromEntries(entries);
}
