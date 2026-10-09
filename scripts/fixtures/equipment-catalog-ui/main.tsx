import React from 'react';
import { createRoot } from 'react-dom/client';
import CatalogSourcePanel from '../../../src/components/equipment/CatalogSourcePanel';
import '../../../src/index.css';
function Fixture() { return <main className="mx-auto max-w-3xl p-4 @container"><CatalogSourcePanel componentId="catalog-fixture" version={1} equipClass="Клапан" onChanged={() => {}} /></main>; }
createRoot(document.getElementById('root')!).render(<Fixture />);
