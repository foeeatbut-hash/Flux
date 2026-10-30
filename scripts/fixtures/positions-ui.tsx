import React from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import UsersManagement from '../../src/screens/UsersManagement';
import { useStore } from '../../src/store/store';
import '../../src/index.css';
// Кто смотрит экран — из адреса: ?as=owner | keeper (администратор со справочником) | admin (без него)
const as = new URLSearchParams(location.search).get('as') || 'owner';
const grant = (...ids: string[]) => JSON.stringify(Object.fromEntries(ids.map((id) => [id, { enabled: true, until: null }])));
const viewers: Record<string, any> = {
  owner: { id: 'owner', name: 'Владелец', role: 'OWNER', isActive: true },
  keeper: { id: 'keeper', name: 'Админ справочника', role: 'ADMIN', isActive: true, permissions: grant('admin.users.manage', 'admin.users.create', 'admin.roles.manage') },
  admin: { id: 'admin', name: 'Админ', role: 'ADMIN', isActive: true, permissions: grant('admin.users.manage', 'admin.users.create') },
};
useStore.setState({ user: viewers[as] as any });
(window as any).electron = { updateDevice: async () => ({ deviceId: 'admin-device', publicKey: 'a'.repeat(64) }) };
createRoot(document.getElementById('mount')!).render(<MemoryRouter><UsersManagement /></MemoryRouter>);
