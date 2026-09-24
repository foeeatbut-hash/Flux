import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ShieldCheck, EyeOff, Eye, Copy, RefreshCw, ChevronDown } from 'lucide-react';
import { useStore } from '../../store/store';
import { useInsightStore } from '../../store/insightStore';
import { useToastStore } from '../../store/toastStore';
import {
  fetchCheck, muteRule, EMPTY_CHECK, SEVERITY_STYLE,
  type CheckResult, type Severity, type UsageKind,
} from '../../lib/insight';
import { copyAsTable } from '../../lib/copyTable';
import { KindIcon, Row, Empty, Skeleton } from './parts';

/**
 * Проверка проекта: один список того, что стоит поправить.
 *
 * Замечания сгруппированы по правилу, а не свалены в кучу: так видно, что
 * «двадцать замечаний» — это одна незакрытая беда на двадцати позициях, а не
 * двадцать разных. Каждая группа объясняет, почему это важно: список без
 * объяснений читается как придирка и его перестают открывать.
 *
 * Правило можно скрыть. Это не поблажка, а способ сохранить смысл списка: если
 * в вашем процессе марка заполняется в конце, вечное замечание про марку топит
 * настоящие находки.
 */
export default function ProjectCheckView() {
  const { activeProject } = useStore();
  const { openWhere, close, setCheckCounts } = useInsightStore();
  const { addToast } = useToastStore();
  const navigate = useNavigate();
  const [data, setData] = useState<CheckResult>(EMPTY_CHECK);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState('');

  const load = () => {
    setLoading(true);
    fetchCheck(activeProject?.id).then(r => {
      setData(r);
      setCheckCounts(r.total, r.critical);
      // Развёрнуты только важные группы: если раскрыть всё, список
      // превращается в простыню и первая же беда теряется
      setOpen(Object.fromEntries(r.groups.map(g => [g.id, g.severity === 'critical'])));
      setLoading(false);
    });
  };

  useEffect(load, [activeProject?.id]);

  const go = (route: string) => { if (route) { navigate(route); close(); } };

  const toggleMute = async (ruleId: string, title: string) => {
    setBusy(ruleId);
    const ok = await muteRule(ruleId, true);
    setBusy('');
    if (!ok) { addToast('Не удалось скрыть правило', 'error'); return; }
    addToast(`Правило «${title}» скрыто. Вернуть — в настройках проверки`, 'success');
    load();
  };

  const copyAll = () => {
    const rows = data.groups.flatMap(g => g.findings.map(fi => ({
      Важность: SEVERITY_STYLE[g.severity].label,
      Правило: g.title,
      Объект: fi.title,
      Пояснение: fi.subtitle,
    })));
    if (!rows.length) { addToast('Копировать нечего — замечаний нет', 'info'); return; }
    copyAsTable(rows).then(ok => addToast(
      ok ? `Скопировано строк: ${rows.length} — вставьте в Ворд или Эксель` : 'Не удалось скопировать',
      ok ? 'success' : 'error',
    ));
  };

  const counts = useMemo(() => ([
    { s: 'critical' as Severity, n: data.critical },
    { s: 'warning' as Severity, n: data.warning },
    { s: 'info' as Severity, n: data.info },
  ]).filter(x => x.n > 0), [data]);

  if (loading) return <Skeleton rows={7} />;

  if (data.total === 0) {
    return (
      <Empty
        icon={<ShieldCheck className="w-5 h-5" />}
        title="Замечаний нет"
        hint="Программа проверила теги, оборудование, закупку и реестр ВДР и не нашла, к чему придраться. Можно выпускать."
      />
    );
  }

  return (
    <div className="pb-4">
      {/* Сводка: сколько и насколько важно */}
      <div className="flex items-center gap-2 px-3 py-2.5 flex-wrap">
        {counts.map(({ s, n }) => (
          <span key={s} className={`flex items-center gap-1.5 px-2 py-1 rounded-lg text-xs font-semibold ${SEVERITY_STYLE[s].bg} ${SEVERITY_STYLE[s].text}`}>
            <span className={`w-1.5 h-1.5 rounded-full ${SEVERITY_STYLE[s].dot}`} />
            {SEVERITY_STYLE[s].label}: <span className="tabular-nums">{n}</span>
          </span>
        ))}
        <div className="flex-1" />
        <button type="button" onClick={copyAll} title="Скопировать список для письма или совещания"
          className="p-1.5 rounded-lg text-slate-400 hover:text-slate-700 dark:hover:text-white hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer">
          <Copy className="w-3.5 h-3.5" />
        </button>
        <button type="button" onClick={load} title="Проверить заново"
          className="p-1.5 rounded-lg text-slate-400 hover:text-slate-700 dark:hover:text-white hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer">
          <RefreshCw className="w-3.5 h-3.5" />
        </button>
      </div>

      {data.groups.map(g => {
        const st = SEVERITY_STYLE[g.severity];
        const isOpen = open[g.id];
        return (
          <section key={g.id} className="mx-2 mb-2 rounded-xl border border-slate-200 dark:border-slate-800 overflow-hidden">
            <button
              type="button"
              onClick={() => setOpen(o => ({ ...o, [g.id]: !o[g.id] }))}
              className="w-full flex items-start gap-2.5 px-3 py-2.5 text-left hover:bg-slate-50 dark:hover:bg-slate-850 cursor-pointer"
            >
              <span className={`mt-1.5 w-2 h-2 rounded-full shrink-0 ${st.dot}`} />
              <span className="flex-1 min-w-0">
                <span className="flex items-center gap-2">
                  <span className="text-sm font-semibold text-slate-800 dark:text-slate-150">{g.title}</span>
                  <span className={`px-1.5 py-0.5 rounded-md text-2xs font-semibold tabular-nums ${st.bg} ${st.text}`}>{g.count}</span>
                </span>
                <span className="block mt-0.5 text-2xs text-slate-500 dark:text-slate-400 leading-snug">{g.why}</span>
              </span>
              <ChevronDown className={`w-4 h-4 text-slate-400 shrink-0 transition-transform ${isOpen ? 'rotate-180' : ''}`} />
            </button>

            {isOpen && (
              <div className="border-t border-slate-100 dark:border-slate-850 px-1 py-1">
                {g.findings.slice(0, 200).map(fi => (
                  <Row
                    key={fi.id}
                    icon={<KindIcon kind={fi.route.startsWith('/equipment') ? 'element' : fi.route.startsWith('/management') ? 'vdr' : 'tag'} />}
                    title={fi.title}
                    subtitle={fi.subtitle}
                    onClick={() => go(fi.route)}
                    onSide={fi.route.startsWith('/equipment?element=')
                      ? () => openWhere('element' as UsageKind, fi.id, true)
                      : fi.route.startsWith('/registry?focus=')
                        ? () => openWhere('tag' as UsageKind, fi.id, true)
                        : fi.route.startsWith('/management?vdr=')
                          ? () => openWhere('vdr' as UsageKind, fi.id, true) : undefined}
                  />
                ))}
                {g.findings.length > 200 && (
                  <p className="px-3 py-2 text-2xs text-slate-400">…и ещё {g.findings.length - 200}. Скопируйте список целиком кнопкой сверху.</p>
                )}
                <button
                  type="button"
                  disabled={busy === g.id}
                  onClick={() => toggleMute(g.id, g.title)}
                  className="mx-2 my-1.5 flex items-center gap-1.5 px-2 py-1 rounded-lg text-2xs font-semibold
                             text-slate-400 hover:text-slate-700 dark:hover:text-slate-150
                             hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer disabled:opacity-50"
                >
                  <EyeOff className="w-3 h-3" /> Не проверять это в нашем проекте
                </button>
              </div>
            )}
          </section>
        );
      })}

      {data.hidden.length > 0 && (
        <div className="mx-2 mt-3 p-3 rounded-xl bg-slate-50 dark:bg-slate-850 border border-slate-200 dark:border-slate-800">
          <p className="text-xs font-medium text-slate-400 dark:text-slate-500">Скрытые правила</p>
          <p className="mt-0.5 text-2xs text-slate-400 dark:text-slate-500 leading-snug">
            Их не показываем в списке, но продолжаем считать — чтобы было видно, от чего вы отказались.
          </p>
          <div className="mt-2 space-y-1">
            {data.hidden.map(h => (
              <div key={h.id} className="flex items-center gap-2">
                <span className="flex-1 min-w-0 text-xs text-slate-600 dark:text-slate-300 truncate">
                  {h.title} <span className="text-slate-400 tabular-nums">· {h.count}</span>
                </span>
                <button
                  type="button"
                  disabled={busy === h.id}
                  onClick={async () => {
                    setBusy(h.id);
                    const ok = await muteRule(h.id, false);
                    setBusy('');
                    if (ok) load(); else addToast('Не удалось вернуть правило', 'error');
                  }}
                  className="shrink-0 flex items-center gap-1 px-2 py-1 rounded-lg text-2xs font-semibold
                             text-emerald-700 dark:text-emerald-400 hover:bg-emerald-50 dark:hover:bg-emerald-950/30
                             cursor-pointer disabled:opacity-50"
                >
                  <Eye className="w-3 h-3" /> Вернуть
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
