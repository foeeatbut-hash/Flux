import { useCallback, useState } from 'react';

/**
 * Тема окон Studio — как у Flux: выбор человека хранится под тем же ключом `theme` и включает класс `dark` на <html>
 * (src/store/store.ts). Пока человек не выбирал, тема светлая, как во Flux по умолчанию.
 */
type Theme = 'light' | 'dark';

function read(): Theme {
  try { return localStorage.getItem('theme') === 'dark' ? 'dark' : 'light'; } catch { return 'light'; }
}
const apply = (theme: Theme) => document.documentElement.classList.toggle('dark', theme === 'dark');
// До первой отрисовки: иначе тёмная тема вспыхивала бы светлой
apply(read());

export function useTheme(): { theme: Theme; toggleTheme: () => void } {
  const [theme, setTheme] = useState<Theme>(read);
  const toggleTheme = useCallback(() => {
    const next: Theme = theme === 'dark' ? 'light' : 'dark';
    try { localStorage.setItem('theme', next); } catch { /* приватный режим: тема живёт до закрытия окна */ }
    apply(next); setTheme(next);
  }, [theme]);
  return { theme, toggleTheme };
}
