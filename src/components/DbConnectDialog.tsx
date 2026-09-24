/**
 * Подключение к базе данных — одно окно с одним вопросом: где лежат данные.
 *
 * До этого окна на экране входа стояло одно поле, а вопросов за ним было два:
 * «адрес сервера программы» и «где база». Подписаны они были почти одинаково,
 * и однажды в поле сервера вписали строку подключения к базе — программа
 * перестала работать целиком, включая экран входа, с которого это можно было
 * бы исправить.
 *
 * Отсюда устройство этого окна:
 *
 *   — вопрос ровно один, и он назван словами человека, а не программиста:
 *     «где лежат данные», а не «строка подключения»;
 *   — строку подключения человек не пишет: он отвечает на пять полей, а строку
 *     собирает программа, экранируя знаки пароля (src/lib/dbUrl.ts);
 *   — «Проверить» отвечает до того, как что-то поменяется. Переключить базу и
 *     узнать, что адрес неверный, — значит остаться без программы;
 *   — пароль в строке состояния не показывается никогда.
 */
import React from 'react';
import { Database, Laptop, Loader2, CheckCircle2, AlertCircle, X } from 'lucide-react';
import { dataService } from '../services/dataService';
import {
  buildDbUrl, parseDbUrl, missing, ENGINE_LABEL, DEFAULT_PORT, emptyParts,
  type DbParts, type DbEngine,
} from '../lib/dbUrl';

