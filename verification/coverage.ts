import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { loadRegistry } from './registry';
import { programSourceInventory, registeredRoutes } from './sourceInventory';

function duplicateRoutePaths(source: string): string[] {
  const ast = ts.createSourceFile('sections.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const occurrences = new Map<string, number>();
  const visit = (node: ts.Node) => {
    if (ts.isPropertyAssignment(node) && node.name.getText(ast) === 'path' && ts.isStringLiteralLike(node.initializer)) {
      occurrences.set(node.initializer.text, (occurrences.get(node.initializer.text) ?? 0) + 1);
    }
    ts.forEachChild(node, visit);
  };
  visit(ast);
  return [...occurrences].filter(([, count]) => count > 1).map(([route]) => route).sort();
}

export function inventoryCoverage(root = process.cwd()) {
  const registry = loadRegistry(root);
  const programs = registry.manifests.flatMap(m => m.programs);
  const sections = readFileSync(join(root, 'src/workspace/sections.tsx'), 'utf8');
  const routes = registeredRoutes(sections);
  const duplicateRoutes = duplicateRoutePaths(sections);
  const specialRoutes = ['/sticker', '/capture', '/native-app'];
  const expectedRoutes = [...new Set([...routes, ...specialRoutes])].sort();
  const declaredRoutes = new Set(programs.flatMap(p => p.routes));
  const controls = programSourceInventory(root, programs);
  const actions = registry.manifests.flatMap(m => m.actions);
  const connections = registry.manifests.flatMap(m => m.connections);
  const missingRoutes = expectedRoutes.filter(p => !declaredRoutes.has(p));
  const emptyPrograms = programs.filter(p => !actions.some(a => a.program === p.id)).map(p => p.id);
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    inventoryValid: missingRoutes.length === 0 && duplicateRoutes.length === 0 && emptyPrograms.length === 0,
    missingRoutes,
    duplicateRoutes,
    emptyPrograms,
    routes: { expected: expectedRoutes, declared: [...declaredRoutes].sort() },
    programs: programs.map(p => ({
      id: p.id, label: p.label,
      actions: actions.filter(a => a.program === p.id).length,
      withoutAutomatedClaim: actions.filter(a => a.program === p.id && a.checks.length === 0).map(a => a.id),
      manualScenariosNotRun: actions.filter(a => a.program === p.id).reduce((sum, a) => sum + a.manual.length, 0),
      sourceInventory: controls.find(c => c.program === p.id),
    })),
    connections: {
      implemented: connections.filter(c => c.status === 'implemented').length,
      conditional: connections.filter(c => c.status === 'conditional').length,
      planned: connections.filter(c => c.status === 'planned').length,
      withoutAutomatedClaim: connections.filter(c => c.status !== 'planned' && c.checks.length === 0).map(c => c.id),
    },
    summary: {
      programs: programs.length, actions: actions.length, suiteAliases: registry.suites.size,
      sourceBindings: controls.reduce((sum, c) => sum + c.sourceBindings, 0),
      actionsWithoutAutomatedClaim: actions.filter(a => !a.checks.length).length,
    },
    limitation: 'INVENTORY_ONLY: declaring a scenario or finding a source binding does not prove it passed. Native/portable/manual proof and complete control-to-contract mapping remain separate.',
  };
}
