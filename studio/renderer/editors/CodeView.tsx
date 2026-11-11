/**
 * Окно редактора текста на CodeMirror 6.
 *
 * Берётся из npm и входит в сборку Studio: Studio работает в закрытой сети, поэтому ничего не
 * грузится с CDN. Подсветка размечена классами (cm-tok-*), а не встроенными стилями: цвета
 * лежат в styles.ts и следуют теме Studio, а CSP окна не разрешает style="".
 */
import React, { useEffect, useRef, useState } from 'react';
import { Annotation, EditorState, type Extension } from '@codemirror/state';
import { EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter, drawSelection } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { HighlightStyle, StreamLanguage, bracketMatching, syntaxHighlighting } from '@codemirror/language';
import { autocompletion, completionKeymap, type CompletionSource } from '@codemirror/autocomplete';
import { lintGutter, setDiagnostics, type Diagnostic } from '@codemirror/lint';
import { javascript } from '@codemirror/lang-javascript';
import { json } from '@codemirror/lang-json';
import { python } from '@codemirror/lang-python';
import { rust } from '@codemirror/lang-rust';
import { cpp } from '@codemirror/lang-cpp';
import { go } from '@codemirror/legacy-modes/mode/go';
import { csharp } from '@codemirror/legacy-modes/mode/clike';
import { tags } from '@lezer/highlight';
import { installShadowStyles } from './styles';
import type { CodeLanguage } from './types';

/** Пометка «текст заменили снаружи»: такие изменения не возвращаются в onChange */
const external = Annotation.define<boolean>();

const highlight = HighlightStyle.define([
  { tag: [tags.keyword, tags.controlKeyword, tags.definitionKeyword, tags.moduleKeyword, tags.operatorKeyword], class: 'cm-tok-keyword' },
  { tag: [tags.string, tags.special(tags.string), tags.regexp], class: 'cm-tok-string' },
  { tag: [tags.number, tags.bool, tags.null, tags.atom], class: 'cm-tok-number' },
  { tag: [tags.comment, tags.lineComment, tags.blockComment], class: 'cm-tok-comment' },
  { tag: [tags.propertyName, tags.definition(tags.variableName), tags.function(tags.variableName)], class: 'cm-tok-name' },
  { tag: [tags.typeName, tags.className, tags.namespace], class: 'cm-tok-type' },
]);

export function languageSupport(language: CodeLanguage | 'json'): Extension {
  switch (language) {
    case 'json': return json();
    case 'typescript': return javascript({ typescript: true });
    case 'javascript': return javascript();
    case 'python': return python();
    case 'rust': return rust();
    case 'cpp': case 'c': return cpp();
    case 'go': return StreamLanguage.define(go);
    case 'csharp': return StreamLanguage.define(csharp);
  }
}

export interface MarkedLine { line: number; column: number; length?: number; message: string; severity: 'error' | 'warning' }

interface Props {
  value: string;
  onChange?: (value: string) => void;
  language: CodeLanguage | 'json';
  /** Имя окна для читалок экрана и для проверок */
  label: string;
  readOnly?: boolean;
  marks?: MarkedLine[];
  complete?: CompletionSource;
  /** Перейти к строке и сфокусироваться; новое значение `nonce` повторяет переход */
  reveal?: { line: number; nonce: number } | null;
  testId?: string;
}

export function CodeView({ value, onChange, language, label, readOnly, marks, complete, reveal, testId }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const change = useRef(onChange);
  change.current = onChange;
  const completion = useRef(complete);
  completion.current = complete;
  const [unsupported, setUnsupported] = useState(false);

  useEffect(() => {
    // CodeMirror кладёт свои стили в <style>, а CSP окна Studio его не пускает. В теневом корне он
    // пользуется constructable stylesheet, который CSP разрешает, — поэтому редактор живёт в нём.
    const shadow = host.current!.shadowRoot ?? host.current!.attachShadow({ mode: 'open' });
    if (!shadow.adoptedStyleSheets.length && !shadow.querySelector('style') && !installShadowStyles(shadow)) { setUnsupported(true); return; }
    const mount = document.createElement('div');
    mount.style.height = '100%';
    shadow.append(mount);
    const view0 = new EditorView({
      parent: mount,
      root: shadow,
      state: EditorState.create({
        doc: value,
        extensions: [
          lineNumbers(), highlightActiveLine(), highlightActiveLineGutter(), drawSelection(), history(), bracketMatching(), lintGutter(),
          syntaxHighlighting(highlight), languageSupport(language),
          autocompletion({ override: [context => completion.current?.(context) ?? null] }),
          keymap.of([...completionKeymap, ...defaultKeymap, ...historyKeymap]),
          EditorView.contentAttributes.of({ 'aria-label': label, 'aria-multiline': 'true' }),
          EditorState.readOnly.of(!!readOnly),
          ...(language === 'json' ? [EditorView.lineWrapping] : []),
          EditorView.updateListener.of(update => { if (update.docChanged && !update.transactions.some(t => t.annotation(external))) change.current?.(update.state.doc.toString()); }),
        ],
      }),
    });
    view.current = view0;
    return () => { view0.destroy(); mount.remove(); view.current = null; };
    // Окно создаётся один раз на язык и подпись; значение и подсветка ошибок обновляются ниже
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [language, label, readOnly]);

  useEffect(() => {
    const current = view.current;
    if (!current || current.state.doc.toString() === value) return;
    // Меняется только отличающаяся середина: курсор и выделение остаются на месте, а не прыгают в начало
    const old = current.state.doc.toString();
    let start = 0;
    while (start < old.length && start < value.length && old[start] === value[start]) start++;
    let endOld = old.length, endNew = value.length;
    while (endOld > start && endNew > start && old[endOld - 1] === value[endNew - 1]) { endOld--; endNew--; }
    current.dispatch({ changes: { from: start, to: endOld, insert: value.slice(start, endNew) }, annotations: external.of(true) });
  }, [value, language, label, readOnly]);

  useEffect(() => {
    const current = view.current;
    if (!current) return;
    const doc = current.state.doc;
    const diagnostics: Diagnostic[] = (marks ?? []).filter(mark => mark.line >= 1 && mark.line <= doc.lines).map(mark => {
      const line = doc.line(mark.line);
      const from = Math.min(line.from + Math.max(0, mark.column - 1), line.to);
      return { from, to: mark.length ? Math.min(from + mark.length, line.to) : line.to, severity: mark.severity, message: mark.message };
    });
    current.dispatch(setDiagnostics(current.state, diagnostics));
  }, [marks, value, language, label, readOnly]);

  useEffect(() => {
    const current = view.current;
    if (!current || !reveal || reveal.line < 1 || reveal.line > current.state.doc.lines) return;
    const line = current.state.doc.line(reveal.line);
    current.dispatch({ selection: { anchor: line.from }, scrollIntoView: true });
    current.focus();
  }, [reveal]);

  return (
    <>
      <div className="ed-cm" ref={host} data-testid={testId} hidden={unsupported} />
      {unsupported && <p className="ed-error" role="alert">Редактор не запустился: окно не поддерживает нужные стили (constructable stylesheets). Обновите Studio до свежей версии.</p>}
    </>
  );
}
