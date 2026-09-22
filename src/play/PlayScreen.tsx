/**
 * Flux Play — рама раздела.
 *
 * Рама отделена от содержимого вкладок сознательно: у каждой вкладки свои
 * запросы и своё состояние, и один файл на всё это вырос бы до размеров, при
 * которых правку делают вслепую.
 *
 * Три вещи, заданные здесь и не обсуждаемые дальше:
 *
 *   1. **Ничто из платформы не накрывает оболочку.** Панель группы, меню и
 *      подсказки живут внутри тела окна: панель задач и часы должны остаться
 *      видимыми в любом состоянии матча. Это то же правило, по которому
 *      переделывали панель проекта и правую колонку.
 *   2. **Узкое окно ничего не теряет.** Ниже 720 точек вкладки схлопываются в
 *      один выбор, но ни одно действие не пропадает: окно программы сжимается
 *      до 420×260, и раздел обязан это пережить, а не «поддерживать
 *      разрешение от 900×600» на словах.
 *   3. **Показанное — подтверждённое.** Ожидание показывается ожиданием, а
 *      устаревшее помечается устаревшим. Ничего не дорисовывается «наперёд».
 */
import React from 'react';
import { Gamepad2, Library, Swords } from 'lucide-react';
import { useAppContext } from '../store/policyStore';
import { useStore } from '../store/store';
import { visibleGames } from '../lib/appPolicy';
import { isStale, usePlayStore } from '../store/playStore';
import { usePlayPendingStore } from '../store/playPendingStore';
import { dataService } from '../services/dataService';
import * as api from '../services/playService';
import type { PlayActivity, PlayStatus } from '../../play/contracts';
import { mainAction, type InstallState } from './mainAction';
import { useLive } from './useLive';
import PartyBar, { type Person } from './PartyBar';
import PrepareTab from './PrepareTab';
import LibraryTab from './LibraryTab';
import InvitePicker, { type Candidate } from './InvitePicker';
import { Failure, Reconnecting, Stale, Waiting } from './states';

type TabId = 'prepare' | 'library';

const TABS: Array<{ id: TabId; title: string; icon: React.ComponentType<{ className?: string }> }> = [
  { id: 'prepare', title: 'Подготовка', icon: Swords },
  { id: 'library', title: 'Библиотека', icon: Library },
];

