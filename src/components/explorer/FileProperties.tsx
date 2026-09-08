/**
 * Свойства файла или папки: имя, ревизия, тип, размер, кто и когда менял.
 *
 * Вынесено из Проводника: разговор о свойствах самодостаточен и меняется
 * отдельно от списка файлов, а экран Проводника — один из самых больших в
 * программе, и найти в нём разметку окошка было отдельной задачей.
 *
 * Значок приходит работой (`icon`): «чем это открывается» знает общая таблица
 * расширений, и заводить здесь второе мнение о типах нельзя — они разойдутся.
 */
import React from 'react';
import { motion } from 'motion/react';
import { format } from 'date-fns';
import { X } from 'lucide-react';
import { formatSize } from './FileItems';
import { typeLabel } from '../../lib/fileTypes';

export default function FileProperties({ item, isFile, icon, userId, onClose, onSaved }: {
  item: any;
  isFile: boolean;
  icon: React.ReactNode;
  userId: string | null;
  onClose: () => void;
  /** Свойства записаны: обновить список и сказать об этом человеку */
  onSaved: () => void;
}) {
  return (
      <div className="fixed inset-0 bg-slate-950/55 backdrop-blur-md flex items-center justify-center z-50" onClick={() => onClose()}>
        <motion.div 
          initial={{ opacity: 0, scale: 0.95 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={{ opacity: 0, scale: 0.95 }}
          className="bg-white rounded-lg shadow-xl border border-slate-200 w-[420px] max-w-full overflow-hidden flex flex-col"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="px-5 py-4 border-b border-slate-100 bg-slate-50 flex items-center gap-3">
            {icon}
            <h2 className="text-base font-semibold text-slate-900">Свойства</h2>
          </div>
          
          <form onSubmit={async (e: any) => {
            e.preventDefault();
            const newName = e.target.name.value;
            const newRevision = e.target.revision ? e.target.revision.value : undefined;
            const endpoint = isFile ? `/api/files/${item.id}` : `/api/folders/${item.id}`;
            
            await fetch(endpoint, {
              method: 'PATCH',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ 
                name: newName, 
                ...(isFile && newRevision !== undefined ? { revision: newRevision } : {}),
                updatedById: userId
              })
            });
            
            onSaved();
          }} className="flex-1 overflow-y-auto p-5 space-y-4">
            
            <div>
              <label className="block text-xs font-medium text-slate-500 mb-1">Имя</label>
              <input type="text" name="name" defaultValue={item.name} className="w-full px-3 py-2 border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-white rounded focus:outline-none focus:ring-2 focus:ring-emerald-500 text-sm" required />
            </div>

            {isFile && (
              <div>
                <label className="block text-xs font-medium text-slate-500 mb-1">Ревизия</label>
                <input type="text" name="revision" defaultValue={item.revision || "1"} className="w-full px-3 py-2 border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-white rounded focus:outline-none focus:ring-2 focus:ring-emerald-500 text-sm" />
              </div>
            )}

            <div className="h-px bg-slate-100 my-2" />

            <div className="space-y-2 text-sm">
              {!isFile && (
                <div className="flex">
                  <span className="w-32 text-slate-500">Тип:</span>
                  <span className="text-slate-900">Папка с файлами</span>
                </div>
              )}
              
              {isFile && (
                <>
                  <div className="flex">
                    <span className="w-32 text-slate-500">Тип файла:</span>
                    <span className="text-slate-900">{item.type}</span>
                  </div>
                  <div className="flex">
                    <span className="w-32 text-slate-500">Приложение:</span>
                    <span className="text-slate-900">
                      {typeLabel(item)}
                    </span>
                  </div>
                  <div className="flex">
                    <span className="w-32 text-slate-500">Размер:</span>
                    <span className="text-slate-900">{formatSize(item.size)}</span>
                  </div>
                </>
              )}
              
              <div className="h-px bg-slate-50 my-2" />

              <div className="flex">
                <span className="w-32 text-slate-500">Создан:</span>
                <span className="text-slate-900">{item.createdAt ? format(new Date(item.createdAt), 'dd.MM.yyyy HH:mm:ss') : 'Неизвестно'}</span>
              </div>
              <div className="flex">
                <span className="w-32 text-slate-500">Изменен:</span>
                <span className="text-slate-900">{item.updatedAt ? format(new Date(item.updatedAt), 'dd.MM.yyyy HH:mm:ss') : 'Неизвестно'}</span>
              </div>
              
              <div className="h-px bg-slate-50 my-2" />

              <div className="flex">
                <span className="w-32 text-slate-500">Создатель:</span>
                <span className="text-slate-900">{item.createdBy?.name || 'Неизвестно'}</span>
              </div>
              <div className="flex">
                <span className="w-32 text-slate-500">Изменил:</span>
                <span className="text-slate-900">{item.updatedBy?.name || 'Неизвестно'}</span>
              </div>

            </div>

            <div className="flex justify-end gap-2 pt-4 mt-2 border-t border-slate-100 dark:border-slate-800">
              <button type="button" onClick={() => onClose()} className="px-4 py-2 text-slate-700 dark:text-slate-300 bg-white dark:bg-slate-800 border border-slate-300 dark:border-slate-700 rounded hover:bg-slate-50 dark:hover:bg-slate-700 text-sm cursor-pointer">
                Отмена
              </button>
              <button type="submit" className="px-4 py-2 text-white bg-emerald-600 rounded hover:bg-emerald-700 text-sm cursor-pointer">
                Применить
              </button>
            </div>
          </form>
        </motion.div>
      </div>
  );
}
