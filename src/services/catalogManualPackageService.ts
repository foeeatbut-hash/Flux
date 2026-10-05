import { manuals2026Pack, manualSources } from '../../catalog/packs/manuals2026';
import { attachCatalogSource } from '../../catalog/sources';
import type { Family } from '../../catalog/model';
import { catalogService } from './catalogService';
import { catalogWorkspaceService } from './catalogWorkspaceService';
import { uploadCatalogAsset } from './catalogAssetService';

/** Сначала подтверждённый diff, затем файлы в БД, затем отдельная публикация. */
export async function saveManualPackage(preview: string, onProgress: (message: string) => void): Promise<void> {
  await catalogService.importCatalog({ ...manuals2026Pack, preview }, 'apply');
  let workspace = await catalogWorkspaceService.load();
  for (const source of manualSources) {
    const records = [...workspace.catalog.families, ...workspace.catalog.components].filter(record => record.sections?.some(s => s.source.file === source.file));
    if (!records.length) continue;
    onProgress(`Загрузка ${source.file}`);
    const response = await fetch(`${import.meta.env.BASE_URL}catalog-documents/${source.id}.pdf`);
    if (!response.ok) throw new Error(`Не удалось прочитать комплект документации: ${source.file}. Черновики сохранены; публикация не выполнена.`);
    const bytes = await response.arrayBuffer();
    const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), value => value.toString(16).padStart(2,'0')).join('');
    if (bytes.byteLength !== source.bytes || hash !== source.sha256) throw new Error(`Документ ${source.file} не прошёл проверку целостности. Публикация не выполнена.`);
    const anchor = records[0];
    const assetId = await uploadCatalogAsset(new File([bytes], source.file, { type: 'application/pdf' }), { id: anchor.id, classId: anchor.classId, manufacturerId: anchor.manufacturerId || 'mf-neman' }, fraction => onProgress(`Загрузка ${source.file}: ${Math.round(fraction * 100)}%`));
    // Берём актуальные версии: правка коллеги во время загрузки не перезаписывается.
    workspace = await catalogWorkspaceService.load();
    for (const record of records) {
      const entity = workspace.catalog.families.some(f => f.id === record.id) ? 'family' : 'component';
      const draft = workspace.drafts.find(d => d.entity === entity && d.id === record.id);
      if (!draft || draft.operation !== 'save') continue;
      const next = attachCatalogSource(draft.document as Family, { file: source.file, edition: source.edition }, assetId);
      await catalogService.save(entity, { ...next, _draftVersion: draft.revision } as Family);
    }
    workspace = await catalogWorkspaceService.load();
  }
}
