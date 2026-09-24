import React, { useEffect, useState } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { createPortal } from 'react-dom';
import { useShareStore, ShareCandidate } from '../store/shareStore';
import { useChatStore } from '../store/chatStore';
import { useStore } from '../store/store';
import { useToastStore } from '../store/toastStore';
import { dataService, User } from '../services/dataService';
import { encodeShare } from '../lib/shareLink';
import { Share2, Search, X, Link2 } from 'lucide-react';

export default function ShareLayer() {
  const navigate = useNavigate();
  const location = useLocation();
  const { user, activeProject } = useStore();
  const { menu, openMenu, closeMenu, pickerCandidate, openPicker, closePicker, focusTarget, clearFocus } = useShareStore();
  const { addToast } = useToastStore();
  const [users, setUsers] = useState<User[]>([]);
  const [q, setQ] = useState('');

  // Подсветка цели у получателя после перехода по ссылке
  useEffect(() => {
    if (!focusTarget) return;
    if (location.pathname !== focusTarget.r) return; // ждём перехода на нужный маршрут
    // Карточки на холсте тегов центрирует сам раздел «Теги» (scrollIntoView не работает на холсте)
    if (focusTarget.r === '/registry' && (focusTarget.f || '').startsWith('tag:')) return;
    const timer = setTimeout(() => {
      let el: HTMLElement | null = null;
      if (focusTarget.f) el = document.querySelector(`[data-share-focus="${CSS.escape(focusTarget.f)}"]`);
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        el.classList.add('share-pulse');
        setTimeout(() => el && el.classList.remove('share-pulse'), 3200);
      } else if (focusTarget.s) {
        try { (window as any).find?.(focusTarget.s); } catch {}
        addToast(`Искомое: «${focusTarget.l}»`, 'info');
      } else {
        addToast(`Открыт раздел: ${focusTarget.l}`, 'info');
      }
      clearFocus();
    }, 450);
    return () => clearTimeout(timer);
  }, [focusTarget, location.pathname]);

  // Глобальный правый клик: текст-выделение или элемент с data-share-route
  useEffect(() => {
    const onCtx = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (!target) return;
      const tag = target.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || (target as any).isContentEditable) return;

      const sel = (window.getSelection()?.toString() || '').trim();
      let candidate: ShareCandidate | null = null;
      if (sel.length > 1) {
        candidate = { type: 'text', route: location.pathname, label: sel.length > 80 ? sel.slice(0, 80) + '…' : sel, sel };
      } else {
        const el = target.closest('[data-share-route]') as HTMLElement | null;
        if (el) {
          candidate = {
            type: 'el',
            route: el.getAttribute('data-share-route') || location.pathname,
            focus: el.getAttribute('data-share-focus') || undefined,
            label: el.getAttribute('data-share-label') || 'Ссылка',
          };
        }
      }
      if (candidate) {
        e.preventDefault();
        openMenu(e.clientX, e.clientY, candidate);
      }
    };
    document.addEventListener('contextmenu', onCtx);
    return () => document.removeEventListener('contextmenu', onCtx);
  }, [location.pathname]);

  // Закрытие мини-меню по клику/скроллу/Esc
  useEffect(() => {
    if (!menu) return;
    const close = () => closeMenu();
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') closeMenu(); };
    window.addEventListener('click', close);
    window.addEventListener('scroll', close, true);
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('click', close); window.removeEventListener('scroll', close, true); window.removeEventListener('keydown', onKey); };
  }, [menu]);

  useEffect(() => {
    if (pickerCandidate) {
      setQ('');
      dataService.getUsers().then(setUsers).catch(() => {});
    }
  }, [pickerCandidate]);

  const share = (target: User) => {
    if (!pickerCandidate) return;
    // insert — готовый набор токенов (мультивыбор): каждый элемент отдельной кнопкой в одном сообщении
    const token = pickerCandidate.insert ?? encodeShare({
      r: pickerCandidate.route,
      f: pickerCandidate.focus,
      l: pickerCandidate.label,
      s: pickerCandidate.sel,
      ty: pickerCandidate.type,
      p: activeProject?.id,
      pn: activeProject?.name,
    });
    useChatStore.getState().setPendingShare(target.id, token + ' ');
    closePicker();
    navigate('/chat');
  };

  const list = users.filter(u => u.id !== user?.id && (u.name?.toLowerCase().includes(q.toLowerCase()) || u.symbol?.toLowerCase().includes(q.toLowerCase())));

  return (
    <>
      {/* Мини-меню «Поделиться» */}
      {menu && createPortal(
        <div className="fx-pop fixed z-[120] min-w-[180px]"
          style={{ top: Math.min(menu.y, window.innerHeight - 90), left: Math.min(menu.x, window.innerWidth - 200) }}
          onClick={(e) => e.stopPropagation()}>
          <div className="px-2 py-1 text-xs text-slate-400 truncate max-w-[200px]">{menu.candidate.label}</div>
          <button type="button" onClick={() => openPicker(menu.candidate)} className="fx-menu-item">
            <Share2 /> Поделиться в чате
          </button>
        </div>, document.body)}

      {/* Выбор пользователя */}
      {pickerCandidate && createPortal(
        <div className="fixed inset-0 z-[120] flex items-center justify-center p-4 fx-backdrop" onClick={closePicker}>
          <div className="w-[min(94vw,380px)] fx-dialog overflow-hidden flex flex-col max-h-[80vh]" onClick={(e) => e.stopPropagation()}>
            <div className="px-4 py-3 border-b border-slate-100 dark:border-dark-border flex items-center justify-between">
              <div className="text-base font-semibold text-slate-900 dark:text-white">Кому отправить</div>
              <button type="button" title="Закрыть" onClick={closePicker} aria-label="Закрыть" className="fx-ibtn"><X /></button>
            </div>
            <div className="p-2.5 flex items-center gap-2 border-b border-slate-100 dark:border-dark-border">
              <div className="flex items-center gap-1.5 min-w-0 text-sm text-slate-600 dark:text-slate-300 max-w-full overflow-hidden">
                <Link2 className="w-3.5 h-3.5 shrink-0" /> <span className="flex-1 min-w-0 truncate">{pickerCandidate.label}</span>
              </div>
            </div>
            <div className="p-2.5 border-b border-slate-100 dark:border-dark-border relative">
              <Search className="w-4 h-4 absolute left-4 top-1/2 -translate-y-1/2 text-slate-400" />
              <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Поиск сотрудника…" className="w-full pl-8 pr-3 py-1.5 bg-slate-50 dark:bg-dark-surface border border-slate-200 dark:border-dark-border rounded-lg text-sm text-slate-800 dark:text-white focus:outline-none focus:border-emerald-500" />
            </div>
            <div className="flex-1 overflow-y-auto scrollbar-thin p-1.5">
              {list.length === 0 ? (
                <div className="text-center text-xs text-slate-400 py-8">Нет сотрудников</div>
              ) : list.map(u => (
                <button type="button" key={u.id} onClick={() => share(u)} className="fx-li !h-auto py-1.5">
                  <span className="fx-av !w-7 !h-7 !text-xs">{(u.name || '?').charAt(0)}</span>
                  <div className="min-w-0">
                    <div className="text-sm text-slate-800 dark:text-dark-text-main truncate">{u.name}</div>
                    <div className="text-xs text-slate-400 truncate">{u.symbol}</div>
                  </div>
                </button>
              ))}
            </div>
          </div>
        </div>, document.body)}
    </>
  );
}
