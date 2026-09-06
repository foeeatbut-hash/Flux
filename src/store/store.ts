import { create } from 'zustand';
import { setNotifUser } from '../lib/notifPrefs';

type User = {
  id: string;
  name: string;
  symbol: string;
  login?: string;
  role: string;
  permissions?: string | null;
};

type Project = {
  id: string;
  name: string;
};

interface AppState {
  user: User | null;
  setUser: (user: User | null) => void;
  activeProject: Project | null;
  setActiveProject: (project: Project | null) => void;
  // Theme state
  theme: 'light' | 'dark';
  toggleTheme: () => void;
  // Explorer state
  explorerHistory: (string | null)[];
  explorerForward: (string | null)[];
  pushHistory: (folderId: string | null) => void;
  goBack: () => string | null | undefined;
  goForward: () => string | null | undefined;
  clearHistory: () => void;
  // Sync Status
  syncStatus: 'idle' | 'saving' | 'success' | 'error';
  setSyncStatus: (status: 'idle' | 'saving' | 'success' | 'error') => void;
  // Внешний вид рабочего места
  density: Density;
  setDensity: (d: Density) => void;
}

// Плотность рабочего места: инженеру нужно видеть больше строк на экране,
// но не всем и не всегда. Класс вешается на <html>, конкретные размеры
// живут в index.css рядом с остальными переменными оформления.
export type Density = 'compact' | 'standard' | 'comfortable';

const DENSITY_KEY = 'flux_density';


export function applyDensity(d: Density) {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  root.classList.remove('density-compact', 'density-standard', 'density-comfortable');
  root.classList.add(`density-${d}`);
}

let syncTimeoutId: any = null;

export const useStore = create<AppState>((set, get) => {
  // Apply initial theme on startup
  const initialTheme = (typeof window !== 'undefined' ? localStorage.getItem('theme') : 'light') as 'light' | 'dark' || 'light';
  if (typeof window !== 'undefined') {
    if (initialTheme === 'dark') {
      document.documentElement.classList.add('dark');
    } else {
      document.documentElement.classList.remove('dark');
    }
  }

  const initialDensity = ((typeof window !== 'undefined' && localStorage.getItem(DENSITY_KEY)) || 'standard') as Density;
  applyDensity(initialDensity);
  // Восстанавливаем сессию: окна-стикеры и перезапуск не должны требовать повторного входа
  let initialUser: User | null = null;
  let initialProject: Project | null = null;
  try {
    const savedSession = typeof window !== 'undefined' ? localStorage.getItem('pdm_session_user') : null;
    if (savedSession) {
      initialUser = JSON.parse(savedSession);
      // Восстанавливаем и активный проект, иначе проектные разделы просят выбрать проект после перезагрузки
      const savedProjectStr = initialUser ? localStorage.getItem(`max_active_project_${initialUser.id}`) : null;
      if (savedProjectStr) initialProject = JSON.parse(savedProjectStr);
    }
  } catch (e) {}

  try { setNotifUser(initialUser?.id); } catch (e) {}

  return {
    user: initialUser,
    activeProject: initialProject,
    setUser: (user) => {
      try {
        if (user) {
          localStorage.setItem('pdm_session_user', JSON.stringify(user));
        } else {
          localStorage.removeItem('pdm_session_user');
          localStorage.removeItem('flux_auth_token'); // выход = конец сессии API
        }
      } catch (e) {}
      setNotifUser(user?.id);
      if (user) {
        // Load user-specific active project
        const savedProjectStr = localStorage.getItem(`max_active_project_${user.id}`);
        let lastProject = null;
        if (savedProjectStr) {
          try {
            lastProject = JSON.parse(savedProjectStr);
          } catch (e) {
            console.error('Error parsing user active project:', e);
          }
        }

        // Load user-specific active theme
        const userTheme = (localStorage.getItem(`max_theme_${user.id}`) || localStorage.getItem('theme') || 'light') as 'light' | 'dark';
        if (userTheme === 'dark') {
          document.documentElement.classList.add('dark');
        } else {
          document.documentElement.classList.remove('dark');
        }

        set({
          user,
          activeProject: lastProject,
          theme: userTheme,
          explorerHistory: [null],
          explorerForward: []
        });
      } else {
        set({ user, activeProject: null });
      }
    },
    setActiveProject: (project) => {
      const state = get();
      if (state.user) {
        if (project) {
          localStorage.setItem(`max_active_project_${state.user.id}`, JSON.stringify(project));
        } else {
          localStorage.removeItem(`max_active_project_${state.user.id}`);
        }
      }
      set({ activeProject: project, explorerHistory: [null], explorerForward: [] });
    },
    
    theme: initialTheme,
    toggleTheme: () => {
      const nextTheme = get().theme === 'light' ? 'dark' : 'light';
      localStorage.setItem('theme', nextTheme);
      
      const state = get();
      if (state.user) {
        localStorage.setItem(`max_theme_${state.user.id}`, nextTheme);
      }

      if (nextTheme === 'dark') {
        document.documentElement.classList.add('dark');
      } else {
        document.documentElement.classList.remove('dark');
      }
      set({ theme: nextTheme });
    },

    density: initialDensity,
    setDensity: (d) => {
      localStorage.setItem(DENSITY_KEY, d);
      applyDensity(d);
      set({ density: d });
    },

    explorerHistory: [null],
    explorerForward: [],
    pushHistory: (folderId) => set((state) => {
      const current = state.explorerHistory[state.explorerHistory.length - 1];
      if (current === folderId) return state; // don't push duplicates
      return { 
        explorerHistory: [...state.explorerHistory, folderId],
        explorerForward: [] // clear forward history on new navigation
      };
    }),
    goBack: () => {
      const { explorerHistory, explorerForward } = get();
      if (explorerHistory.length > 1) {
        const newHistory = [...explorerHistory];
        const current = newHistory.pop() as string | null;
        set({ explorerHistory: newHistory, explorerForward: [current, ...explorerForward] });
        return newHistory[newHistory.length - 1];
      }
      return undefined;
    },
    goForward: () => {
      const { explorerHistory, explorerForward } = get();
      if (explorerForward.length > 0) {
        const newForward = [...explorerForward];
        const next = newForward.shift() as string | null;
        set({ explorerHistory: [...explorerHistory, next], explorerForward: newForward });
        return next;
      }
      return undefined;
    },
    clearHistory: () => set({ explorerHistory: [null], explorerForward: [] }),

    syncStatus: 'idle',
    setSyncStatus: (status) => {
      if (syncTimeoutId) {
        clearTimeout(syncTimeoutId);
        syncTimeoutId = null;
      }
      
      set({ syncStatus: status });
      
      if (status === 'success') {
        syncTimeoutId = setTimeout(() => {
          set({ syncStatus: 'idle' });
        }, 2000);
      }
    }
  };
});
