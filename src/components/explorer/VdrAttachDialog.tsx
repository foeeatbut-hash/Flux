/**
 * Окно «Прикрепить файл к строке ВДР»: выбор строки реестра, к которой
 * привязывается файл замечаний или выпуска.
 *
 * Вынесено из экрана Проводника как есть. Выбранный файл и проект приходят
 * значениями, закрытие — обработчиком; запрос на привязку и тосты живут здесь,
 * потому что больше экрану они ни для чего не нужны.
 */
import React from 'react';
import VdrItemPicker from '../VdrItemPicker';
import { useToastStore } from '../../store/toastStore';

interface VdrAttachDialogProps {
  /** Файл Проводника, который привязывается к строке ВДР */
  fileId: string;
  projectId: string;
  onClose: () => void;
}

export default function VdrAttachDialog({ fileId, projectId, onClose }: VdrAttachDialogProps) {
  const { addToast } = useToastStore();
  return (
    <VdrItemPicker
      projectId={projectId}
      title="Прикрепить файл к строке ВДР"
      onClose={onClose}
      onPick={async (it) => {
        try {
          const r = await fetch(`/api/vdr/items/${it.id}`, {
            method: 'PUT', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ fileNodeId: fileId }),
          });
          if (r.ok) addToast(`Файл прикреплён к «${it.contractorNo || it.titleRu}»`, 'success');
          else addToast('Не удалось прикрепить', 'error');
        } catch (_) { addToast('Ошибка сети', 'error'); }
        onClose();
      }}
    />
  );
}
