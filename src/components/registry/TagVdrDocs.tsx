import React from 'react';
import { can } from '../../lib/permissions';
import { useAppContext } from '../../store/policyStore';
import { useKitDocuments } from '../docflow/useKitDocuments';
import TagKitDocuments from '../docflow/TagKitDocuments';
import KitRowsDialog from '../docflow/KitRowsDialog';

/** Один комплект виден в карточке тега, оборудования и вкладке «По тегам». */
export default function TagVdrDocs({ tagId, identifier: _identifier, projectId }: { tagId: string; identifier?: string; projectId: string }) {
  const { user } = useAppContext();
  const allowed = can(user, 'docflow.view');
  const { view, error, reload } = useKitDocuments(projectId, tagId, undefined, allowed);
  const [create, setCreate] = React.useState(false);
  if (!allowed) return null;
  return <div className="px-4 pb-3 space-y-2">
    <h4 className="fx-label">Документы</h4>
    {error ? <p role="alert" className="fx-note">{error}</p> : !view ? <p role="status" className="fx-note">Загрузка документов…</p> : view.tags[0] && <>
      <TagKitDocuments tag={view.tags[0]} compact canEdit={can(user, 'docflow.edit')} onCreate={() => setCreate(true)} />
      {create && <KitRowsDialog projectId={projectId} tagIds={[tagId]} registers={view.registers} onClose={() => setCreate(false)} onApplied={reload} />}
    </>}
  </div>;
}
