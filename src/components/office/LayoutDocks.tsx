/**
 * Две пристыкованные панели разметки: поля проекта и расхождения.
 *
 * Отдельным компонентом только ради размера экрана редактора: он стоит у
 * планки, и двадцать строк разметки там — это отказ проверки архитектуры.
 * Своей логики здесь нет, поэтому и проверять нечего.
 */

import React from 'react';
import FieldsPanel from './FieldsPanel';
import DiffPanel from './DiffPanel';
import type { LayoutDiff } from '../../lib/tableLayout';
import type { useTableLayout } from './useTableLayout';

/** Сверки ещё не было либо всё сошлось — панель скажет это словами. */
const EMPTY_DIFF: LayoutDiff = { cells: [], gone: [], added: [], safe: 0, asks: 0 };

export default function LayoutDocks({ lay }: { lay: ReturnType<typeof useTableLayout> }) {
  return (
    <>
      {/* Панель полей стоит СБОКУ, а не поверх листа: человек размечает шапку
          и должен видеть, что размечает. Мастер закрывал собой ровно то, ради
          чего его открывали */}
      {lay.fieldsOpen && (
        <FieldsPanel
          catalog={lay.catalog}
          layout={lay.layout}
          cursor={lay.cursor}
          templates={lay.templates as any}
          views={lay.views as any}
          onApplyView={lay.applyView}
          onPick={lay.pickField}
          onDrop={lay.dropField}
          onGrain={lay.setGrain}
          onRole={lay.setRole}
          onSaveTemplate={lay.saveTemplate}
          onApplyTemplate={lay.applyTemplate}
          onDeleteTemplate={lay.deleteTemplate}
          onClose={() => lay.setFieldsOpen(false)}
        />
      )}
      {/* Панель открывается и когда расхождений нет. Нажатая кнопка обязана
          что-то сделать: молчание в ответ человек читает как поломку и жмёт
          ещё раз — так было до живой проверки */}
      {lay.diffOpen && (
        <DiffPanel
          diff={lay.diff || EMPTY_DIFF}
          busy={lay.busy}
          onApplyFresh={() => void lay.applyFresh()}
          onKeepMine={lay.keepMine}
          onClose={() => lay.setDiffOpen(false)}
        />
      )}
    </>
  );
}
