import React from 'react';
import { History, Library, Swords } from 'lucide-react';
import { useAppContext } from '../store/policyStore';
import { useStore } from '../store/store';
import { visibleGames } from '../lib/appPolicy';
import { isStale, usePlayStore } from '../store/playStore';
import { usePlayPendingStore } from '../store/playPendingStore';
import { dataService } from '../services/dataService';
import * as api from '../services/playService';
import { gameById } from '../../play/features';
import type { PlayActivity, PlayStatus } from '../../play/contracts';
import { mainAction } from './mainAction';
import { useLive } from './useLive';
import PartyBar, { type Person } from './PartyBar';
import PrepareTab from './PrepareTab';
import LibraryTab from './LibraryTab';
import HistoryTab from './HistoryTab';
import InvitePicker, { type Candidate } from './InvitePicker';
import MatchFrame from './runtime/MatchFrame';
import { Failure, Reconnecting, Stale, Waiting } from './states';

type TabId = 'prepare' | 'library' | 'history';
const TABS = [
  { id: 'library' as TabId, title: 'Библиотека', icon: Library },
  { id: 'prepare' as TabId, title: 'Подготовка', icon: Swords },
  { id: 'history' as TabId, title: 'История', icon: History },
];

export default function PlayScreen() {
  const ctx = useAppContext(), meId = String(useStore(s => s.user?.id) || '');
  const games = React.useMemo(() => visibleGames(ctx), [ctx]);
  const st = usePlayStore(), pending = usePlayPendingStore();
  const [tab, setTab] = React.useState<TabId>('library');
  const [picking, setPicking] = React.useState(false), [pastSession, setPastSession] = React.useState('');
  const [people, setPeople] = React.useState<Candidate[]>([]), [names, setNames] = React.useState<Record<string, string>>({});
  const [now, setNow] = React.useState(Date.now());
  useLive(true);
  const selected = String(st.lobby?.gameId || st.party?.gameId || '');
  const gameId = gameById(selected) ? selected : String(games[0]?.id || '');
  const game = gameById(gameId), playing = st.session?.state === 'RUNNING' && !!gameById(st.session?.gameId);
  React.useEffect(() => { void usePlayStore.getState().refresh(); }, []);
  // База общая между серверами; socket одного процесса не доставляет чужие события.
  React.useEffect(() => {
    let count = 0;
    const timer = setInterval(() => { count++; if (!document.hidden || count % 5 === 0) void usePlayStore.getState().refresh({ quiet: true }); setNow(Date.now()); }, 3000);
    return () => clearInterval(timer);
  }, []);
  React.useEffect(() => { if (st.session?.state === 'RUNNING') { setTab('prepare'); setPastSession(''); } }, [st.session?.id, st.session?.state]);
  const inviteIds = st.invites.map(invite => invite.id).join(',');
  React.useEffect(() => { if (inviteIds) setTab('prepare'); }, [inviteIds]);
  React.useEffect(() => {
    let active = true;
    dataService.getUsers().then((list: any[]) => {
      if (!active) return;
      const map: Record<string, string> = {}, candidates: Candidate[] = [];
      for (const user of list) { map[user.id] = user.name || user.symbol || 'Сотрудник'; candidates.push({ id: user.id, name: map[user.id], symbol: String(user.symbol || '') }); }
      setNames(map); setPeople(candidates.filter(person => person.id !== meId));
    }).catch(() => {});
    return () => { active = false; };
  }, [meId]);
  const presence = React.useMemo(() => {
    const map: Record<string, { status: PlayStatus; activity: PlayActivity }> = {};
    for (const person of st.presence) map[person.userId] = { status: person.status, activity: person.activity };
    return map;
  }, [st.presence]);
  const slots = st.lobby?.slots || [], mine = slots.find((slot: any) => slot.userId === meId);
  const stale = isStale(st.at, now), spectator = st.party?.members.some((member: any) => member.userId === meId && member.role === 'SPECTATOR');
  const action = spectator
    ? { id: 'waitOthers' as const, label: 'Наблюдаете', hint: 'Стол откроется, когда игроки начнут партию', disabled: true, tone: 'quiet' as const }
    : mainAction({ link: st.link, maintenance: !!ctx.platform.maintenance, install: 'ready', builtin: true, manager: true,
      session: st.session, lobby: st.lobby, party: st.party, meId, iAmReady: !!mine?.ready,
      allReady: slots.length === (st.lobby?.seats || game?.variableSeats?.min || 2) && slots.every((slot: any) => slot.ready), stale });
  const busyOf = (id: string) => pending.of(id).phase === 'sending';
  const failureOf = (id: string) => pending.of(id).phase === 'failed' ? pending.of(id).message : '';
  const mainBusy = ['lobby.open', 'lobby.ready', 'lobby.seats', 'session.start', 'session.rejoin'].some(busyOf);
  const mainFailure = ['lobby.open', 'lobby.ready', 'lobby.seats', 'session.start', 'session.rejoin'].map(failureOf).find(Boolean) || '';
  const runMain = async () => {
    const lobbyId = String(st.lobby?.id || ''), revision = Number(st.lobby?.revision || 0);
    if (action.id === 'reconnect') { await st.refresh(); return; }
    if (action.id === 'prepare') await pending.run('lobby.open', key => api.openLobby(gameId, key), gameId);
    if (action.id === 'ready' || action.id === 'unready') await pending.run('lobby.ready', key => api.setReady(lobbyId, action.id === 'ready', revision, key), `${lobbyId}:${revision}:${action.id}`);
    if (action.id === 'start') await pending.run('session.start', key => api.startSession(lobbyId, revision, key), `${lobbyId}:${revision}`);
    if (action.id === 'return') await pending.run('session.rejoin', () => api.rejoinSession());
    await st.refresh();
  };
  const auxiliaryFailure = ['invite', 'party.leave', 'party.kick', ...st.invites.flatMap(invite => [`invite.accept:${invite.id}`, `invite.decline:${invite.id}`])].map(failureOf).find(Boolean);
  const members: Person[] = (st.party?.members || []).map((member: any) => ({ userId: member.userId, name: names[member.userId] || 'Сотрудник', role: member.role }));
  const chooseTab = (next: TabId) => { setPastSession(''); setTab(next); };
  return <div className="h-full flex flex-col bg-[var(--flux-surface)] select-none">
    <header className="fx-head shrink-0">
      <h2 className="fx-head-title">Flux Play</h2>
      <nav className="hidden @[720px]:flex fx-tabs ml-3" role="tablist" aria-label="Разделы платформы">
        {TABS.map(item => <button key={item.id} role="tab" aria-selected={tab === item.id} className="fx-tab" onClick={() => chooseTab(item.id)}><item.icon className="w-3.5 h-3.5" />{item.title}</button>)}
      </nav>
      <select className="fx-input @[720px]:hidden ml-auto max-w-36" aria-label="Раздел платформы" value={tab} onChange={event => chooseTab(event.target.value as TabId)}>{TABS.map(item => <option key={item.id} value={item.id}>{item.title}</option>)}</select>
      {playing && tab !== 'prepare' && <button className="fx-btn fx-btn-sm ml-auto" onClick={() => chooseTab('prepare')}>К столу</button>}
    </header>
    {st.link === 'reconnecting' && <Reconnecting />}{stale && <Stale seconds={Math.round((now - st.at) / 1000)} />}
    <div className="flex-1 min-h-0 overflow-y-auto scrollbar-thin">
      {picking ? <InvitePicker people={people} busy={busyOf('invite')} onClose={() => setPicking(false)} onPick={async userId => {
        const sent = await pending.run('invite', key => api.invite(userId, gameId || null, key), `${userId}:${gameId}`);
        if (sent) setPicking(false); await st.refresh();
      }} /> : st.loading && !st.at ? <Waiting /> : pastSession ? <MatchFrame key={pastSession} sessionId={pastSession} meId={meId} names={names} onLeave={() => setPastSession('')} />
        : tab === 'history' ? <HistoryTab names={names} onOpen={setPastSession} />
          : playing && tab === 'prepare' ? <MatchFrame key={String(st.session.id)} sessionId={String(st.session.id)} meId={meId} names={names} onLeave={() => { void st.refresh(); }} />
            : tab === 'library' ? <LibraryTab games={games} selected={gameId} busy={mainBusy} active={playing} room={st.lobby ? { title: game?.title || 'Комната', players: slots.length, ready: slots.filter((slot: any) => slot.ready).length } : undefined} onSelect={async id => {
              const opened = await pending.run('lobby.open', key => api.openLobby(id, key), id);
              if (opened) { await st.refresh(); setTab('prepare'); }
            }} /> : <PrepareTab invites={st.invites} names={names} lobby={st.lobby} party={st.party} meId={meId} presence={presence}
              action={action} actionBusy={mainBusy} actionFailure={mainFailure} result={st.result} onAction={() => void runMain()} onSeeLibrary={() => chooseTab('library')}
              onAccept={async id => { await pending.run(`invite.accept:${id}`, key => api.acceptInvite(id, key)); await st.refresh(); }}
              onDecline={async id => { await pending.run(`invite.decline:${id}`, key => api.declineInvite(id, key)); await st.refresh(); }}
              onSeatLimit={async seats => { const lobbyId = String(st.lobby?.id || ''), revision = Number(st.lobby?.revision || 0); await pending.run('lobby.seats', key => api.setLobbySeats(lobbyId, seats, revision, key), `${lobbyId}:${revision}:${seats}`); await st.refresh(); }} />}
    </div>
    {mainFailure && tab === 'library' && <Failure text={mainFailure} />}
    {auxiliaryFailure && <Failure text={auxiliaryFailure} />}
    {st.failure && <Failure text={st.failure} onRetry={() => void st.refresh()} busy={st.loading} />}
    {st.party ? <PartyBar members={members} leaderId={String(st.party.leaderId)} meId={meId} presence={presence} busy={playing || busyOf('party.leave') || busyOf('party.kick')}
      onInvite={() => { setPicking(true); setTab('prepare'); }}
      onKick={async userId => { await pending.run('party.kick', key => api.kickFromParty(userId, key)); await st.refresh(); }}
      onLeave={async () => { await pending.run('party.leave', key => api.leaveParty(key)); await st.refresh(); }} />
      : <div className="shrink-0 fx-tools"><span className="text-xs text-slate-500 dark:text-slate-400">Пригласите коллегу в выбранную игру</span><button className="fx-btn fx-btn-primary ml-auto" disabled={!games.length || busyOf('invite')} onClick={() => { setPicking(true); setTab('prepare'); }}>Позвать</button></div>}
  </div>;
}
