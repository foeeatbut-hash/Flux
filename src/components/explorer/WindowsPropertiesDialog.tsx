import React from 'react';
import type { WindowsFileEntry } from '../../lib/windowsFiles';
import { Btn, Dialog } from '../ui';
const fileSize = (size: number) => size < 1024 ? `${size} Б` : size < 1048576 ? `${(size / 1024).toFixed(0)} КБ` : `${(size / 1048576).toFixed(1)} МБ`;
const dateLabel = (value: string) => new Date(value).toLocaleDateString('ru-RU');
export default function PropertiesDialog({ entry, onClose }: { entry: WindowsFileEntry; onClose: () => void }) {
  return <Dialog title={`Свойства · ${entry.name}`} onClose={onClose} width="max-w-2xl" footer={<Btn onClick={onClose}>Закрыть</Btn>}>
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-3">
      <ReadOnly label="Тип" value={entry.kind === 'directory' ? 'Папка' : entry.name.split('.').pop()?.toUpperCase() || 'Файл'} />
      <ReadOnly label="Размер" value={entry.kind === 'directory' ? '—' : fileSize(entry.size)} />
      <ReadOnly label="Изменён" value={dateLabel(entry.modifiedAt)} />
      <ReadOnly label="Создан" value={entry.createdAt ? dateLabel(entry.createdAt) : '—'} />
      <ReadOnly label="Автор" value={entry.author || '—'} />
      <ReadOnly label="Хранение" value={entry.storage === 'flux' ? 'Только в Flux' : 'Windows'} />
      {entry.projectNames?.length ? <ReadOnly label="Проект папки" value={entry.projectNames.join(', ')} /> : null}
    </div>
  </Dialog>;
}

function ReadOnly({ label, value }: { label: string; value: string }) { return <div className="fx-field"><span className="fx-label">{label}</span><span className="text-xs">{value}</span></div>; }
