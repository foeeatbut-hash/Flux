import React from 'react';
import { windowsFilesRequest, type WindowsFileEntry } from '../../lib/windowsFiles';
import { entryRef } from '../files/fileOps';
import PropertiesDialog from './WindowsPropertiesDialog';

/**
 * Свойства файла: только то, что знает Windows (размер, даты, автор). Теги, проекты,
 * ревизию и ответственного файл больше не несёт: всё это видно из имени по маске
 * проекта и строки ВДР (раздел «Сведения» и меню «Документооборот»).
 */
export default function PropertiesWindow({ entry, rootId, onClose }: { entry: WindowsFileEntry; rootId: string; onClose: () => void }) {
  const [systemProperties, setSystemProperties] = React.useState<{ author?: string; createdAt?: string }>({});
  React.useEffect(() => {
    let alive = true;
    setSystemProperties({});
    if (!entry.draftId) void windowsFilesRequest<{ author: string; createdAt: string }>({ action: 'systemProperties', ref: entryRef(entry, rootId) }).then((answer) => {
      if (alive && answer.ok) setSystemProperties({ ...(typeof answer.data?.author === 'string' ? { author: answer.data.author } : {}), ...(typeof answer.data?.createdAt === 'string' ? { createdAt: answer.data.createdAt } : {}) });
    }).catch(() => undefined);
    return () => { alive = false; };
  }, [entry.fileId, rootId]);
  return <PropertiesDialog entry={{ ...entry, ...systemProperties }} onClose={onClose} />;
}
