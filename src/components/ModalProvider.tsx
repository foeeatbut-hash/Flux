import React, { useState, useEffect, useRef } from 'react';
import { useOverlay } from '../store/overlayStore';
import { useModalStore } from '../store/modalStore';
import { AnimatePresence, motion } from 'motion/react';
import { AlertCircle, FileQuestion, HelpCircle, X } from 'lucide-react';

export default function ModalProvider() {
  const { currentModal, closeModal } = useModalStore();
  // Пока это открыто, страница браузера уступает место: родной слой Chromium
  // выше любой разметки, и без этого панель оказалась бы под страницей
  useOverlay(!!currentModal);
  const [inputValue, setInputValue] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (currentModal && currentModal.type === 'prompt') {
      setInputValue(currentModal.defaultValue || '');
      // Focus after slight delay for animation
      setTimeout(() => {
         inputRef.current?.focus();
      }, 100);
    } else if (currentModal && currentModal.type === 'select') {
      setInputValue(currentModal.defaultValue || (currentModal.options?.[0]?.value ?? ''));
    }
  }, [currentModal]);

  // Esc закрывает окно — как и все остальные всплывающие окна программы
  useEffect(() => {
    if (!currentModal) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') closeModal(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [currentModal, closeModal]);

  if (!currentModal) return null;

  const danger = currentModal.tone === 'danger';

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (currentModal.type === 'prompt' || currentModal.type === 'select') {
      closeModal(inputValue);
    } else if (currentModal.type === 'confirm') {
      closeModal(true);
    } else {
      closeModal();
    }
  };

  // Вид — по методологии (01-design.md, «Диалог»): заголовок 15/600, текст
  // второстепенным, кнопки справа внизу, главная последней. Значок в цветном
  // круге убран: он повторял заголовок и был той самой «плиткой со значком»
  const Icon = currentModal.type === 'alert' ? AlertCircle : currentModal.type === 'confirm' ? HelpCircle : FileQuestion;
  return (
    <AnimatePresence>
      <div className="fixed inset-0 z-[100] flex items-center justify-center p-4">
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="absolute inset-0 fx-backdrop"
          onClick={() => closeModal()}
        />
        <motion.div
           initial={{ opacity: 0, y: 6 }}
           animate={{ opacity: 1, y: 0 }}
           exit={{ opacity: 0, y: 6 }}
           transition={{ duration: 0.14 }}
           className="relative w-full max-w-md fx-dialog overflow-hidden"
        >
           <form onSubmit={handleSubmit}>
              <div className="fx-dialog-head pr-10">
                <Icon className={`w-4 h-4 shrink-0 ${danger ? 'text-rose-600 dark:text-rose-400' : currentModal.type === 'alert' ? 'text-amber-600 dark:text-amber-400' : 'text-slate-400'}`} />
                <h3 className="min-w-0">{currentModal.title}</h3>
              </div>
              <div className="fx-dialog-body">
                {currentModal.message && <p className="whitespace-pre-wrap">{currentModal.message}</p>}

                {currentModal.type === 'prompt' && (
                   <input
                     ref={inputRef}
                     type="text"
                     value={inputValue}
                     onChange={(e) => setInputValue(e.target.value)}
                     placeholder={currentModal.placeholder}
                     className="fx-input fx-btn-lg mt-3"
                   />
                )}

                {currentModal.type === 'select' && currentModal.options && (
                   <select
                     value={inputValue}
                     onChange={(e) => setInputValue(e.target.value)}
                     className="fx-input mt-3 cursor-pointer"
                   >
                     {currentModal.options.map((opt) => (
                       <option key={opt.value} value={opt.value}>{opt.label}</option>
                     ))}
                   </select>
                )}
              </div>

              <div className="fx-dialog-foot">
                 {currentModal.type !== 'alert' && (
                    <button type="button" onClick={() => closeModal()} className="fx-btn fx-btn-lg">
                       Отмена
                    </button>
                 )}
                 <button type="submit" autoFocus className={`fx-btn fx-btn-lg ${danger ? 'fx-btn-danger-fill' : 'fx-btn-primary'}`}>
                    {currentModal.confirmLabel ||
                     (currentModal.type === 'alert' ? 'Понятно' :
                      currentModal.type === 'confirm' ? 'Подтвердить' :
                      'Сохранить')}
                 </button>
              </div>
           </form>

           <button
             type="button"
             onClick={() => closeModal()}
             className="fx-ibtn absolute top-3 right-3"
             aria-label="Закрыть окно"
           >
              <X />
           </button>
        </motion.div>
      </div>
    </AnimatePresence>
  );
}