export default function PlayScreen() {
  const ctx = useAppContext();
  const meId = String(useStore((s) => s.user?.id) || '');
  const games = React.useMemo(() => visibleGames(ctx), [ctx]);

  const [tab, setTab] = React.useState<TabId>('prepare');
  const [picking, setPicking] = React.useState(false);
  const [people, setPeople] = React.useState<Candidate[]>([]);
  const [names, setNames] = React.useState<Record<string, string>>({});
  const [now, setNow] = React.useState(() => Date.now());

  const st = usePlayStore();
  const pending = usePlayPendingStore();
  useLive(true);

  // Состояние загружается и при обычном открытии, а не только по сокету:
  // связь могла не подняться, а раздел уже открыт
  React.useEffect(() => { void st.refresh(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Имена сотрудников: в лобби и в группе должны стоять люди, а не
  // идентификаторы. Список общий с остальной программой
  React.useEffect(() => {
    dataService.getUsers().then((list: any[]) => {
      const map: Record<string, string> = {};
      const all: Candidate[] = [];
      for (const u of list) {
        map[u.id] = u.name || u.login || 'Сотрудник';
        all.push({ id: u.id, name: map[u.id], symbol: String(u.symbol || '') });
      }
      setNames(map);
      setPeople(all.filter((p) => p.id !== meId));
    }).catch(() => { /* без имён раздел работает, просто читается хуже */ });
  }, [meId]);

  // Пометка «устарело» должна появляться сама, без действий человека
  React.useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 5000);
    return () => clearInterval(t);
  }, []);

  const stale = isStale(st.at, now);
  const presence = React.useMemo(() => {
    const map: Record<string, { status: PlayStatus; activity: PlayActivity }> = {};
    for (const p of st.presence || []) map[p.userId] = { status: p.status, activity: p.activity };
    return map;
  }, [st.presence]);

  const slots: Array<{ userId: string; team: number; ready: boolean }> = st.lobby?.slots || [];
  const mySlot = slots.find((s) => s.userId === meId);
  const allReady = slots.length > 0 && slots.every((s) => s.ready);

  /**
   * Состояние игры на этой машине.
   *
   * Локального менеджера игр ещё нет, и придумывать за него нельзя. Пока он не
   * появился, проверочная игра считается установленной (она идёт вместе с
   * программой), а всё остальное — неопубликованным: кнопка честно скажет, что
   * ставить нечего, вместо того чтобы обещать установку.
   */
  const gameId = String(st.lobby?.gameId || st.party?.gameId || games[0]?.id || '');
  const install: InstallState = gameId === 'testgame' ? 'ready' : 'unavailable';

  const action = mainAction({
    link: st.link,
    maintenance: !!ctx.platform.maintenance,
    install,
    session: st.session ? { state: String(st.session.state) } : null,
    lobby: st.lobby ? { state: String(st.lobby.state) } : null,
    party: st.party ? { leaderId: String(st.party.leaderId) } : null,
    meId,
    iAmReady: !!mySlot?.ready,
    allReady,
    stale,
  });

  const busyOf = (name: string) => pending.of(name).phase === 'sending';
  const failOf = (name: string) => (pending.of(name).phase === 'failed' ? pending.of(name).message : '');

  /** Нажали главную кнопку. Что именно делать, решает то же правило. */
  const runMain = async () => {
    const lobbyId = String(st.lobby?.id || '');
    const version = Number(st.lobby?.revision || 0);
    switch (action.id) {
      case 'reconnect':
        await st.refresh();
        return;
      case 'return': {
        await pending.run('session.rejoin', () => api.rejoinSession());
        await st.refresh();
        return;
      }
      case 'prepare':
        await pending.run('lobby.open', (key) => api.openLobby(gameId, key));
        await st.refresh();
        return;
      case 'ready':
      case 'unready':
        await pending.run('lobby.ready', (key) => api.setReady(lobbyId, action.id === 'ready', version, key));
        await st.refresh();
        return;
      case 'start':
        await pending.run('session.start', (key) => api.startSession(lobbyId, version, key));
        await st.refresh();
        return;
      default:
        // Установка, обновление и восстановление придут с локальным
        // менеджером игр. Пока его нет, кнопка в этих состояниях выключена
        return;
    }
  };

  const mainBusy = busyOf('lobby.open') || busyOf('lobby.ready') || busyOf('session.start') || busyOf('session.rejoin');
  const mainFailure = failOf('lobby.open') || failOf('lobby.ready') || failOf('session.start') || failOf('session.rejoin');

  const members: Person[] = (st.party?.members || []).map((m: any) => ({
    userId: m.userId,
    name: names[m.userId] || 'Сотрудник',
    role: m.role,
  }));

  return (
    <div className="h-full flex flex-col bg-slate-50 dark:bg-slate-950 select-none">
      <header className="shrink-0 flex items-center gap-2 px-3 py-2 border-b border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900">
        <Gamepad2 className="w-4 h-4 shrink-0 text-emerald-600 dark:text-emerald-400" />
        <span className="shrink-0 text-sm font-bold text-slate-800 dark:text-white">Flux Play</span>

        {/* Широкое окно: вкладки полосой */}
        <nav className="hidden @[720px]:flex items-center gap-1 ml-3" aria-label="Разделы платформы">
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => setTab(t.id)}
              aria-current={tab === t.id ? 'page' : undefined}
              className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-bold cursor-pointer transition-colors ${
                tab === t.id
                  ? 'bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-300'
                  : 'text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-850'
              }`}
            >
              <t.icon className="w-3.5 h-3.5" />
              {t.title}
            </button>
          ))}
        </nav>

        {/* Узкое окно: тот же выбор одной строкой — ни одна вкладка не пропала */}
        <label className="@[720px]:hidden ml-auto flex items-center gap-1.5">
          <span className="sr-only">Раздел платформы</span>
          <select
            value={tab}
            onChange={(e) => setTab(e.target.value as TabId)}
            className="px-2 py-1 rounded-lg text-xs font-bold cursor-pointer
                       bg-slate-100 dark:bg-slate-850 text-slate-700 dark:text-slate-150
                       border border-slate-200 dark:border-slate-800"
          >
            {TABS.map((t) => <option key={t.id} value={t.id}>{t.title}</option>)}
          </select>
        </label>
      </header>

      {st.link === 'reconnecting' && <Reconnecting />}
      {stale && <Stale seconds={Math.round((now - st.at) / 1000)} />}

      <div className="flex-1 min-h-0 overflow-y-auto scrollbar-thin">
        {picking ? (
          <InvitePicker
            people={people}
            busy={busyOf('invite')}
            onClose={() => setPicking(false)}
            onPick={async (userId) => {
              await pending.run(`invite:${userId}`, (key) => api.invite(userId, gameId || null, key));
              setPicking(false);
              await st.refresh();
            }}
          />
        ) : st.loading && !st.at ? (
          <Waiting />
        ) : tab === 'prepare' ? (
          <PrepareTab
            invites={st.invites}
            names={names}
            lobby={st.lobby}
            party={st.party}
            meId={meId}
            presence={presence}
            action={action}
            actionBusy={mainBusy}
            actionFailure={mainFailure}
            result={st.result}
            onAction={runMain}
            onSeeLibrary={() => setTab('library')}
            onAccept={async (id) => {
              await pending.run(`invite.accept:${id}`, (key) => api.acceptInvite(id, key));
              await st.refresh();
            }}
            onDecline={async (id) => {
              await pending.run(`invite.decline:${id}`, (key) => api.declineInvite(id, key));
              await st.refresh();
            }}
          />
        ) : (
          <LibraryTab games={games} />
        )}
      </div>

      {st.failure && <Failure text={st.failure} onRetry={() => void st.refresh()} busy={st.loading} />}

      {/* Панель группы — внутри окна, прижата к его низу. Поверх оболочки
          платформа не рисует ничего: панель задач должна остаться видимой */}
      {st.party && !picking && (
        <PartyBar
          members={members}
          leaderId={String(st.party.leaderId)}
          meId={meId}
          presence={presence}
          busy={busyOf('party.leave') || busyOf('party.kick')}
          onInvite={() => setPicking(true)}
          onKick={async (userId) => {
            await pending.run('party.kick', (key) => api.kickFromParty(userId, key));
            await st.refresh();
          }}
          onLeave={async () => {
            await pending.run('party.leave', (key) => api.leaveParty(key));
            await st.refresh();
          }}
        />
      )}
    </div>
  );
}
