/**
 * Запуск программы на тестовой базе: тот же протокол flux-module://, та же изоляция (<iframe sandbox>, CSP) и тот же
 * мост (modules/bridge.ts), что во Flux. Окно читает данные не из Flux, а у главного процесса — из тестовой SQLite.
 * Журнал показывает каждое сообщение моста: чтения, сообщения программы (flux.log), расчёты и сбои.
 */
import React, { useEffect, useRef, useState } from 'react';
import { createModuleBridge } from '../../../modules/bridge';
import { MODULE_SANDBOX } from '../../../modules/protocol';
import { themeKeys, type LaunchContext, type ModuleManifest, type ThemeTokens } from '../../../modules/contract';
import { call } from '../call';

interface Started {
  session: string; url: string; language: string;
  manifest: Pick<ModuleManifest, 'id' | 'name' | 'version' | 'reads' | 'entries'> & { connections: unknown[] };
  context: LaunchContext;
}
interface BaseContext { id: string; name: string; equipment: Array<{ id: string; name: string }>; tags: Array<{ id: string; name: string }> }
interface LogRow { at: string; kind: string; text: string; level: 'info' | 'warn' | 'error' }

const ENTRIES: Record<string, string> = { start: 'Пуск', equipment: 'Карточка оборудования', tag: 'Карточка тега' };

function theme(): ThemeTokens {
  const style = getComputedStyle(document.documentElement);
  return Object.fromEntries(themeKeys.map(key => [key, style.getPropertyValue(key).trim()])) as ThemeTokens;
}

