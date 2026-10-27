import React from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import UsersManagement from '../../src/screens/UsersManagement';
import { useStore } from '../../src/store/store';
import '../../src/index.css';
useStore.setState({ user: { id: 'owner', name: 'Владелец', role: 'OWNER', isActive: true } as any });
(window as any).electron = { updateDevice: async () => ({ deviceId: 'admin-device', publicKey: 'a'.repeat(64) }) };
createRoot(document.getElementById('mount')!).render(<MemoryRouter><UsersManagement /></MemoryRouter>);
