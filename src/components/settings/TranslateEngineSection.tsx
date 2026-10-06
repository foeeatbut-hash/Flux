/**
 * Настройки переводчика: словарный пакет и слот под свой движок.
 *
 * Программа переводит своим: памятью проекта, словарём и узорами писем — и в
 * этом состоянии она полноценна. Движок нужен для свободного текста, которого
 * в словаре нет и быть не может; поставить его владелец может сам — у себя на
 * машине или в своей сети.
 *
 * Чужой адрес не принимается. Это не осторожность и не настройка: программа
 * работает в закрытом контуре, и «почти офлайн» тут не бывает. Поле сразу
 * говорит, что не так, — а не молчит до первой отправки письма наружу.
 *
 * Здесь только настройки. Счётчики словаря и пояснения про источники были
 * отсюда убраны: настройка должна отвечать «что включить», а не рассказывать о
 * программе. Но указание авторства — условие лицензии CC BY-SA 4.0 у
 * OpenRussian, поэтому ссылка на public/dict/SOURCES.md остаётся: файл лежит
 * рядом с пакетом и попадает в сборку вместе с ним (папка public целиком
 * копируется в dist, а dist входит в build.files).
 */
import React from 'react';
import { TriangleAlert, Loader2 } from 'lucide-react';
import { useTranslateStore } from '../../store/translateStore';
import { useToastStore } from '../../store/toastStore';
import { checkEndpoint, endpointUrl } from '../../translate/model';
import { Btn, Field, Input, SettingRow, Switch } from '../ui';

export default function TranslateEngineSection() {
  const model = useTranslateStore((s) => s.model);
  const setModel = useTranslateStore((s) => s.setModel);
  const { addToast } = useToastStore();
  const packOn = useTranslateStore((s) => s.packOn);
  const setPackOn = useTranslateStore((s) => s.setPackOn);
  const [probing, setProbing] = React.useState(false);

  const check = checkEndpoint(model.url);

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
    <div className="max-w-2xl">
      <div className="fx-set-group">
        <SettingRow title="Словарный пакет"
          desc="Общая лексика из открытых источников для прозы писем; словарь проекта и инженерный словарь всегда важнее.">
          <Switch label="Словарный пакет" checked={packOn} onChange={setPackOn} />
        </SettingRow>
        {/* Относительный адрес, как у лицензии GenOffice: файл едет в сборке
            рядом с пакетом, и ссылка работает и из браузера, и из Electron */}
        <div className="fx-hint pt-2">
          <a className="underline" href="dict/SOURCES.md" target="_blank" rel="noreferrer">Источники словаря и лицензии</a>
        </div>
      </div>

      <div className="fx-set-group space-y-3">
        <h3 className="fx-group-title">Свой движок перевода</h3>
        <p className="fx-hint">
          Сервер перевода на этой машине или в своей сети: 127.0.0.1, localhost или частная сеть предприятия.
        </p>

        <Field label="Адрес">
          <Input value={model.url} onChange={(e) => setModel({ url: e.target.value })}
            placeholder="http://127.0.0.1:5000" aria-invalid={!!model.url && !check.ok} />
        </Field>
        {model.url && !check.ok && (
          <div className="flex items-start gap-2 text-2xs text-rose-600 dark:text-rose-400">
            <TriangleAlert className="w-3.5 h-3.5 mt-0.5 shrink-0" />
            <span>{check.reason}</span>
          </div>
        )}

        <Field label="Ключ, если сервер его спрашивает">
          <Input value={model.key} onChange={(e) => setModel({ key: e.target.value })} type="password" />
        </Field>

        <div className="flex items-center gap-2 pt-1">
          <Btn tone={model.enabled ? 'primary' : 'plain'} onClick={() => setModel({ enabled: !model.enabled })} disabled={!check.ok}>
            {model.enabled ? 'Движок включён' : 'Включить движок'}
          </Btn>
          <Btn tone="ghost" onClick={probe} disabled={!check.ok || probing}>
            {probing && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
            Проверить связь
          </Btn>
        </div>
      </div>
    </div>
  );
}
