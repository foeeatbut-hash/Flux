import React from 'react';
import { createRoot } from 'react-dom/client';
import CatalogSourcePanel from '../../../src/components/equipment/CatalogSourcePanel';
import { useCatalogStore } from '../../../src/store/catalogStore';
import '../../../src/index.css';
declare global { interface Window { __publishCatalogRevision?: () => void } }
window.__publishCatalogRevision = () => {
  useCatalogStore.setState(state => ({ ...state, meta: { ...state.meta, vf20: { edited: false, seedVersion: 1, updatedAt: '2026-10-02T00:00:00.000Z', deleted: false } }, stamp: 'catalog-v2' }));
  window.dispatchEvent(new Event('catalog:published'));
};
function Fixture() { return <main className="mx-auto max-w-3xl p-4 @container"><CatalogSourcePanel componentId="catalog-fixture" version={1} equipClass="Клапан" onChanged={() => {}} /></main>; }
createRoot(document.getElementById('root')!).render(<Fixture />);
