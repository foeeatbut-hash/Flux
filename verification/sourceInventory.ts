import { readFileSync, realpathSync } from 'node:fs';
import { resolve, relative, sep } from 'node:path';
import ts from 'typescript';

export interface SourceControl {
  file: string;
  line: number;
  kind: 'jsx' | 'html' | 'registration';
  control: string;
  label: string;
  events: string[];
}

const CONTROL = /^(button|input|select|textarea|a|Btn|Button|Select|Switch|Toggle|Tab|MenuItem)$/;
const EVENTS = new Set(['click', 'change', 'keydown', 'keyup', 'drop', 'paste', 'submit', 'contextmenu', 'pointerdown']);
const compact = (s: string) => s.replace(/\s+/g, ' ').trim().slice(0, 160);

/** Inventory is evidence of source bindings, not a claim that a click was tested. */
export function scanSourceControls(file: string, source: string): SourceControl[] {
  const result: SourceControl[] = [];
  if (/\.html?$/.test(file)) {
    const clean = source.replace(/<!--[\s\S]*?-->/g, m => m.replace(/[^\n]/g, ' '));
    for (const match of clean.matchAll(/<(button|input|select|textarea|a)\b([^>]*)(?:>)/gi)) {
      if (match[1].toLowerCase() === 'a' && !/\bhref\s*=/.test(match[2])) continue;
      const names = [...match[2].matchAll(/\b(on\w+)\s*=/gi)].map(m => m[1]);
      const label = match[2].match(/(?:aria-label|title|id)\s*=\s*["']([^"']+)["']/i)?.[1] || '';
      result.push({ file, line: clean.slice(0, match.index).split('\n').length, kind: 'html', control: match[1], label: compact(label), events: names });
    }
    return result;
  }
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const line = (node: ts.Node) => ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1;
  const literal = (node?: ts.Node) => node && (ts.isStringLiteralLike(node) || ts.isNumericLiteral(node)) ? node.text : '';
  const labelOf = (node: ts.JsxOpeningElement | ts.JsxSelfClosingElement): string => {
    for (const attr of node.attributes.properties) {
      if (ts.isJsxAttribute(attr) && ['aria-label', 'title'].includes(attr.name.getText(ast))) {
        const value = attr.initializer;
        const text = literal(value) || (value && ts.isJsxExpression(value) ? literal(value.expression) : '');
        if (text) return compact(text);
      }
    }
    const texts: string[] = [];
    const collect = (n: ts.Node) => {
      if (ts.isJsxText(n)) texts.push(n.text);
      else if (ts.isJsxExpression(n)) { const value = literal(n.expression); if (value) texts.push(value); }
      else ts.forEachChild(n, collect);
    };
    if (ts.isJsxElement(node.parent)) node.parent.children.forEach(collect);
    return compact(texts.join(' '));
  };
  const visit = (node: ts.Node) => {
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const control = node.tagName.getText(ast);
      const attrs = node.attributes.properties.filter(ts.isJsxAttribute);
      const events = attrs.map(a => a.name.getText(ast)).filter(a => /^on[A-Z]/.test(a));
      const actionableLink = control === 'a' && attrs.some(a => a.name.getText(ast) === 'href');
      const role = attrs.find(a => a.name.getText(ast) === 'role');
      const roleButton = role && literal(role.initializer) === 'button';
      if (events.length || (CONTROL.test(control) && control !== 'a') || actionableLink || roleButton) {
        result.push({ file, line: line(node), kind: 'jsx', control, label: labelOf(node), events });
      }
    }
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const method = node.expression.name.text;
      const event = literal(node.arguments[0]);
      const listener = method === 'addEventListener' && EVENTS.has(event);
      const channel = ['handle', 'on', 'listen'].includes(method) && Boolean(event);
      if (listener || channel) result.push({ file, line: line(node), kind: 'registration', control: method, label: event, events: [event] });
    }
    ts.forEachChild(node, visit);
  };
  visit(ast);
  return result;
}

export function programSourceInventory(root: string, programs: readonly { id: string; sources: string[] }[]) {
  const base = realpathSync(root);
  const cache = new Map<string, SourceControl[]>();
  return programs.map(program => {
    const controls = [...new Set(program.sources)].flatMap(file => {
      const full = realpathSync(resolve(base, file));
      if (full !== base && !full.startsWith(base + sep)) throw new Error(`Source outside workspace: ${file}`);
      if (!cache.has(file)) cache.set(file, scanSourceControls(relative(base, full).split(sep).join('/'), readFileSync(full, 'utf8')));
      return cache.get(file)!;
    });
    return { program: program.id, sources: [...new Set(program.sources)], controls, sourceBindings: controls.length,
      status: 'INVENTORY_ONLY' as const,
      limitation: 'Source bindings are not unique semantic actions. Dynamic menus, inherited controls and native UI require additional inspection; no button execution is certified.' };
  });
}

export function registeredRoutes(source: string): string[] {
  const ast = ts.createSourceFile('sections.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const routes = new Set<string>();
  const visit = (node: ts.Node) => {
    if (ts.isPropertyAssignment(node) && node.name.getText(ast) === 'path' && ts.isStringLiteralLike(node.initializer)) routes.add(node.initializer.text);
    ts.forEachChild(node, visit);
  };
  visit(ast);
  return [...routes].sort();
}
