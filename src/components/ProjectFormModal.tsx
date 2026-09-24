import React, { useState } from 'react';
import type { ProjectInput } from '../services/dataService';
import ProjectFields, { draftOf, trimmed, type ProjectDraft } from './ProjectFields';
import { Dialog, Btn } from './ui';

interface Props {
  title?: string;
  initial?: ProjectInput;
  onClose: () => void;
  onSave: (data: ProjectInput) => Promise<void> | void;
}

/**
 * Окно создания проекта. Поля берутся из ProjectFields — того же набора, что и
 * в карточке проекта при правке: раньше формы расходились, и код, заказчик и
 * подрядчик, заданные здесь, потом нельзя было исправить.
 */
export default function ProjectFormModal({ title = 'Новый проект', initial, onClose, onSave }: Props) {
  const [draft, setDraft] = useState<ProjectDraft>(() => draftOf(initial));
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await onSave(trimmed(draft));
    } finally {
      setBusy(false);
    }
  };

  // Во время сохранения окно не закрываем: запрос уже ушёл (busy у Dialog)
  return (
    <Dialog title={title} width="max-w-lg" onClose={onClose} busy={busy}
      footer={<>
        <Btn size="lg" onClick={onClose} disabled={busy}>Отмена</Btn>
        <Btn size="lg" tone="primary" type="submit" form="project-create-form" disabled={busy}>{busy ? 'Сохранение…' : 'Создать'}</Btn>
      </>}>
      <form id="project-create-form" onSubmit={submit} className="@container">
        <ProjectFields value={draft} onChange={setDraft} disabled={busy} />
      </form>
    </Dialog>
  );
}
