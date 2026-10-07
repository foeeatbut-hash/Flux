import React from 'react';
import { e3Columns } from '../../../e3/attributes';
import type { ExportColumn, ExportOrder } from '../../lib/exportSpec';
import { e3AttributesService } from '../../services/e3AttributesService';
import { Btn, Seg } from '../ui';

/**
 * Набор «Атрибуты E3» в выгрузке оборудования: столбцы `e3:<имя>` по
 * справочнику каталога для выбранных типов (не выбрано ни одного — для всех
 * типов в охвате). Справочник читается в момент нажатия, а не при открытии
 * окна: его могли обновить в Каталоге, пока окно выгрузки стояло открытым.
 *
 * Тег в набор не входит: его даёт атрибут Device Designation. Столбцы без
 * «Да» в справочнике остаются пустыми — их заполняют в Excel.
 */
export default function ExportE3Button({ chosenClasses, scopeClasses, onApply, say }: {
  chosenClasses: string[]; scopeClasses: string[];
  onApply: (columns: ExportColumn[], order: ExportOrder) => void;
  say: (text: string, kind?: 'success' | 'error' | 'info') => void;
}) {
  const [header, setHeader] = React.useState<'name' | 'title'>('name');
  const [busy, setBusy] = React.useState(false);

  const apply = async () => {
    setBusy(true);
    try {
      const book = await e3AttributesService.load();
      if (!book.items.some((a) => !a.removed)) { say('Сначала загрузите справочник атрибутов в Каталоге', 'info'); return; }
      const columns = e3Columns(book.items, chosenClasses.length ? chosenClasses : scopeClasses, { header });
      if (!columns.length) { say('Для этих типов в справочнике атрибутов нет столбцов', 'info'); return; }
      onApply(columns, 'class-tag');
    } catch (e: any) { say(e.message, 'error'); } finally { setBusy(false); }
  };

  return (
    <div className="flex flex-col items-start gap-1 pb-2">
      <div className="flex flex-wrap items-center gap-2">
        <Btn size="sm" disabled={busy} onClick={() => void apply()} title="Заменить столбцы атрибутами E3 из справочника каталога">Атрибуты E3</Btn>
        <Seg label="Заголовок столбцов E3" value={header} onChange={setHeader} options={[{ value: 'name', label: 'имя E3' }, { value: 'title', label: 'описание' }]} />
      </div>
      <p className="text-xs text-slate-500 dark:text-slate-400">Столбцы без «Да» пустые — их заполняют в Excel.</p>
    </div>
  );
}
