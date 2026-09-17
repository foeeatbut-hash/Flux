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
import type { useTableLayout } from './useTableLayout';

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
          activeCol={null}
          templates={lay.templates as any}
          onPick={lay.pickField}
          onDrop={lay.dropField}
          onGrain={lay.setGrain}
          onSaveTemplate={lay.saveTemplate}
          onApplyTemplate={lay.applyTemplate}
          onDeleteTemplate={lay.deleteTemplate}
          onClose={() => lay.setFieldsOpen(false)}
        />
      )}
      {lay.diffOpen && lay.diff && (
        <DiffPanel
          diff={lay.diff}
          busy={lay.busy}
          onApplyFresh={() => void lay.applyFresh()}
          onKeepMine={lay.keepMine}
          onClose={() => lay.setDiffOpen(false)}
        />
      )}
    </>
  );
}
