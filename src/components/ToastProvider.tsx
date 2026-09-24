import React from 'react';
import { useToastStore } from '../store/toastStore';
import { CheckCircle, AlertCircle, Info, X } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';

export default function ToastProvider() {
  const { toasts, removeToast } = useToastStore();

  return (
    <div
      style={{ bottom: 'calc(var(--flux-taskbar-h, 0px) + 5rem)' }}
      className="fixed right-4 z-[10000] flex flex-col gap-2"
    >
      <AnimatePresence>
        {toasts.map((toast) => (
          <motion.div
            key={toast.id}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, transition: { duration: 0.14 } }}
            onClick={() => {
              if (toast.onClick) {
                toast.onClick();
                removeToast(toast.id);
              }
            }}
            /* Тост — нейтральная карточка поверх, смысл несёт значок. Зелёная
               заливка на каждом сообщении делала акцентом всё подряд */
            className={`fx-pop flex items-start gap-2.5 px-3 py-2.5 min-w-[280px] max-w-[400px] text-sm text-slate-800 dark:text-slate-100 select-none
              ${toast.onClick ? 'cursor-pointer hover:bg-slate-50 dark:hover:bg-slate-900' : ''}
              ${toast.type === 'error' ? 'border-rose-200 dark:border-rose-900/60' : ''}`}
          >
            <div className="mt-0.5 shrink-0">
                {toast.type === 'success' && <CheckCircle className="w-4 h-4 text-emerald-600 dark:text-emerald-400" />}
                {toast.type === 'error' && <AlertCircle className="w-4 h-4 text-rose-600 dark:text-rose-400" />}
                {toast.type === 'info' && <Info className="w-4 h-4 text-slate-400" />}
            </div>
            <p className="flex-1 whitespace-pre-wrap">{toast.message}</p>
            <button type="button" onClick={(e) => { e.stopPropagation(); removeToast(toast.id); }} className="fx-ibtn -mr-1 -mt-0.5 shrink-0" aria-label="Закрыть уведомление">
              <X />
            </button>
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
}
