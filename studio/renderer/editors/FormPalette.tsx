/**
 * Палитра компонентов формы. Каждый компонент добавляется кнопкой (с клавиатуры тоже) или
 * перетаскиванием в структуру. Под названием — «когда применять» и пример из методологии.
 */
import React from 'react';
import { PALETTE, guidanceFor } from './methodology';
import type { ComponentKind } from './formModel';

export function FormPalette({ onAdd, onDragStart, onDragEnd }: { onAdd: (kind: ComponentKind) => void; onDragStart: (kind: ComponentKind) => void; onDragEnd: () => void }) {
  return (
    <section aria-label="Палитра компонентов">
      <h3 className="ed-title">Компоненты</h3>
      <ul className="ed-palette">
        {PALETTE.map(item => {
          const guidance = guidanceFor(item);
          return (
            <li className="ed-pal" key={item.kind} data-kind={item.kind}>
              <button type="button" className="ed-pal-main" draggable aria-label={`Добавить: ${item.title}`}
                onClick={() => onAdd(item.kind)} onDragStart={event => { event.dataTransfer.setData('text/plain', item.kind); event.dataTransfer.effectAllowed = 'copy'; onDragStart(item.kind); }} onDragEnd={onDragEnd}>
                <span className="ed-pal-name">{item.title}</span>
                <span className="ed-muted">{item.summary}</span>
              </button>
              <details>
                <summary>Когда применять</summary>
                <ul>{guidance.when.map((text, i) => <li key={i}>{text}</li>)}</ul>
                <p className="ed-example"><span className="ed-strong">Пример.</span> {guidance.example}</p>
                <p className="ed-hint">{guidance.source}</p>
              </details>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
