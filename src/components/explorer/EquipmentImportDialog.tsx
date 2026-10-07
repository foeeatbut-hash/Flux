/**
 * Окно «Загрузить в оборудование»: выбор категории для выбранных файлов.
 *
 * Вынесено из экрана Проводника как есть. Состояние остаётся в экране: сюда
 * приходят только выбранные файлы, список категорий и два обработчика, а
 * сам импорт (importFilesToCategory) экран выполняет у себя — он тянет за
 * собой предпросмотр и обновление сопоставлений оборудования.
 */
import React from 'react';
import { motion } from 'motion/react';
import { Boxes } from 'lucide-react';

interface EquipmentImportDialogProps {
  /** Идентификаторы выбранных файлов; окно показывает только их число */
  files: string[];
  categories: { id: string; label: string }[];
  onPick: (category: string) => void;
  onClose: () => void;
}

export default function EquipmentImportDialog({ files, categories, onPick, onClose }: EquipmentImportDialogProps) {
  return (
    <div className="fixed inset-0 flex items-center justify-center z-[70] fx-backdrop" onClick={() => onClose()}>
      <motion.div
        initial={{ opacity: 0, scale: 0.95, y: 10 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.95 }}
        className="fx-dialog dark:bg-dark-panel dark:border-dark-border w-[min(94vw,460px)] max-h-[88vh] overflow-hidden flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-5 py-4 border-b border-slate-100 dark:border-dark-border bg-slate-50 dark:bg-dark-surface flex items-center gap-3">
          <Boxes className="w-5 h-5 text-emerald-600" />
          <div className="flex flex-col">
            <h2 className="text-base font-semibold text-slate-900 dark:text-white">Загрузить в оборудование</h2>
            <span className="text-xs text-slate-500 dark:text-dark-text-muted">Выбрано файлов: {files.length}. Выберите категорию:</span>
          </div>
        </div>
        <div className="p-3 overflow-y-auto scrollbar-thin grid grid-cols-1 gap-1.5">
          {categories.map(c => (
            <button type="button"
              key={c.id}
              onClick={() => onPick(c.id)}
              className="flex items-center gap-3 px-4 py-3 rounded-xl border border-slate-200 dark:border-dark-border bg-white dark:bg-dark-surface hover:bg-emerald-50 dark:hover:bg-emerald-950/40 hover:border-emerald-400 transition-colors text-left cursor-pointer"
            >
              <span className="w-9 h-9 rounded-lg bg-emerald-100 dark:bg-emerald-950/60 flex items-center justify-center shrink-0">
                <Boxes className="w-5 h-5 text-emerald-600 dark:text-emerald-300" />
              </span>
              <span className="text-sm font-medium text-slate-800 dark:text-dark-text-main">{c.label}</span>
            </button>
          ))}
        </div>
        <div className="flex justify-end gap-2 px-5 py-3 border-t border-slate-100 dark:border-dark-border bg-slate-50 dark:bg-dark-surface">
          <button type="button" onClick={() => onClose()} className="px-4 py-2 text-slate-700 dark:text-slate-300 bg-white dark:bg-dark-panel border border-slate-300 dark:border-dark-border rounded-lg hover:bg-slate-50 dark:hover:bg-dark-surface text-sm cursor-pointer">
            Отмена
          </button>
        </div>
      </motion.div>
    </div>
  );
}
