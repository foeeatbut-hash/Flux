import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import EmployeeImportDialog from '../../src/components/users/EmployeeImportDialog';
import ModalProvider from '../../src/components/ModalProvider';
import { PaneContext } from '../../src/lib/paneTitle';
import { useStore } from '../../src/store/store';
import { useModalStore } from '../../src/store/modalStore';
import '../../src/index.css';

const roles = [
  { id: 'eng', code: 'ENGINEER_VENT', name: 'Инженер', description: '', color: 'slate', icon: '', level: 2, isSystem: true, sortOrder: 1 },
  { id: 'admin', code: 'ADMIN', name: 'Администратор', description: '', color: 'rose', icon: '', level: 1, isSystem: true, sortOrder: 2 },
  { id: 'owner', code: 'OWNER', name: 'Владелец', description: '', color: 'rose', icon: '', level: 0, isSystem: true, sortOrder: 3 },
];
useStore.setState({ user: { id: 'employee-ui-actor', name: 'Тест', symbol: 'TEST', role: 'ADMIN' } as any });
(window as any).__setTestActor = (id: string) => useStore.setState({ user: { id, name: 'Тест', symbol: 'TEST', role: 'ADMIN' } as any });

function Fixture() {
  const [open, setOpen] = useState(true);
  const [completed, setCompleted] = useState(0);
  (window as any).__reopen = () => setOpen(true);
  (window as any).__completed = () => completed;
  (window as any).__cancelModal = () => useModalStore.getState().closeModal();
  return <PaneContext.Provider value="win:employee-import-ui"><main className="min-h-screen p-2">
    <button type="button" onClick={() => setOpen(true)}>Открыть импорт</button>
    {open && <EmployeeImportDialog roles={roles as any} onClose={() => setOpen(false)} onComplete={() => setCompleted((n) => n + 1)} />}
    <ModalProvider />
  </main></PaneContext.Provider>;
}

createRoot(document.getElementById('mount')!).render(<Fixture />);
