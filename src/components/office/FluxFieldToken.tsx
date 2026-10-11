/**
 * Защищённый токен-метка поля внутри contentEditable (ТЗ Flux Office §6).
 * Отображается как компактная метка; НЕ пересоздаётся при наборе текста рядом.
 * Удаление — только через выделение или контекстное меню, Backspace удаляет текст.
 */
import React from 'react';

export interface FluxFieldTokenProps {
  fieldKey: string;
  label: string;
  onRemove?: () => void;
}

export const FluxFieldToken = React.memo(function FluxFieldToken({ fieldKey, label, onRemove }: FluxFieldTokenProps) {
  return (
    <span
      className="inline-flex items-center gap-1 align-middle bg-emerald-100/70 border border-emerald-300/60 rounded text-emerald-800 px-1.5 py-0.5 text-[11px] font-medium max-w-full whitespace-normal select-none"
      contentEditable={false}
      data-field={fieldKey}
      data-flux-token=""
      title={label}
      style={{ lineHeight: '20px' }}
    >
      <span className="opacity-60 text-[9px] leading-none">▤</span>
      <span className="truncate">{label}</span>
      {onRemove && (
        <button
          type="button"
          contentEditable={false}
          onClick={(e) => { e.stopPropagation(); onRemove(); }}
          className="ml-0.5 text-emerald-400 hover:text-rose-500 cursor-pointer leading-none"
          style={{ fontSize: '10px' }}
          title="Убрать метку"
        >×</button>
      )}
    </span>
  );
});