export default function Run({ id }: { id: string }) {
  const [contexts, setContexts] = useState<BaseContext[]>([]);
  const [pick, setPick] = useState({ projectId: 'p1', entry: 'equipment', entityId: 'p1-e-fan' });
  const [started, setStarted] = useState<Started | null>(null);
  const [error, setError] = useState('');
  const [log, setLog] = useState<LogRow[]>([]);
  const [shots, setShots] = useState('');
  const frame = useRef<HTMLIFrameElement>(null);
  const bridge = useRef<ReturnType<typeof createModuleBridge> | null>(null);
  const latest = useRef(pick);
  latest.current = pick;

  const add = (kind: string, text: string, level: LogRow['level'] = 'info') =>
    setLog(rows => [...rows.slice(-199), { at: new Date().toLocaleTimeString('ru-RU'), kind, text, level }]);

  useEffect(() => { setStarted(null); setLog([]); setError(''); void call<{ context: BaseContext[] }>('testBase').then(b => setContexts(b.context)).catch(() => {}); }, [id]);

  // Мост живёт, пока открыт запуск; закрытие окна программы закрывает и его
  useEffect(() => {
    if (!started) return;
    const manifest = { ...started.manifest, author: '', contractVersion: 1, logic: '' } as unknown as ModuleManifest;
    const b = createModuleBridge({
      frame: () => frame.current?.contentWindow || null, session: started.session, manifest,
      context: () => ({ projectId: latest.current.projectId || null, entry: latest.current.entry as LaunchContext['entry'], entityId: latest.current.entityId || null }),
      theme,
      read: async (resource, entityId) => {
        const t = Date.now();
        try { const data = await call('runRead', { resource, entityId }); add('чтение', `${resource} — ${Date.now() - t} мс`); return data as never; }
        catch (e) { add('чтение', `${resource}: ${(e as Error).message}`, 'warn'); throw e; }
      },
      compute: started.language === 'typescript' ? undefined : async input => {
        const reply = await call<{ output?: never; code?: string }>('runCompute', { input });
        if (!reply.output) { add('расчёт', `ошибка ${reply.code}`, 'error'); throw Object.assign(new Error(reply.code), { code: reply.code }); }
        add('расчёт', started.language); return reply.output;
      },
      onComputeError: code => add('сбой', `расчёт остановлен: ${code}`, 'error'),
      onLog: (level, text) => add('flux.log', text, level),
      onFailure: kind => add('сбой', String(kind), 'error'),
    });
    bridge.current = b;
    const listener = (event: MessageEvent) => { void b.handle(event); };
    window.addEventListener('message', listener);
    return () => { window.removeEventListener('message', listener); b.dispose(); bridge.current = null; };
  }, [started]);

  const project = contexts.find(c => c.id === pick.projectId);
  const entities = pick.entry === 'equipment' ? project?.equipment : pick.entry === 'tag' ? project?.tags : [];
  const start = async () => {
    setError(''); setLog([]); setStarted(null);
    try { setStarted(await call<Started>('runStart', { id, ...pick, entityId: pick.entry === 'start' ? '' : pick.entityId })); }
    catch (e) { setError((e as Error).message); }
  };
  const shoot = async () => {
    setShots('');
    // Тема окна — класс dark на <html>, как во Flux; на время снимков переключаем его и возвращаем как было
    const root = document.documentElement, before = root.classList.contains('dark');
    try {
      for (const name of ['light', 'dark']) {
        root.classList.toggle('dark', name === 'dark'); bridge.current?.notify('changed');
        // Окно программы перерисовывается после «changed»; сигнала готовности у него нет, поэтому короткая пауза
        await new Promise(r => setTimeout(r, 500));
        const box = frame.current!.getBoundingClientRect();
        await call('runShot', { id, theme: name, rect: { x: box.x, y: box.y, width: box.width, height: box.height } });
      }
      setShots('Снимки обеих тем сохранены в проекте (store/light.png, store/dark.png).');
    } catch (e) { setError((e as Error).message); }
    finally { root.classList.toggle('dark', before); bridge.current?.notify('changed'); }
  };

  return (
    <div className="panel" aria-labelledby="run-title">
      <h3 id="run-title">Запуск на тестовой базе</h3>
      <div className="grid">
        <div className="field"><label htmlFor="run-project">Проект</label>
          <select id="run-project" value={pick.projectId} onChange={e => setPick({ ...pick, projectId: e.target.value, entityId: '' })}>
            {contexts.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select></div>
        <div className="field"><label htmlFor="run-entry">Откуда открыта</label>
          <select id="run-entry" value={pick.entry} onChange={e => setPick({ ...pick, entry: e.target.value, entityId: '' })}>
            {Object.entries(ENTRIES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></div>
        <div className="field"><label htmlFor="run-entity">Позиция или тег</label>
          <select id="run-entity" value={pick.entityId} disabled={pick.entry === 'start'} onChange={e => setPick({ ...pick, entityId: e.target.value })}>
            <option value="">—</option>{(entities || []).map(x => <option key={x.id} value={x.id}>{x.name}</option>)}</select></div>
      </div>
      {error && <p className="fx-error" role="alert">{error}</p>}
      <div className="row">
        <button className="fx-btn fx-btn-primary" onClick={start}>{started ? 'Перезапустить' : 'Запустить'}</button>
        {started && <button className="fx-btn" onClick={shoot}>Снять обе темы</button>}
      </div>
      {shots && <p className="fx-hint" role="status">{shots}</p>}
      {started && started.language === 'python' && <p className="fx-hint">Python исполняет общая среда Flux, в Studio её нет: форма откроется, расчёт — нет. Его проверит Flux при первом запуске выпуска.</p>}
      {started && (
        <iframe ref={frame} title={started.manifest.name} className="module-frame" data-testid="studio-module-frame"
          sandbox={MODULE_SANDBOX} referrerPolicy="no-referrer" src={`${started.url}#${started.session}`}
          allow="camera 'none'; microphone 'none'; geolocation 'none'; clipboard-read 'none'; clipboard-write 'none'" />
      )}
      <h4>Журнал сообщений моста</h4>
      {log.length === 0 ? <div className="empty small">Сообщений пока нет.</div> : (
        <table className="log"><thead><tr><th>Время</th><th>Вид</th><th>Сообщение</th></tr></thead>
          <tbody>{log.map((r, i) => <tr key={i} className={r.level}><td>{r.at}</td><td>{r.kind}</td><td className="code">{r.text}</td></tr>)}</tbody></table>
      )}
    </div>
  );
}
