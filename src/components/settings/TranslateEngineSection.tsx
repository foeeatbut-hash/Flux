/**
 * Слот под свой движок перевода.
 *
 * Программа переводит своим: памятью проекта, словарём и узорами писем — и в
 * этом состоянии она полноценна. Движок нужен для свободного текста, которого
 * в словаре нет и быть не может; поставить его владелец может сам — у себя на
 * машине или в своей сети.
 *
 * Чужой адрес не принимается. Это не осторожность и не настройка: программа
 * работает в закрытом контуре, и «почти офлайн» тут не бывает. Поле сразу
 * говорит, что не так, — а не молчит до первой отправки письма наружу.
 */
import React from 'react';
import { Link2, ShieldCheck, TriangleAlert, Loader2, Library } from 'lucide-react';
import { useTranslateStore } from '../../store/translateStore';
import { useToastStore } from '../../store/toastStore';
import { checkEndpoint, endpointUrl } from '../../translate/model';
import { phraseCount } from '../../translate/phrases';
import { builtinTerms } from '../../translate/engine';
import { zhWordCount } from '../../translate/zh';

export default function TranslateEngineSection() {
  const model = useTranslateStore((s) => s.model);
  const setModel = useTranslateStore((s) => s.setModel);
  const terms = useTranslateStore((s) => s.terms);
  const memory = useTranslateStore((s) => s.memory);
  const { addToast } = useToastStore();
  const packOn = useTranslateStore((s) => s.packOn);
  const packState = useTranslateStore((s) => s.packState);
  const packInfo = useTranslateStore((s) => s.packInfo);
  const setPackOn = useTranslateStore((s) => s.setPackOn);
  const [probing, setProbing] = React.useState(false);

  const check = checkEndpoint(model.url);
  const input = `w-full bg-white dark:bg-slate-900 border rounded-lg px-3 py-2 text-sm
                 text-slate-800 dark:text-slate-150 outline-none focus:border-emerald-400`;

  const probe = async () => {
    if (!check.ok) { addToast(check.reason, 'error'); return; }
    setProbing(true);
    try {
      const res = await fetch(endpointUrl(model.url), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(model.key ? { Authorization: `Bearer ${model.key}` } : {}),
        },
        body: JSON.stringify({ q: ['насос'], source: 'ru', target: 'en', format: 'text' }),
      });
      if (!res.ok) throw new Error(String(res.status));
      const data = await res.json();
      const got = Array.isArray(data?.translations) ? data.translations[0] : data?.translatedText;
      if (!got) throw new Error('ответ не разобран');
      addToast(`Движок отвечает: «насос» → «${String(got).slice(0, 40)}»`, 'success');
    } catch (err: any) {
      addToast(`Движок не ответил: ${err?.message || 'нет связи'}`, 'error');
    } finally {
      setProbing(false);
    }
  };

  return (
    <div className="max-w-2xl space-y-5">
      <div className="fx-set-group">
        <div className="flex items-center gap-2 mb-2">
          <ShieldCheck className="w-4 h-4 text-emerald-600 dark:text-emerald-400" />
          <span className="text-sm font-semibold">Программа переводит сама</span>
        </div>
        <p className="text-xs text-slate-500 dark:text-slate-400 leading-relaxed">
          Наружу не уходит ничего. Перевод собирается из памяти проекта, словаря и узоров деловых писем.
        </p>
        <div className="mt-3 grid grid-cols-2 @[640px]:grid-cols-4 gap-3">
          {[
            { label: 'терминов проекта', value: terms.length },
            { label: 'строк в памяти', value: memory.length },
            { label: 'слов во встроенном словаре', value: builtinTerms('ru', 'en').size },
            { label: 'узоров писем', value: phraseCount() },
          ].map((x) => (
            <div key={x.label} className="rounded-md bg-slate-50 dark:bg-slate-900 px-3 py-2">
              <div className="text-lg font-semibold text-slate-800 dark:text-slate-150 tabular-nums">{x.value}</div>
              <div className="text-2xs text-slate-400 dark:text-slate-500 leading-tight">{x.label}</div>
            </div>
          ))}
        </div>
        <p className="mt-3 text-2xs text-slate-400 dark:text-slate-500">
          Китайский разбирается по словарю из {zhWordCount()} слов — чтобы понять письмо. Документы на
          китайском программа не выпускает.
        </p>
      </div>

      <div className="fx-set-group space-y-3">
        <div className="flex items-center gap-2">
          <Library className="w-4 h-4 text-slate-500 dark:text-slate-400" />
          <span className="text-sm font-semibold">Словарный пакет</span>
          <span className="flex-1" />
          <button type="button" onClick={() => setPackOn(!packOn)}
            className={`px-3 py-1 rounded-lg text-xs font-semibold cursor-pointer ${packOn
              ? 'bg-emerald-600 text-white hover:bg-emerald-700'
              : 'bg-slate-100 dark:bg-slate-850 text-slate-600 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-800'}`}>
            {packOn ? 'Включён' : 'Выключен'}
          </button>
        </div>
        <p className="text-xs text-slate-500 dark:text-slate-400 leading-relaxed">
          Общая лексика из открытых источников: она нужна прозе писем, где инженерного словаря не
          хватает. Пакет младше всех — словарь проекта и инженерный словарь всегда важнее, иначе
          «расход» посреди ведомости стал бы «consumption».
        </p>

        <div className="flex items-center gap-2 text-xs">
          {packState === 'loading' && (
            <><Loader2 className="w-3.5 h-3.5 animate-spin text-slate-400" />
              <span className="text-slate-500 dark:text-slate-400">Читаем пакет…</span></>
          )}
          {packState === 'ready' && packInfo && (
            <span className="text-slate-600 dark:text-slate-300">
              В пакете пар: <b>{(packInfo.fromDict + packInfo.fromWiki).toLocaleString('ru-RU')}</b>
              {' '}— из словаря {packInfo.fromDict.toLocaleString('ru-RU')},
              из Викиданных {packInfo.fromWiki.toLocaleString('ru-RU')}
            </span>
          )}
          {packState === 'none' && (
            <span className="text-amber-700 dark:text-amber-400">
              Файла пакета нет — программа работает своим словарём
            </span>
          )}
          {packState === 'off' && (
            <span className="text-slate-500 dark:text-slate-400">
              Выключен: переводят только словарь проекта и инженерный словарь
            </span>
          )}
        </div>

        <div className="rounded-md bg-slate-50 dark:bg-slate-900 p-3">
          <p className="text-2xs font-semibold text-slate-400 dark:text-slate-500 mb-2">
            Откуда взяты слова
          </p>
          <ul className="space-y-1.5 text-2xs text-slate-500 dark:text-slate-400">
            <li>
              <b className="text-slate-700 dark:text-slate-300">Викиданные</b> — пары названий статей
              Википедии: узлы, материалы, стандарты. Лицензия CC0, общественное достояние.
            </li>
            <li>
              <b className="text-slate-700 dark:text-slate-300">OpenRussian</b> — существительные,
              глаголы и прилагательные с английскими значениями. Лицензия CC BY-SA 4.0: указание
              авторства и те же условия. Пакет лежит отдельным файлом, и лицензия данных на программу
              не распространяется.
            </li>
          </ul>
          <p className="mt-2 text-2xs text-slate-400 dark:text-slate-500">
            Пересобрать пакет: <span className="font-mono">scripts/build-dict.ts</span>; происхождение
            и адреса источников — <span className="font-mono">public/dict/SOURCES.md</span>.
          </p>
        </div>
      </div>

      <div className="fx-set-group space-y-3">
        <div className="flex items-center gap-2">
          <Link2 className="w-4 h-4 text-slate-500 dark:text-slate-400" />
          <span className="text-sm font-semibold">Свой движок перевода</span>
        </div>
        <p className="text-xs text-slate-500 dark:text-slate-400 leading-relaxed">
          Если вы подняли у себя сервер перевода — на этой машине или в своей сети, — программа будет
          спрашивать его там, где своего словаря не хватило. Адрес принимается только свой: 127.0.0.1,
          localhost или частная сеть предприятия.
        </p>

        <label className="block">
          <span className="block text-2xs font-semibold text-slate-500 dark:text-slate-400 mb-1">Адрес</span>
          <input value={model.url} onChange={(e) => setModel({ url: e.target.value })}
            placeholder="http://127.0.0.1:5000"
            className={`${input} ${model.url && !check.ok
              ? 'border-rose-300 dark:border-rose-900' : 'border-slate-200 dark:border-slate-800'}`} />
        </label>
        {model.url && !check.ok && (
          <div className="flex items-start gap-2 text-2xs text-rose-600 dark:text-rose-400">
            <TriangleAlert className="w-3.5 h-3.5 mt-0.5 shrink-0" />
            <span>{check.reason}</span>
          </div>
        )}

        <label className="block">
          <span className="block text-2xs font-semibold text-slate-500 dark:text-slate-400 mb-1">
            Ключ, если сервер его спрашивает
          </span>
          <input value={model.key} onChange={(e) => setModel({ key: e.target.value })} type="password"
            className={`${input} border-slate-200 dark:border-slate-800`} />
        </label>

        <div className="flex items-center gap-3 pt-1">
          <button type="button" onClick={() => setModel({ enabled: !model.enabled })} disabled={!check.ok}
            className={`px-3 py-1.5 rounded-lg text-xs font-semibold cursor-pointer disabled:opacity-40
                        disabled:cursor-not-allowed ${model.enabled
              ? 'bg-emerald-600 text-white hover:bg-emerald-700'
              : 'bg-slate-100 dark:bg-slate-850 text-slate-600 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-800'}`}>
            {model.enabled ? 'Движок включён' : 'Включить движок'}
          </button>
          <button type="button" onClick={probe} disabled={!check.ok || probing}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold text-slate-600
                       dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-850 cursor-pointer
                       disabled:opacity-40 disabled:cursor-not-allowed">
            {probing && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
            Проверить связь
          </button>
        </div>

        <p className="text-2xs text-slate-400 dark:text-slate-500">
          Программа шлёт запрос вида
          {' '}
          <span className="font-mono">POST /translate</span>
          {' '}
          с полями q, source, target и принимает ответ
          {' '}
          <span className="font-mono">{'{ translations: […] }'}</span>
          {' '}
          или
          {' '}
          <span className="font-mono">{'{ translatedText: … }'}</span>
          . Память и термины движок не заменяет: они точнее.
        </p>
      </div>
    </div>
  );
}
