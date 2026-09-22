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
import * as gm from '../services/gameManager';
import { gameById } from '../../play/features';
import type { PlayActivity, PlayStatus } from '../../play/contracts';
import { mainAction, type InstallState } from './mainAction';
import { useLive } from './useLive';
import PartyBar, { type Person } from './PartyBar';
import PrepareTab from './PrepareTab';
import LibraryTab from './LibraryTab';
import InvitePicker, { type Candidate } from './InvitePicker';
import MatchFrame from './runtime/MatchFrame';
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

  // Что с игрой на этой машине и что выложено на сервере. Держится отдельно от
  // состояния платформы: первое знает оболочка, второе — сервер
  const [local, setLocal] = React.useState<gm.GameStatus>({
    gameId: '', state: 'unavailable', installed: '', published: '', bytesDone: 0, bytesTotal: 0, failure: '',
  });
  const [build, setBuild] = React.useState<{ manifest: unknown; base: string; key: string } | null>(null);

  /** Игра, о которой сейчас речь: выбранная группой, лобби или первая из своих */
  const gameId = String(st.lobby?.gameId || st.party?.gameId || games[0]?.id || '');
  const game = React.useMemo(() => gameById(gameId), [gameId]);

  // Состояние загружается и при обычном открытии, а не только по сокету:
  // связь могла не подняться, а раздел уже открыт
  React.useEffect(() => { void st.refresh(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  /**
   * Снимок перечитывается сам: раз в три секунды, пока раздел на экране.
   *
   * У каждого сотрудника свой встроенный сервер на общей базе, и событие по
   * сокету уходит только тем, кто подключён к серверу, где оно случилось.
   * Приглашение коллеги с соседнего компьютера до окна не доходило вовсе —
   * пока человек сам не нажимал что-нибудь в разделе. База общая, поэтому
   * снимок из неё видит всё; в свёрнутом окне опрос реже, раз в пятнадцать.
   */
  React.useEffect(() => {
    let tick = 0;
    const t = setInterval(() => {
      tick++;
      if (document.hidden && tick % 5) return;
      void usePlayStore.getState().refresh({ quiet: true });
    }, 3000);
    return () => clearInterval(t);
  }, []);

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

  /**
   * Что выложено на сервере и что стоит на машине.
   *
   * Спрашиваем при смене игры и после каждой закачки. Чаще не надо: сборки
   * выкладывают раз в неделю, а пересчёт отпечатков установленного — работа с
   * диском, и делать её в цикле значило бы греть машину сотрудника ни за чем.
   */
  React.useEffect(() => {
    let alive = true;
    const g = gameById(gameId);
    if (!gameId || (g && !g.installable)) { setBuild(null); return () => { alive = false; }; }
    void (async () => {
      const res = await api.fetchBuild(gameId);
      const published = String((res.result as any)?.build?.version || '');
      if (!alive) return;
      setBuild(res.ok && (res.result as any)?.build
        ? {
          manifest: (res.result as any).build.manifest,
          base: String((res.result as any).build.url || ''),
          key: String((res.result as any).publisherKey || ''),
        }
        : null);
      setLocal(await gm.statusOf(gameId, published));
    })();
    return () => { alive = false; };
  }, [gameId]);

  // Ход закачки приходит от оболочки событиями: опрашивать её незачем
  React.useEffect(() => gm.onProgress((p) => {
    if (p.gameId !== gameId) return;
    setLocal((was) => ({
      ...was,
      state: p.failure ? was.state : (p.paused ? 'paused' : 'downloading'),
      bytesDone: p.bytesDone,
      bytesTotal: p.bytesTotal,
      failure: p.failure || '',
    }));
  }), [gameId]);

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
   * Состояние игры на этой машине — от того, кто видит диск.
   *
   * Игры, идущие вместе с программой (проверочная), менеджера не спрашивают:
   * ставить их не надо, и ответа «не установлена» о них не существует.
   * Остальное считает оболочка; в браузере её нет, и состояние честное —
   * «поставить отсюда нечем».
   */
  const install: InstallState = game && !game.installable ? 'ready' : local.state;

  const action = mainAction({
    link: st.link,
    maintenance: !!ctx.platform.maintenance,
    install,
    manager: gm.hasManager(),
    // Встроенной игре ставиться нечем и незачем: доска считается сервером
    builtin: game?.kind === 'builtin',
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

  /**
   * Поставить игру по описи.
   *
   * Одна дорога на «Установить», «Обновить» и «Восстановить»: во всех трёх
   * случаях делается ровно одно — скачивается и укладывается то, что описано
   * описью. Разными их делает только состояние до нажатия.
   */
  const runInstall = async () => {
    if (!build) return;
    const status = await pending.run('game.install', () => gm.install({
      gameId, manifest: build.manifest, base: build.base, publisherKey: build.key,
    }).then((r) => (r.ok
      ? { ok: true, result: r.status }
      : { ok: false, message: r.problem })));
    setLocal(status || await gm.statusOf(gameId, local.published));
  };

  /** Нажали главную кнопку. Что именно делать, решает то же правило. */
  const runMain = async () => {
    const lobbyId = String(st.lobby?.id || '');
    const version = Number(st.lobby?.revision || 0);
    switch (action.id) {
      case 'reconnect':
        await st.refresh();
        return;
      case 'return': {
        // Пропуск одноразовый: сначала берём новый, потом отдаём его игре.
        // Порядок именно такой — запустить игру без пропуска значит показать
        // человеку окно игры, которое тут же его выгонит
        const back: any = await pending.run('session.rejoin', () => api.rejoinSession());
        const ticket = String(back?.ticket || '');
        const address = String(back?.session?.serverAddr || '');
        // Встроенную игру запускать нечем: её доска уже открыта в этом же окне
        if (game?.kind !== 'builtin' && ticket && address && gm.hasManager()) {
          await gm.launch({ gameId, address, ticket, sessionId: String(st.session?.id || '') });
        }
        await st.refresh();
        return;
      }
      case 'install':
      case 'update': {
        if (!build) return;
        await runInstall();
        return;
      }
      case 'pause':
        await gm.pause(gameId);
        return;
      case 'resume':
        await gm.resume(gameId);
        return;
      case 'restore':
        // «Восстановить» — это переустановка по описи, а не «лечение» файлов на
        // месте: чинить повреждённое тем же повреждённым нечем
        await runInstall();
        return;
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
        // Остальные состояния кнопку не нажимают: она в них выключена
        return;
    }
  };

  const mainBusy = busyOf('lobby.open') || busyOf('lobby.ready') || busyOf('session.start')
    || busyOf('session.rejoin') || busyOf('game.install');
  const mainFailure = failOf('lobby.open') || failOf('lobby.ready') || failOf('session.start')
    || failOf('session.rejoin') || failOf('game.install') || local.failure;

  /**
   * Встроенная игра идёт прямо здесь.
   *
   * Условие именно такое: матч живой И игра встроенная. Внешняя открывается
   * своим окном, и подменять его доской было бы враньём про то, где играют.
   */
  const playing = String(st.session?.state || '') === 'RUNNING'
    && gameById(String((st.session as any)?.gameId || gameId || ''))?.kind === 'builtin';

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
        ) : playing ? (
          /**
           * Идёт матч встроенной игры — доска занимает всё место.
           *
           * Вкладки в этот момент не нужны: человек играет, и подсовывать ему
           * рядом с доской библиотеку значит предлагать уйти с середины партии.
           * У внешней игры так не сделано намеренно — она в своём окне, и
           * раздел остаётся разделом.
           */
          <MatchFrame
            sessionId={String(st.session?.id || '')}
            meId={meId}
            names={names}
            onLeave={() => { void st.refresh(); }}
          />
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
