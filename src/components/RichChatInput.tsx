import React, { useEffect, useImperativeHandle, useRef, forwardRef } from 'react';
import { Link2 } from 'lucide-react';
import { decodeShare, SHARE_TOKEN_RE } from '../lib/shareLink';

// ── Поле ввода сообщения с «живыми» чипами ссылок ──
// Токены [[s:...]] отображаются как зелёные чипы (как в отправленном сообщении),
// вокруг можно свободно печатать, ставить пробелы и переносить строки
// (Shift+Enter). Наружу компонент отдаёт обычный текст с токенами — формат
// сообщения не меняется.

export interface RichChatInputHandle {
  focus: () => void;
  insertText: (text: string) => void;
  /** Заменяет слово перед курсором (например «#вен») на replacement */
  replaceWordBeforeCaret: (replacement: string) => void;
}

interface Props {
  value: string;
  onChange: (text: string) => void;
  /** Слово перед курсором (для автодополнения «#…»); null — нет слова */
  onCaretWord?: (word: string | null) => void;
  onKeyDown?: (e: React.KeyboardEvent) => void;
  onSend?: () => void;
  placeholder?: string;
}

// Текст → DOM: текст, чипы для [[s:...]], <br> для переносов
function renderValue(el: HTMLElement, value: string) {
  el.innerHTML = '';
  const re = new RegExp(SHARE_TOKEN_RE.source, 'g');
  let last = 0;
  let m: RegExpExecArray | null;
  const pushText = (t: string) => {
    const lines = t.split('\n');
    lines.forEach((line, i) => {
      if (i > 0) el.appendChild(document.createElement('br'));
      if (line) el.appendChild(document.createTextNode(line));
    });
  };
  while ((m = re.exec(value)) !== null) {
    if (m.index > last) pushText(value.slice(last, m.index));
    el.appendChild(makeChip(m[0]));
    last = re.lastIndex;
  }
  if (last < value.length) pushText(value.slice(last));
}

function makeChip(token: string): HTMLElement {
  const decoded = decodeShare(token);
  const chip = document.createElement('span');
  chip.contentEditable = 'false';
  chip.dataset.token = token;
  chip.className = 'inline-flex items-center gap-1 mx-0.5 px-1.5 py-0.5 bg-emerald-50 dark:bg-emerald-950/40 border border-emerald-200 dark:border-emerald-800 rounded-md text-xs font-semibold text-emerald-700 dark:text-emerald-400 select-none align-baseline max-w-[220px]';
  const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  icon.setAttribute('viewBox', '0 0 24 24');
  icon.setAttribute('fill', 'none');
  icon.setAttribute('stroke', 'currentColor');
  icon.setAttribute('stroke-width', '2');
  icon.setAttribute('class', 'w-3 h-3 shrink-0');
  icon.innerHTML = '<path stroke-linecap="round" stroke-linejoin="round" d="M13.19 8.688a4.5 4.5 0 011.242 7.244l-4.5 4.5a4.5 4.5 0 01-6.364-6.364l1.757-1.757m13.35-.622l1.757-1.757a4.5 4.5 0 00-6.364-6.364l-4.5 4.5a4.5 4.5 0 001.242 7.244"/>';
  const label = document.createElement('span');
  label.className = 'truncate';
  label.textContent = decoded?.l || 'Ссылка';
  chip.appendChild(icon);
  chip.appendChild(label);
  return chip;
}

// DOM → текст с токенами
function serialize(el: HTMLElement): string {
  let out = '';
  const walk = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) { out += node.textContent || ''; return; }
    if (!(node instanceof HTMLElement)) return;
    if (node.dataset.token) { out += node.dataset.token; return; }
    if (node.tagName === 'BR') { out += '\n'; return; }
    // div/p — блочная строка (браузер создаёт их при Enter)
    const isBlock = node.tagName === 'DIV' || node.tagName === 'P';
    if (isBlock && out && !out.endsWith('\n')) out += '\n';
    node.childNodes.forEach(walk);
  };
  el.childNodes.forEach(walk);
  return out;
}

// Слово перед курсором (до пробела/переноса/чипа)
function caretWord(root: HTMLElement): string | null {
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount || !sel.isCollapsed) return null;
  const range = sel.getRangeAt(0);
  if (!root.contains(range.startContainer)) return null;
  if (range.startContainer.nodeType !== Node.TEXT_NODE) return null;
  const text = (range.startContainer.textContent || '').slice(0, range.startOffset);
  const m = text.match(/(\S+)$/);
  return m ? m[1] : null;
}

