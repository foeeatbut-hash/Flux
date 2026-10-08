import type { WindowsFilesRequest, WindowsFileMetadata, WindowsFileRef } from '../../filesystem/contracts';
import type { WindowsFilesService } from './service';
import { WindowsFilesError, joinRelative, validateWindowsName } from './paths';

const values = (metadata: WindowsFileMetadata) => ({ tags: [...metadata.tags], projectIds: [...metadata.projectIds], revision: metadata.revision, responsible: metadata.responsible });

/** Замена сохраняет прежнее содержимое до записи и проверяет обе версии; перенос не удаляет изменённый источник. */
export async function replaceCopy(service: WindowsFilesService, request: Extract<WindowsFilesRequest, { action: 'replaceCopy' }>, group?: string) {
  validateWindowsName(request.name);
  if (typeof request.targetSha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(request.targetSha256)) throw new WindowsFilesError('INVALID_REQUEST', 'Для замены нужна версия существующего файла.');
  const parent = service.resolveRef(request.parent);
  const draft = service.draftsIn(parent).find((candidate) => candidate.name.toLocaleLowerCase('en-US') === request.name.toLocaleLowerCase('en-US'));
  const target: WindowsFileRef = { rootId: parent.rootId, relativePath: joinRelative(parent.relativePath, request.name), ...(draft ? { draftId: draft.id } : {}) };
  const sourceRef = service.resolveRef(request.ref);
  if (sourceRef.rootId === target.rootId && sourceRef.relativePath.toLocaleLowerCase('en-US') === target.relativePath.toLocaleLowerCase('en-US') && sourceRef.draftId === target.draftId) throw new WindowsFilesError('SAME_FILE', 'Нельзя заменить файл им самим.');
  return service.locked(`replace-copy:${target.rootId}:${target.relativePath}`, async () => {
    const [source, before, sourceMetadata, targetMetadata] = await Promise.all([service.journal.storeFile(await service.filename(sourceRef)), service.journal.storeFile(await service.filename(target)), service.metadata(sourceRef), service.metadata(target)]);
    if (before.sha256 !== request.targetSha256 || request.baseSha256 && source.sha256 !== request.baseSha256) throw new WindowsFilesError('CONFLICT', 'Файл изменился после проверки; проверьте свежую версию.');
    const beforeMetadata = values(targetMetadata);
    const afterMetadata = request.move ? values(sourceMetadata) : { tags: request.carryMeta ? [...sourceMetadata.tags] : [], projectIds: request.carryMeta ? [...sourceMetadata.projectIds] : [], revision: '', responsible: '' };
    const file = await service.replaceFromFile(target, service.journal.snapshotPath(source.id), before.sha256);
    await service.setMetadata(target, afterMetadata);
    await service.journal.record({ label: `Замена «${request.name}»`, group, op: { kind: 'replace', at: target, before: before.id, after: source.id, beforeSha256: before.sha256, afterSha256: source.sha256, beforeMetadata, afterMetadata } });
    if (request.move) await service.trash(sourceRef, source.sha256, { group });
    return { ref: target, file };
  });
}
