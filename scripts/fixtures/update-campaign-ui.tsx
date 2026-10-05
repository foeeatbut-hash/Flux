import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import UpdateCampaignPanel from '../../src/components/users/UpdateCampaignPanel';
import { useStore } from '../../src/store/store';
import '../../src/index.css';
useStore.setState({ user: { id: 'admin', name: 'Администратор', role: 'ADMIN' } as any });
(window as any).electron = {
  updateDevice: async () => ({ deviceId: 'admin-device', publicKey: 'a'.repeat(64) }),
  signUpdateCommand: async (data: any) => { (window as any).__signed = [...((window as any).__signed || []), data]; return { command: data.payload, delegation: data.delegation, releaseSignature: data.releaseSignature }; },
};
function Fixture() {
  const [ids, setIds] = useState(Array.from({ length: 27 }, (_, i) => `employee${i}`));
  (window as any).__filterEmployees = setIds;
  return <main className="p-3"><UpdateCampaignPanel employeeIds={ids} /></main>;
}
createRoot(document.getElementById('mount')!).render(<Fixture />);
