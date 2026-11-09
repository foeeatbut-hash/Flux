import React from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import SettingsScreen from '../../src/screens/SettingsScreen';
import ModalProvider from '../../src/components/ModalProvider';
import { useStore } from '../../src/store/store';
import { useToastStore } from '../../src/store/toastStore';
import '../../src/index.css';

// Роль берётся из адреса (?role=OWNER) — так проверяется, что владельцу раздел не показывается
const role = new URLSearchParams(location.search).get('role') || 'ADMIN';
useStore.setState({ user: { id: 'u-self', name: 'Иванова Мария', symbol: '3310', role, isActive: true } as any });
// Уведомления копятся здесь: на странице проверки их контейнер не нарисован, а исчезают они по таймеру
const seen: string[] = [];
useToastStore.subscribe((state) => { for (const t of state.toasts) if (!seen.includes(t.message)) seen.push(t.message); });
(window as any).__toasts = () => seen;
(window as any).__user = () => useStore.getState().user?.id ?? null;
createRoot(document.getElementById('mount')!).render(
  <MemoryRouter initialEntries={['/settings?section=password']}><SettingsScreen /><ModalProvider /></MemoryRouter>,
);
