import React from 'react';
import { Tag as TagIcon, FileText, Table2, ExternalLink } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import type { MailMentions as Found } from '../../services/mailService';
import { openInProject } from '../../lib/projectScope';
import { officePathForKind } from '../../lib/fileTypes';
import { useStore } from '../../store/store';

/**
 * Полоса «в письме упомянуто» под самим письмом.
 *
 * Ради чего. Подрядчик пишет: «просьба подтвердить 20-PT-001 и 20-PT-004,
 * смета в Смета_вентиляция.xlsx». Всё это в Flux уже есть, но раньше человек
 * читал письмо, копировал обозначение, открывал Теги и вставлял в поиск —
 * и так по каждому. Теперь программа узнаёт свои названия в чужом тексте и
 * ставит их сюда одной строкой: нажал — открылось.
 *
 * Почему полоса, а не ссылки прямо в тексте письма. Письмо показывается в
 * песочнице без сценариев и без доступа к нашим данным — это единственное,
 * что защищает программу от чужой разметки, и открывать её ради удобства
 * нельзя. Внутри письма находки только подсвечиваются (см. highlightMentions
 * в src/lib/mailHtml.ts), чтобы было видно, о чём речь, а нажимаются здесь.
 * Заодно вышло удобнее исходной задумки: все упоминания собраны вместе, и по
 * длинному письму не приходится за ними охотиться.
 *
 * Проект. Почта общая, и тег в письме вполне может оказаться из другого
 * проекта — тогда рядом стоит его название, а открытие идёт через общий
 * вопрос «переключиться и открыть?».
 */

interface Props {
  found: Found | null;
  loading: boolean;
}

/** Одна находка: значок, надпись, при нужде — название чужого проекта. */
function Chip({ icon: Icon, label, project, title, onClick }: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  project: string;
  title: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className="group inline-flex items-center gap-1.5 max-w-full min-w-0 pl-2 pr-2.5 py-1 rounded-lg cursor-pointer
                 border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900
                 hover:border-emerald-400 dark:hover:border-emerald-700
                 hover:bg-emerald-50 dark:hover:bg-emerald-950/40 transition-ui"
    >
      <Icon className="w-3.5 h-3.5 shrink-0 text-emerald-600 dark:text-emerald-400" />
      <span className="text-2xs font-semibold text-slate-800 dark:text-slate-100 truncate">{label}</span>
      {project && (
        <span className="text-2xs text-slate-500 dark:text-slate-400 truncate max-w-[110px]">· {project}</span>
      )}
      <ExternalLink className="w-3 h-3 shrink-0 text-slate-300 dark:text-slate-600 group-hover:text-emerald-500" />
    </button>
  );
}

export default function MailMentions({ found, loading }: Props) {
  const navigate = useNavigate();
  const activeId = useStore((st: any) => st.activeProject?.id || null);

  // Название проекта пишем только у чужого. Своё повторять незачем: подпись
  // «проект такой-то» у каждой находки в своём же проекте — это четыре
  // одинаковых хвоста подряд, которые заодно съедают место у названия.
  const foreignName = (projectId: string | null, projectName: string) =>
    (projectId && projectId !== activeId ? projectName : '');

  if (loading) {
    return (
      <div className="border-t border-slate-100 dark:border-slate-850 px-3 py-2">
        <span className="text-2xs text-slate-400 dark:text-slate-500">Ищем в письме знакомое…</span>
      </div>
    );
  }

  const total = (found?.tags.length || 0) + (found?.files.length || 0) + (found?.docs.length || 0);
  if (!found || total === 0) return null;

  return (
    <div className="border-t border-slate-100 dark:border-slate-850 p-3">
      <p className="text-2xs font-semibold uppercase tracking-wider text-slate-400 dark:text-slate-500 mb-2">
        В письме упомянуто: {total}
      </p>
      <div className="flex flex-wrap gap-1.5">
        {found.tags.map((t) => (
          <Chip
            key={`tag-${t.id}`}
            icon={TagIcon}
            label={t.identifier}
            project={foreignName(t.projectId, t.projectName)}
            title={`Тег ${t.identifier}${t.projectName ? ` — проект «${t.projectName}»` : ''}. Открыть в разделе «Теги».`}
            onClick={() => openInProject({
              what: `Тег ${t.identifier}`,
              projectId: t.projectId,
              open: () => navigate(`/registry?tag=${encodeURIComponent(t.identifier)}`),
            })}
          />
        ))}

        {found.files.map((f) => (
          <Chip
            key={`file-${f.id}`}
            icon={FileText}
            label={f.name}
            project={foreignName(f.projectId, f.projectName)}
            title={`Документ «${f.name}»${f.projectName ? ` — проект «${f.projectName}»` : ''}. Открыть в Проводнике.`}
            onClick={() => openInProject({
              what: `Документ «${f.name}»`,
              projectId: f.projectId,
              open: () => navigate(`/explorer?file=${encodeURIComponent(f.id)}`),
            })}
          />
        ))}

        {found.docs.map((d) => (
          <Chip
            key={`doc-${d.id}`}
            icon={Table2}
            label={d.name}
            project={foreignName(d.projectId, d.projectName)}
            title={`Документ Flux Office «${d.name}»${d.projectName ? ` — проект «${d.projectName}»` : ''}.`}
            onClick={() => openInProject({
              what: `Книга «${d.name}»`,
              projectId: d.projectId,
              open: () => navigate(`${officePathForKind(d.kind)}?doc=${encodeURIComponent(d.id)}`),
            })}
          />
        ))}
      </div>
    </div>
  );
}
