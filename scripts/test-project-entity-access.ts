/** Извлечение сущностей и их принадлежность проектам: без сервера, на точечных DB-заглушках. */
import assert from 'node:assert/strict';
import { entityRefsOfRequest, projectsOfEntity } from '../server/projectEntityAccess';

let checks = 0;
const check = (name: string, value: unknown) => { assert.ok(value, name); checks++; console.log('✓', name); };

(async () => {
  const refs = entityRefsOfRequest('/api/components/c1/tags/t1', {
    projectId: 'p1', tagIds: ['t1', '', 7], sourceFileId: 'f1',
  }, { groupId: 'g1' });
  check('маршрут связывания извлекает обе сущности и ссылки из тела/запроса',
    JSON.stringify(refs) === JSON.stringify([
      { kind: 'component', id: 'c1' }, { kind: 'tag', id: 't1' },
      { kind: 'file', id: 'f1' }, { kind: 'chatGroup', id: 'g1' },
    ]));

  const bulk = entityRefsOfRequest('/api/tags/bulk-metadata', {
    updates: [{ id: 't1' }, { id: 't2' }], tagIds: ['t2', 't3'],
  });
  check('массовые обновления проверяют каждый уникальный тег',
    bulk.map(r => r.id).join(',') === 't1,t2,t3');
  check('служебное имя маршрута не принимается за идентификатор сущности',
    entityRefsOfRequest('/api/tags/generate').length === 0);
  check('слишком длинный идентификатор игнорируется',
    entityRefsOfRequest('/api/tags/' + 'x'.repeat(201)).length === 0);

  const archiveRefs = entityRefsOfRequest('/api/archives/create', {
    fileIds: ['f1', 'f2'], folderIds: ['d1'],
  });
  check('архив проверяет все исходные файлы и папки из массивов',
    archiveRefs.map(r => `${r.kind}:${r.id}`).join(',') === 'file:f1,file:f2,folder:d1');

  const importRefs = entityRefsOfRequest('/api/import-jobs', {
    projectId: 'p-target', files: [
      { fileId: 'f-source', tagLinks: [{ action: 'link', existingTagId: 't-linked' }] },
      { units: [], tagLinks: [{ action: 'create' }] },
    ],
  });
  check('фоновый импорт проверяет ID исходного файла и выбранного тега',
    importRefs.map(r => `${r.kind}:${r.id}`).join(',') === 'file:f-source,tag:t-linked');

  const calls: string[] = [];
  const prisma: any = {
    tag: { findUnique: async ({ where }: any) => { calls.push(`tag:${where.id}`); return { projectId: 'p-tag' }; } },
    componentElement: { findUnique: async ({ where }: any) => { calls.push(`component:${where.id}`); return { monoblock: { system: { projectId: 'p-equipment' } } }; } },
    equipmentSystem: { findUnique: async ({ where }: any) => ({ projectId: `p-system-${where.id}` }) },
    monoblock: { findUnique: async ({ where }: any) => ({ system: { projectId: `p-mono-${where.id}` } }) },
    folder: { findUnique: async ({ where }: any) => ({ projectId: `p-folder-${where.id}` }) },
    fileNode: { findUnique: async ({ where }: any) => ({ folder: { projectId: `p-file-${where.id}` } }) },
    constructorDoc: { findUnique: async ({ where }: any) => ({ projectId: `p-constructor-${where.id}` }) },
    importBatch: { findUnique: async ({ where }: any) => ({ projectId: `p-import-${where.id}` }) },
    chatGroup: { findUnique: async ({ where }: any) => ({ projectId: `p-chat-${where.id}` }) },
    equipmentHistory: { findMany: async ({ where }: any) => where.batchId === 'batch'
      ? [{ element: { monoblock: { system: { projectId: 'p-history' } } } }, { element: { monoblock: { system: { projectId: 'p-history' } } } }]
      : [] },
  };

  const mappings = await Promise.all([
    projectsOfEntity(prisma, { kind: 'tag', id: 't1' }),
    projectsOfEntity(prisma, { kind: 'component', id: 'c1' }),
    projectsOfEntity(prisma, { kind: 'system', id: 's1' }),
    projectsOfEntity(prisma, { kind: 'monoblock', id: 'm1' }),
    projectsOfEntity(prisma, { kind: 'folder', id: 'd1' }),
    projectsOfEntity(prisma, { kind: 'file', id: 'f1' }),
    projectsOfEntity(prisma, { kind: 'constructor', id: 'd1' }),
    projectsOfEntity(prisma, { kind: 'importBatch', id: 'b1' }),
    projectsOfEntity(prisma, { kind: 'chatGroup', id: 'g1' }),
    projectsOfEntity(prisma, { kind: 'historyBatch', id: 'batch' }),
  ]);
  check('каждый тип сущности разрешается в проект по серверной связи', mappings.map(x => x[0]).join(',') ===
    'p-tag,p-equipment,p-system-s1,p-mono-m1,p-folder-d1,p-file-f1,p-constructor-d1,p-import-b1,p-chat-g1,p-history');
  check('история оборудования дедуплицирует повторяющиеся проекты', mappings[9].length === 1);
  check('отсутствующая сущность не даёт выдуманный проект', (await projectsOfEntity({ tag: { findUnique: async () => null } }, { kind: 'tag', id: 'missing' })).length === 0);
  check('проверка использует запрошенный ID для чтения сущности', calls.includes('component:c1'));
  console.log(`${checks} проверок пройдено`);
})().catch(err => { console.error(err); process.exitCode = 1; });
