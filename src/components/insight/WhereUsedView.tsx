import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Link2 } from 'lucide-react';
import { useStore } from '../../store/store';
import { useInsightStore } from '../../store/insightStore';
import { fetchWhereUsed, EMPTY_USAGE, type UsageKind, type UsageResult } from '../../lib/insight';
import { KindIcon, Row, GroupHead, Empty, Skeleton } from './parts';

/**
 * «Где используется»: все места, где встречается объект.
 *
 * Главный вопрос, ради которого это делалось: «я меняю здесь — где вылезет».
 * Поэтому связи не сворачиваются в число, а показываются списком с переходом:
 * счётчик «в 7 документах» заставляет искать эти семь руками.
 */
export default function WhereUsedView({ kind, id }: { kind: UsageKind; id: string }) {
  const { activeProject } = useStore();
  const { openWhere, close } = useInsightStore();
  const navigate = useNavigate();
  const [data, setData] = useState<UsageResult>(EMPTY_USAGE);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    fetchWhereUsed(kind, id, activeProject?.id).then(r => {
      if (alive) { setData(r); setLoading(false); }
    });
    return () => { alive = false; };
  }, [kind, id, activeProject?.id]);

  const go = (route: string) => {
    if (!route) return;
    navigate(route);
    close();
  };

  if (loading) return <Skeleton rows={6} />;

  if (!data.found) {
    return (
      <Empty
        icon={<Link2 className="w-5 h-5" />}
        title="Объект не найден"
        hint="Возможно, его удалили или он относится к другому проекту."
      />
    );
  }

  if (data.total === 0) {
    return (
      <Empty
        icon={<Link2 className="w-5 h-5" />}
        title="Пока нигде не используется"
        hint={`«${data.title}» не встречается ни в оборудовании, ни в документах, ни в файлах проекта. Такой объект можно переименовать или удалить, ничего не сломав.`}
      />
    );
  }

  // Пустые разделы не показываем: «Письма 0» ничего не говорит, а место
  // занимает — и за ним теряется то, где связи есть
  const groups = data.groups.filter(g => g.links.length > 0);

  return (
    <div className="pb-4">
      {/* Сводка: что это за вещь и сколько у неё связей. Без неё карточка
          начиналась сразу со списков, и на вопрос «а вообще есть что-нибудь»
          приходилось отвечать пролистыванием */}
      <div className="px-3 py-2.5 border-b border-slate-200 dark:border-slate-800">
        <div className="text-sm font-semibold text-slate-800 dark:text-slate-100 break-words">{data.title}</div>
        {data.subtitle && (
          <div className="text-2xs text-slate-500 dark:text-slate-400 mt-0.5 break-words">{data.subtitle}</div>
        )}
        <div className="mt-2 flex flex-wrap gap-1.5">
          {groups.map(g => (
            <span key={g.id}
              className="px-2 py-0.5 rounded-full text-2xs font-semibold tabular-nums
                         bg-slate-100 dark:bg-slate-850 text-slate-600 dark:text-slate-300">
              {g.title}: {g.links.length}
            </span>
          ))}
        </div>
      </div>

      {groups.map(g => (
        <section key={g.id}>
          <GroupHead title={g.title} hint={g.hint} count={g.links.length} />
          <div className="px-1">
            {g.links.map(l => (
              <Row
                key={`${l.kind}-${l.id}`}
                icon={<KindIcon kind={l.kind} />}
                title={l.title}
                subtitle={l.subtitle}
                badge={l.badge}
                onClick={l.route ? () => go(l.route) : undefined}
                // У тега, элемента и документа связи есть свои — из панели
                // можно уйти вглубь, не возвращаясь к списку
                onSide={['tag', 'element', 'doc', 'file', 'vdr'].includes(l.kind)
                  ? () => openWhere(l.kind as UsageKind, l.id, true) : undefined}
                sideTitle="Связи этого объекта"
              />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