const RichChatInput = forwardRef<RichChatInputHandle, Props>(function RichChatInput(
  { value, onChange, onCaretWord, onKeyDown, onSend, placeholder }, ref
) {
  const rootRef = useRef<HTMLDivElement>(null);
  const lastEmitted = useRef<string>('');

  // Внешнее значение изменилось (вставка ссылки, черновик, очистка после
  // отправки) — перерисовываем DOM. Собственный ввод не перерисовываем,
  // чтобы не терять курсор.
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    if (value === lastEmitted.current) return;
    const wasFocused = document.activeElement === el;
    renderValue(el, value);
    lastEmitted.current = value;
    // Перерисовка innerHTML сбрасывает фокус (текущий узел удалён). Если поле
    // было активно — возвращаем фокус и курсор в конец, иначе после вставки
    // ссылки/эмодзи пользователь не может продолжить печатать.
    if (wasFocused) {
      el.focus();
      const sel = window.getSelection();
      if (sel) {
        const r = document.createRange();
        r.selectNodeContents(el);
        r.collapse(false);
        sel.removeAllRanges();
        sel.addRange(r);
      }
    }
  }, [value]);

  const emit = () => {
    const el = rootRef.current;
    if (!el) return;
    const text = serialize(el);
    lastEmitted.current = text;
    onChange(text);
    onCaretWord?.(caretWord(el));
  };

  const insertNodeAtCaret = (node: Node) => {
    const el = rootRef.current;
    if (!el) return;
    el.focus();
    const sel = window.getSelection();
    let range: Range;
    if (sel && sel.rangeCount && el.contains(sel.getRangeAt(0).startContainer)) {
      range = sel.getRangeAt(0);
      range.deleteContents();
    } else {
      range = document.createRange();
      range.selectNodeContents(el);
      range.collapse(false);
    }
    range.insertNode(node);
    range.setStartAfter(node);
    range.collapse(true);
    sel?.removeAllRanges();
    sel?.addRange(range);
    emit();
  };

  useImperativeHandle(ref, () => ({
    focus: () => rootRef.current?.focus(),
    insertText: (text: string) => {
      // токены вставляем чипами, обычный текст — текстом
      if (new RegExp(`^${SHARE_TOKEN_RE.source}$`).test(text.trim())) {
        insertNodeAtCaret(makeChip(text.trim()));
      } else {
        insertNodeAtCaret(document.createTextNode(text));
      }
    },
    replaceWordBeforeCaret: (replacement: string) => {
      const el = rootRef.current;
      if (!el) return;
      el.focus();
      const sel = window.getSelection();
      if (sel && sel.rangeCount && sel.isCollapsed) {
        const range = sel.getRangeAt(0);
        if (el.contains(range.startContainer) && range.startContainer.nodeType === Node.TEXT_NODE) {
          const textNode = range.startContainer as Text;
          const before = (textNode.textContent || '').slice(0, range.startOffset);
          const m = before.match(/(\S+)$/);
          if (m) {
            const start = range.startOffset - m[1].length;
            textNode.deleteData(start, m[1].length);
            textNode.insertData(start, replacement);
            const pos = start + replacement.length;
            const r = document.createRange();
            r.setStart(textNode, pos);
            r.collapse(true);
            sel.removeAllRanges();
            sel.addRange(r);
            emit();
            return;
          }
        }
      }
      insertNodeAtCaret(document.createTextNode(replacement));
    },
  }), []);

  // Клик в любом месте поля (пустая область, отступы, подсказка) — фокус в
  // редактируемую зону. Без этого клик мимо текстового узла иногда не
  // активировал поле, и напечатать было нельзя.
  const focusEditor = (e: React.MouseEvent) => {
    const el = rootRef.current;
    if (!el) return;
    if (e.target === el || el.contains(e.target as Node)) return; // клик по самому редактору — стандартное поведение
    e.preventDefault();
    el.focus();
    const sel = window.getSelection();
    if (sel) {
      const r = document.createRange();
      r.selectNodeContents(el);
      r.collapse(false);
      sel.removeAllRanges();
      sel.addRange(r);
    }
  };

  return (
    <div className="relative flex-1 min-w-0" onMouseDown={focusEditor}>
      {!value && (
        <div className="absolute inset-0 px-3 py-2 text-xs text-slate-400 pointer-events-none select-none truncate">
          {placeholder}
        </div>
      )}
      <div
        ref={rootRef}
        contentEditable
        role="textbox"
        aria-multiline="true"
        tabIndex={0}
        data-tour="chat-input"
        suppressContentEditableWarning
        onInput={emit}
        onKeyUp={() => onCaretWord?.(rootRef.current ? caretWord(rootRef.current) : null)}
        onClick={() => onCaretWord?.(rootRef.current ? caretWord(rootRef.current) : null)}
        onKeyDown={(e) => {
          onKeyDown?.(e);
          if (e.defaultPrevented) return;
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            onSend?.();
          }
          // Shift+Enter — стандартный перенос строки средствами contenteditable
        }}
        onPaste={(e) => {
          // Вставляем только обычный текст — без чужого HTML-форматирования
          e.preventDefault();
          const text = e.clipboardData.getData('text/plain');
          if (!text) return;
          document.execCommand('insertText', false, text);
          emit();
        }}
        className="w-full min-h-[36px] max-h-32 overflow-y-auto whitespace-pre-wrap break-words text-xs px-3 py-2 bg-slate-50 hover:bg-slate-100/50 dark:bg-slate-950 dark:hover:bg-slate-900 border border-slate-200 dark:border-slate-850 rounded-lg text-slate-800 dark:text-slate-100 focus:outline-hidden focus:ring-1 focus:ring-emerald-500 focus:bg-white dark:focus:bg-slate-950 transition-ui font-sans font-medium cursor-text"
      />
    </div>
  );
});

export default RichChatInput;
