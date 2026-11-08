import React from 'react';
import { createRoot } from 'react-dom/client';
import ProjectCatalog from '../../src/components/catalog/ProjectCatalog';
import './catalog-ui/fixture.css';

createRoot(document.getElementById('root')!).render(<div className="h-full bg-[var(--flux-bg)] text-[var(--flux-text)]"><ProjectCatalog projectId="project-fixture" canProposeCommon /></div>);
