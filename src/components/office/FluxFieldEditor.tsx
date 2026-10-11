/**
 * Редактор ячейки шапки с защищёнными метками полей и текстом (ТЗ Flux Office §6).
 *
 * Представляет ячейку как упорядоченные части: текстовые фрагменты и метки-поля.
 * НЕ пересоздаёт innerHTML при каждом вводе — редактируются только текстовые части.
 * Backspace удаляет текст, но не метку. Метки не исчезают при Undo/Redo/фокусе.
 */
import React, { useRef, useEffect, useCallback } from 'react';
import { FluxFieldToken } from './FluxFieldToken';

export interface FieldPart {
  type: 'text' | 'field';
  value?: string;
  fieldKey?: string;
  fieldLabel?: string;
}

export interface FluxFieldEditorProps {
  parts: FieldPart[];
  onChange: (parts: FieldPart[]) => void;
  placeholder?: string;
  className?: string;
  editable?: boolean;
  onRemoveField?: (fieldKey: string) => void;
}

export function partsToHtml(parts: FieldPart[]): string {
  return parts.map((p) => {
    if (p.type === 'text') return escapeHtml(p.value || '');
    return `<span contenteditable="false" data-field="${escapeHtml(p.fieldKey || '')}" class="flux-chip">${escapeHtml(p.fieldLabel || p.fieldKey || '')}</span>`;
  }).join('');
}

export function htmlToParts(html: string): FieldPart[] {
  const root = document.createElement('div');
  root.innerHTML = html;
  const parts: FieldPart[] = [];
  const walk = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      const v = node.nodeValue || '';
      if (parts.length && parts[parts.length - 1].type === 'text') parts[parts.length - 1].value += v;
      else parts.push({ type: 'text', value: v });
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const el = node as HTMLElement;
    if (el.dataset?.field) {
      parts.push({ type: 'field', fieldKey: el.dataset.field, fieldLabel: el.textContent || el.dataset.field });
      return;
    }
    if (el.tagName === 'BR') { parts.push({ type: 'text', value: '\n' }); return; }
    [...el.childNodes].forEach(walk);
  };
  [...root.childNodes].forEach(walk);
  return normalizeParts(parts);
}

function normalizeParts(parts: FieldPart[]): FieldPart[] {
  const out: FieldPart[] = [];
  for (const p of parts) {
    if (p.type === 'text') {
      if (out.length && out[out.length - 1].type === 'text') out[out.length - 1].value += p.value || '';
      else out.push({ type: 'text', value: p.value || '' });
    } else if (p.type === 'field') {
      if (!out.length || out[out.length - 1].type !== 'text') out.push({ type: 'text', value: '' });
      out.push(p);
    }
  }
  if (!out.length || out[out.length - 1].type !== 'text') out.push({ type: 'text', value: '' });
  return out;
}

function escapeHtml(s: string): string {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] || c));
}

export const FluxFieldEditor = React.forwardRef<HTMLDivElement, FluxFieldEditorProps>(function FluxFieldEditor(
  { parts, onChange, placeholder, className, editable = true, onRemoveField },
  ref,
) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const lastEmitted = useRef('');

  // Синхронизация при внешнем изменении (вставка поля, undo)
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const html = partsToHtml(parts);
    if (el.innerHTML !== html) {
      const hasFocus = el.contains(document.activeElement);
      el.innerHTML = html;
      if (hasFocus) {
        const range = document.createRange();
        range.selectNodeContents(el);
        range.collapse(false);
        const sel = window.getSelection();
        sel?.removeAllRanges();
        sel?.addRange(range);
      }
    }
  }, [parts]);

  const emit = useCallback(() => {
    const el = rootRef.current;
    if (!el) return;
    const newParts = htmlToParts(el.innerHTML);
    const sig = JSON.stringify(newParts);
    if (sig !== lastEmitted.current) {
      lastEmitted.current = sig;
      onChange(newParts);
    }
  }, [onChange]);

  return (
    <div
      ref={(el) => { rootRef.current = el; if (typeof ref === 'function') ref(el); else if (ref) (ref as any).current = el; }}
      className={`editor min-h-[36px] outline-none whitespace-normal break-words ${className || ''}`}
      contentEditable={editable}
      suppressContentEditableWarning
      spellCheck={false}
      onInput={emit}
      onBlur={emit}
      data-placeholder={placeholder}
      role="textbox"
      aria-multiline="true"
      onKeyDown={(e) => {
        // Backspace/Delete не удаляет метку — только текст (ТЗ §6)
        if ((e.key === 'Backspace' || e.key === 'Delete') && !(e.target as HTMLElement).textContent) {
          e.preventDefault();
        }
      }}
    >
      {parts.length === 0 && <span className="text-slate-400 text-xs pointer-events-none">{placeholder}</span>}
    </div>
  );
});