export default function DbConnectDialog({ current, currentType, onClose, onDone }: {
  /** Настроенная сейчас строка подключения (пусто — база на этом компьютере) */
  current: string;
  currentType: string;
  onClose: () => void;
  /** Подключение сменилось — окно входа перечитывает состояние */
  onDone: (label: string) => void;
}) {
  const [parts, setParts] = React.useState<DbParts>(() => (
    String(currentType).toUpperCase() === 'REMOTE' ? parseDbUrl(current) : emptyParts('LOCAL')
  ));
  const [state, setState] = React.useState<'idle' | 'checking' | 'ok' | 'fail' | 'saving'>('idle');
  const [said, setSaid] = React.useState('');

  const set = (patch: Partial<DbParts>) => {
    setParts((p) => ({ ...p, ...patch }));
    setState('idle');
    setSaid('');
  };

  const pickEngine = (engine: DbEngine) => {
    // Порт меняется вместе с движком, но введённый руками не затираем
    const wasDefault = !parts.port || Object.values(DEFAULT_PORT).includes(parts.port);
    set({ engine, port: wasDefault ? DEFAULT_PORT[engine] : parts.port });
  };

  const problem = missing(parts);
  const remote = parts.engine !== 'LOCAL';

  const check = async () => {
    if (problem) { setState('fail'); setSaid(problem); return; }
    setState('checking');
    try {
      const r = await dataService.testDbConnection({
        current_db_type: remote ? 'REMOTE' : 'LOCAL',
        database_url: buildDbUrl(parts),
      }) as any;
      setState(r?.success ? 'ok' : 'fail');
      setSaid(r?.message || (r?.success ? 'База отвечает.' : 'База не отвечает.'));
    } catch (err: any) {
      setState('fail');
      setSaid(err?.message || 'Не удалось проверить подключение.');
    }
  };

  const connect = async () => {
    if (problem) { setState('fail'); setSaid(problem); return; }
    setState('saving');
    try {
      const r = await dataService.switchDb({
        current_db_type: remote ? 'REMOTE' : 'LOCAL',
        database_url: buildDbUrl(parts),
      }) as any;
      if (r && r.success === false) {
        setState('fail');
        setSaid(r.message || 'Не удалось переключить базу.');
        return;
      }
      onDone(remote ? 'общая база' : 'база на этом компьютере');
    } catch (err: any) {
      setState('fail');
      setSaid(err?.message || 'Не удалось переключить базу.');
    }
  };

  const field = (label: string, value: string, on: (v: string) => void, extra: Record<string, unknown> = {}) => (
    <label className="block">
      <span className="fx-label block mb-1">{label}</span>
      <input
        value={value}
        onChange={(e) => on(e.target.value)}
        {...extra}
        className="fx-input"
      />
    </label>
  );

  return (
    <div className="fixed inset-0 z-[120] flex items-center justify-center fx-backdrop p-4"
      onMouseDown={onClose}>
      <div
        role="dialog"
        aria-label="Подключение к базе данных"
        onMouseDown={(e) => e.stopPropagation()}
        className="w-full max-w-lg fx-dialog overflow-hidden"
      >
        <div className="flex items-center gap-2 px-4 py-3 border-b border-slate-200 dark:border-slate-800">
          <b className="text-base font-semibold text-slate-800 dark:text-white">Где лежат данные</b>
          <span className="flex-1" />
          <button type="button" onClick={onClose} aria-label="Закрыть"
            className="fx-ibtn">
            <X />
          </button>
        </div>

        <div className="p-4 space-y-3">
          <p className="text-sm text-slate-500 dark:text-slate-400">
            Это не адрес сервера программы. Здесь — только база данных: на этом компьютере
            или общая, к которой подключены все сотрудники.
          </p>

          {/* Выбор варианта — переключатель, а не три зелёные плитки */}
          <div className="fx-segctl w-full" role="group" aria-label="Где лежат данные">
            {(['LOCAL', 'POSTGRES', 'MARIADB'] as DbEngine[]).map((e) => (
              <button key={e} type="button" onClick={() => pickEngine(e)} aria-pressed={parts.engine === e} className="flex-1 justify-center">
                {e === 'LOCAL' ? <Laptop className="w-3.5 h-3.5" /> : <Database className="w-3.5 h-3.5" />}
                {ENGINE_LABEL[e]}
              </button>
            ))}
          </div>

          {remote ? (
            <div className="space-y-2">
              <div className="grid grid-cols-[1fr_90px] gap-2">
                {field('Сервер', parts.host, (v) => set({ host: v }), { placeholder: '192.168.1.100' })}
                {field('Порт', parts.port, (v) => set({ port: v }), { inputMode: 'numeric' })}
              </div>
              {field('База данных', parts.database, (v) => set({ database: v }), { placeholder: 'flux' })}
              <div className="grid grid-cols-2 gap-2">
                {field('Пользователь', parts.user, (v) => set({ user: v }))}
                {field('Пароль', parts.password, (v) => set({ password: v }), { type: 'password' })}
              </div>
            </div>
          ) : (
            <p className="text-sm text-slate-600 dark:text-slate-300">
              Данные будут храниться файлом на этом компьютере. Так работают в одиночку:
              другие сотрудники этих данных не увидят.
            </p>
          )}

          {!!said && (
            <p className={`text-xs leading-snug flex items-start gap-1.5 ${
              state === 'ok' ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400'}`}>
              {state === 'ok' ? <CheckCircle2 className="w-3.5 h-3.5 mt-px shrink-0" />
                : <AlertCircle className="w-3.5 h-3.5 mt-px shrink-0" />}
              {said}
            </p>
          )}
        </div>

        <div className="fx-dialog-foot">
          <button type="button" onClick={check} disabled={state === 'checking' || state === 'saving'}
            className="fx-btn fx-btn-lg mr-auto">
            {state === 'checking' && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
            Проверить
          </button>
          <button type="button" onClick={onClose}
            className="fx-btn fx-btn-lg">
            Отмена
          </button>
          <button type="button" onClick={connect} disabled={state === 'saving'}
            className="fx-btn fx-btn-lg fx-btn-primary">
            {state === 'saving' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Database className="w-3.5 h-3.5" />}
            Подключиться
          </button>
        </div>
      </div>
    </div>
  );
}
