import type { Dispatch, SetStateAction } from "react";
import type { DictRefusal } from './dictWrite';

// Общее для хуков панелей «Справочника»: словари и их перезагрузка живут в экране
export interface DictCtx {
  dictionaries: any[];
  setDictionaries: Dispatch<SetStateAction<any[]>>;
  fetchDictionaries: () => Promise<void>;
  /** Показать отказ записи: правка — над содержимым экрана, удаление и создание — окном; сбой без причины — тостом */
  showRefusal: (refusal: DictRefusal, mode: 'edit' | 'dialog', title: string) => void;
  /** Снять показанный отказ: человек начал новое действие */
  clearRefusal: () => void;
}
