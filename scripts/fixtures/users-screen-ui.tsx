import React from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import UsersManagement from '../../src/screens/UsersManagement';
import { useStore } from '../../src/store/store';
import '../../src/index.css';
// ?as=admin — администратор с полным правом на сотрудников: обновлений у него нет, как и у владельца на этом экране
const admin = new URLSearchParams(location.search).get('as') === 'admin';
useStore.setState({ user: (admin ? { id: 'admin', name: 'Админ', role: 'ADMIN', isActive: true, permissions: { 'admin.users.manage': { enabled: true, until: null } } } : { id: 'owner', name: 'Владелец', role: 'OWNER', isActive: true }) as any });
(window as any).electron = { updateDevice: async () => ({ deviceId: 'admin-device', publicKey: 'a'.repeat(64) }) };
createRoot(document.getElementById('mount')!).render(<MemoryRouter><UsersManagement /></MemoryRouter>);
