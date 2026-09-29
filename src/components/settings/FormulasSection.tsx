import { useStore } from '../../store/store';
import SectionShell from './SectionShell';
import FormulaManager from '../FormulaManager';

// ── Формулы документа ─────────────────────────────────────────────────────
// Справочник открывается тем же компонентом, что и из панели вставки в титуле:
// разошедшиеся карточки настройки означали бы, что формула, собранная в одном
// месте, ведёт себя иначе в другом.
export default function FormulasSection() {
  const activeProject = useStore((st: any) => st.activeProject);
  if (!activeProject?.id) {
    return (
      <SectionShell title="Формулы документа" desc="Именованные значения для титульного листа.">
        <div className="blank">
          <div className="blank-title">Проект не выбран</div>
          <div className="blank-text">
            Формулы принадлежат проекту: у каждого свои шифры, ревизии и подписанты.
            Выберите проект — справочник откроется.
          </div>
        </div>
      </SectionShell>
    );
  }
  return (
    <div className="h-full flex flex-col min-h-0">
      <div className="flex items-center gap-2 flex-wrap">
        <h2 className="text-xl font-semibold text-slate-900 dark:text-white">Формулы документа</h2>
        {/* Чей это набор. Без подписи люди правили формулы, будучи уверены,
            что правят их для всей программы, а правили для одного проекта. */}
        <span className="text-2xs font-semibold px-2 py-0.5 rounded-full max-w-[220px] truncate
                         bg-emerald-50 text-emerald-800 dark:bg-emerald-950/50 dark:text-emerald-300
                         border border-emerald-200 dark:border-emerald-900"
              title="Формулы свои у каждого проекта">
          проект «{activeProject.name}»
        </span>
      </div>
      <p className="text-xs text-slate-400 mt-1 mb-4">
        Что видно в титуле вместо выражения: «Дата», «Инициалы сотрудника», «Подпись»,
        «Шифр с ревизией». Настройка живёт здесь, документ показывает только название.
      </p>
      <div className="flex-1 min-h-0 sheet">
        <FormulaManager projectId={activeProject.id} />
      </div>
    </div>
  );
}
