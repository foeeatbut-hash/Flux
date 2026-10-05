import React from 'react';
import { createRoot } from 'react-dom/client';
import '../../..//src/index.css';
import LibraryTab from '../../../src/play/LibraryTab';
import PrepareTab, { type Slot } from '../../../src/play/PrepareTab';
import InvitePicker from '../../../src/play/InvitePicker';
import PartyBar from '../../../src/play/PartyBar';
import { PLAY_GAMES } from '../../../play/features';
import type { PlayActivity, PlayStatus } from '../../../play/contracts';

const people = [
  { id: 'me', name: 'Ирина Оченьдлинная Фамилия Проверка Переноса', symbol: 'TEST-0001' },
  { id: 'player-2', name: 'Алексей Проверочный Сотрудник', symbol: 'TEST-0002' },
  { id: 'watcher', name: 'Наблюдатель без права хода', symbol: 'TEST-0003' },
];
const slots: Slot[] = [
  { userId: 'me', team: 1, ready: true },
  { userId: 'player-2', team: 2, ready: false },
];
const presence: Record<string, { status: PlayStatus; activity: PlayActivity }> = {
  me: { status: 'ONLINE', activity: 'MATCH' },
  'player-2': { status: 'AWAY', activity: 'MATCH' },
};

function Fixture() {
  const [tab, setTab] = React.useState<'library' | 'prepare' | 'invite'>('library');
  const [gameId, setGameId] = React.useState('cards');
  const [calls, setCalls] = React.useState<string[]>([]);
  const [busy, setBusy] = React.useState(false);
  const [failed, setFailed] = React.useState(false);
  const [spectator, setSpectator] = React.useState(false);
  const [members, setMembers] = React.useState([
    { userId: 'me', name: people[0].name, role: 'PLAYER' },
    { userId: 'player-2', name: people[1].name, role: 'PLAYER' },
    { userId: 'watcher', name: people[2].name, role: 'SPECTATOR' },
  ]);
  const call = (name: string) => setCalls(current => [...current, name]);
  const game = gameId;
  const lobby = tab === 'library' ? null : { id: 'lobby-fixture', gameId: game, state: 'OPEN', slots: spectator ? [] : slots, seats: 2 };
  const action = spectator
    ? { id: 'waitOthers' as const, label: 'Наблюдаете', hint: 'Стол откроется, когда игроки начнут партию', disabled: true, tone: 'quiet' as const }
    : { id: busy ? 'ready' as const : 'ready' as const, label: 'Готов', hint: 'Ожидаем второго игрока', disabled: false, tone: 'primary' as const };
  return <main className="min-h-screen bg-[var(--flux-surface)] text-slate-800 dark:text-slate-100 p-2">
    <header className="flex flex-wrap items-center gap-2 mb-2">
      <h1 className="font-semibold mr-auto">Flux Play — проверочная оболочка</h1>
      <button className="fx-btn" onClick={() => document.documentElement.classList.toggle('dark')}>Тема</button>
      <button className="fx-btn" onClick={() => setTab('library')}>Библиотека</button>
      <button className="fx-btn" onClick={() => setTab('prepare')}>Подготовка</button>
      <button className="fx-btn" onClick={() => setTab('invite')}>Пригласить</button>
      <button className="fx-btn" onClick={() => setSpectator(v => !v)}>Переключить роль</button>
      <button className="fx-btn" onClick={() => setBusy(v => !v)}>Занято</button>
      <button className="fx-btn" onClick={() => setFailed(v => !v)}>Ошибка</button>
    </header>
    {tab === 'library' && <LibraryTab games={PLAY_GAMES} selected={gameId} busy={busy} active={false} onSelect={id => { setGameId(id); call(`select:${id}`); setTab('prepare'); }} />}
    {tab === 'invite' && <InvitePicker people={people} busy={busy} onClose={() => setTab('prepare')} onPick={id => call(`invite:${id}`)} />}
    {tab === 'prepare' && <>
      <PrepareTab
        invites={[{ id: 'invite-one', fromUserId: 'player-2' }]}
        names={Object.fromEntries(people.map(p => [p.id, p.name]))}
        lobby={lobby}
        party={{ id: 'party-fixture', leaderId: 'me', members }}
        meId="me" presence={presence}
        action={action} actionBusy={busy} actionFailure={failed ? 'Соединение прервано. Повторите действие.' : ''}
        result={{ winnerTeam: 1, durationSec: 63 }}
        onAction={() => call('ready-start')}
        onAccept={id => call(`accept:${id}`)} onDecline={id => call(`decline:${id}`)} onSeeLibrary={() => setTab('library')} onSeatLimit={seats => call(`seats:${seats}`)}
      />
      <PartyBar members={members} leaderId="me" meId="me" presence={presence} busy={busy}
        onInvite={() => setTab('invite')} onKick={id => { call(`kick:${id}`); setMembers(ms => ms.filter(m => m.userId !== id)); }} onLeave={() => call('leave')} />
    </>}
    <output aria-label="Команды" data-testid="calls">{calls.join('|')}</output>
  </main>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);
