/**
 * Заглушка раздела «Редактор», пока редакторов формы и кода нет в сборке.
 * Настоящий раздел — studio/renderer/editors/index.tsx (экспорт по умолчанию — компонент EditorProps);
 * build.cjs подставляет его вместо этой заглушки, как только файл появляется.
 */
import React from 'react';
import type { EditorProps } from '../shared/editorContract';

export default function EditorsStub({ moduleId }: EditorProps) {
  return (
    <div className="empty" data-testid="editors-stub">
      Раздел в работе. Редакторы формы и кода для проекта «{moduleId}» появятся в следующем обновлении Studio.
    </div>
  );
}
