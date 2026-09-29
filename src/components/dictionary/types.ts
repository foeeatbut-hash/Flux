import type { Dispatch, SetStateAction } from "react";

// Общее для хуков панелей «Справочника»: словари и их перезагрузка живут в экране
export interface DictCtx {
  dictionaries: any[];
  setDictionaries: Dispatch<SetStateAction<any[]>>;
  fetchDictionaries: () => Promise<void>;
}
