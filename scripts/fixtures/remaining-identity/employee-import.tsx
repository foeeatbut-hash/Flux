import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import EmployeeImportDialog from '../../../src/components/users/EmployeeImportDialog';
import ModalProvider from '../../../src/components/ModalProvider';
import { PaneContext } from '../../../src/lib/paneTitle';
import { useStore } from '../../../src/store/store';
import '../../../src/index.css';

const roles = [{ id: 'engineer', code: 'ENGINEER_VENT', name: 'Инженер', description: '', color: 'slate', icon: '', level: 2, isSystem: true, sortOrder: 1 }];
useStore.setState({ user: { id: 'remaining-identity-import-actor', name: 'Синтетический оператор', symbol: 'TEST-IMPORT', role: 'ADMIN' } as any });

function Fixture() {
  const [open, setOpen] = useState(true);
  return <PaneContext.Provider value="win:remaining-identity-import"><main className="min-h-screen p-2">
    <button type="button" onClick={() => setOpen(true)}>Открыть импорт</button>
    {open && <EmployeeImportDialog roles={roles as any} onClose={() => setOpen(false)} onComplete={() => undefined} />}
    <ModalProvider />
  </main></PaneContext.Provider>;
}

createRoot(document.getElementById('mount')!).render(<Fixture />);
