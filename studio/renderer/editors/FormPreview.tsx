/**
 * Предпросмотр формы: настоящий рендерер формы Flux (modules/runtime/form.ts) на образце данных.
 * Тема и ширина выбираются здесь и не зависят от темы Studio: форму надо видеть в обеих темах и
 * в узком окне, где подпрограмма открывается рядом с другими окнами.
 */
import React, { useEffect, useRef, useState } from 'react';
import { renderForm } from '../../../modules/runtime/form';
import { buildPreview } from './previewModel';
import type { FormDef } from './types';

type PreviewTheme = 'light' | 'dark';
type PreviewWidth = 'wide' | 'narrow';

function Choice<T extends string>({ label, value, options, onChange }: { label: string; value: T; options: Array<[T, string]>; onChange: (value: T) => void }) {
  return (
    <div className="ed-segment" role="group" aria-label={label}>
      {options.map(([key, text]) => <button key={key} type="button" aria-pressed={value === key} onClick={() => onChange(key)}>{text}</button>)}
    </div>
  );
}

export function FormPreview({ form, data, textValid }: { form: FormDef; data: Record<string, unknown>; textValid: boolean }) {
  const root = useRef<HTMLDivElement>(null);
  const [theme, setTheme] = useState<PreviewTheme>('light');
  const [width, setWidth] = useState<PreviewWidth>('wide');
  const empty = !form.groups.length && !form.tables.length;

  useEffect(() => {
    if (!root.current) return;
    const preview = buildPreview(form, data);
    renderForm(root.current, preview.form, preview.data);
  }, [form, data]);

  return (
    <section aria-label="Предпросмотр формы">
      <div className="ed-toolbar">
        <h3 className="ed-title">Предпросмотр</h3>
        <Choice<PreviewTheme> label="Тема предпросмотра" value={theme} onChange={setTheme} options={[['light', 'Светлая'], ['dark', 'Тёмная']]} />
        <Choice<PreviewWidth> label="Ширина окна" value={width} onChange={setWidth} options={[['wide', 'Обычное'], ['narrow', 'Узкое']]} />
      </div>
      {!textValid && <p className="ed-hint">В тексте ошибка: показана последняя верная форма.</p>}
      <div className="ed-pv-frame" data-width={width}>
        <div className="ed-pv" data-pv-theme={theme} data-testid="preview">
          {empty && <div className="ed-pv-empty">Форма пуста. Добавьте группу или таблицу из палитры.</div>}
          <div ref={root} data-testid="preview-root" />
        </div>
      </div>
    </section>
  );
}
