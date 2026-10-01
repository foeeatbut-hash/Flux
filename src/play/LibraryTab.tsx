import React from 'react';
import { CircleDot, Layers } from 'lucide-react';
import type { PlayGameDef } from '../../play/features';
import { Empty } from './states';
function GamePreview({ pool }: { pool: boolean }) {
  return <svg viewBox="0 0 640 190" aria-hidden="true" className="w-full max-h-48 rounded-lg bg-slate-100 dark:bg-slate-950">
    {pool ? <g>
      <rect x="100" y="15" width="440" height="160" rx="16" fill="#795238" />
      <rect x="112" y="27" width="416" height="136" rx="10" fill="#236277" />
      {[[118, 32], [320, 28], [522, 32], [118, 158], [320, 162], [522, 158]].map(([x, y], i) => <circle key={i} cx={x} cy={y} r="8" fill="#111827" />)}
      <circle cx="205" cy="95" r="7" fill="#ffffff" /><line x1="125" y1="120" x2="193" y2="99" stroke="#d6b584" strokeWidth="4" />
      {[['#ecc94b', 400, 83], ['#171717', 411, 95], ['#4299e1', 400, 107], ['#e53e3e', 389, 95]].map(([color, x, y], i) => <circle key={i} cx={x} cy={y} r="7" fill={String(color)} />)}
    </g> : <g>
      <rect x="90" y="18" width="460" height="154" rx="16" fill="#334155" />
      <text x="146" y="44" fontSize="14" fill="#cbd5e1">Козырь</text>
      <g transform="translate(129 58) rotate(-13 30 45)"><rect width="62" height="92" rx="7" fill="#f8fafc" /><text x="9" y="23" fontSize="17" fill="#b91c1c">Т</text><text x="30" y="61" fontSize="28" textAnchor="middle" fill="#b91c1c">♦</text></g>
      <g transform="translate(178 53)"><rect width="62" height="92" rx="7" fill="#f8fafc" /><rect x="5" y="5" width="52" height="82" rx="4" fill="#475569" stroke="#94a3b8" strokeDasharray="3 4" /></g>
      <text x="330" y="44" fontSize="14" fill="#cbd5e1">Атака и защита</text>
      <g transform="translate(330 60)"><rect width="62" height="92" rx="7" fill="#f8fafc" /><text x="9" y="23" fontSize="17" fill="#1e293b">6</text><text x="30" y="61" fontSize="28" textAnchor="middle" fill="#1e293b">♣</text></g>
      <g transform="translate(378 58) rotate(13 30 45)"><rect width="62" height="92" rx="7" fill="#f8fafc" /><text x="9" y="23" fontSize="17" fill="#1e293b">9</text><text x="30" y="61" fontSize="28" textAnchor="middle" fill="#1e293b">♣</text></g>
    </g>}
  </svg>;
}
export default function LibraryTab({ games, selected, busy, active = false, room, onSelect }: { games: PlayGameDef[]; selected: string; busy: boolean; active?: boolean; room?: { title: string; players: number; ready: number }; onSelect: (id: string) => void }) {
  const [picked, setPicked] = React.useState(selected || games[0]?.id || '');
  if (!games.length) return <Empty icon={<Layers className="w-4 h-4" />} title="Библиотека пока пуста" hint="Администратор выдаёт доступ к играм в карточке сотрудника." />;
  const game = games.find(g => g.id === picked) || games[0];
  const pool = game.id === 'billiards';
  return <div className="flex flex-col @[720px]:flex-row min-h-full">
    <aside className="@[720px]:w-56 shrink-0 border-b @[720px]:border-b-0 @[720px]:border-r border-slate-200 dark:border-slate-800 p-2">
      {games.map(g => <button key={g.id} className="fx-li w-full" aria-current={game.id === g.id ? 'page' : undefined} onClick={() => setPicked(g.id)}>
        {g.id === 'billiards' ? <CircleDot className="w-4 h-4 shrink-0" /> : <Layers className="w-4 h-4 shrink-0" />}<span className="truncate">{g.short}</span>
      </button>)}
    </aside>
    <div className="flex-1 min-w-0 p-4 text-sm text-slate-700 dark:text-slate-100 space-y-4">
      <GamePreview pool={pool} />
      <h3 className="font-semibold">{game.title}</h3>
      <p className="text-xs text-slate-500 dark:text-slate-400">{game.desc}</p>
      {room && <p className="text-xs text-slate-500 dark:text-slate-400">Текущая комната: {room.title} · игроков {room.players} · готовы {room.ready}</p>}
      <button className="fx-btn fx-btn-primary" disabled={busy || active} onClick={() => onSelect(game.id)}>Подготовить стол</button>
      {active && <p className="text-xs text-slate-500 dark:text-slate-400">Текущая партия продолжается. Вернитесь к столу или завершите её перед выбором другой игры.</p>}
      <p className="text-xs text-slate-500 dark:text-slate-400 leading-relaxed">{pool ? 'Забейте сплошные или полосатые шары, затем восьмёрку. Фолы и очередь определяет общий сервер; приглашённые коллеги могут наблюдать.' : 'Атакуйте и отбивайтесь по правилам выбранного варианта. Только вы видите свои карты; всем доступны козырь, стол и число карт соперников.'}</p>
      <dl className="text-xs grid grid-cols-[auto_1fr] gap-x-4 gap-y-2">
        <dt>Игроки</dt><dd>{pool ? 'Два сотрудника; приглашённые коллеги могут наблюдать' : 'От двух до шести участников с 36 картами; до восьми с 52 картами'}</dd>
        <dt>Управление</dt><dd>{pool ? 'Мышь — прицел; сила — ползунок; стрелки — точная поправка; пробел — удар' : 'Подкидной и переводной варианты; своя закрытая рука, козырь и общий стол'}</dd>
        <dt>Подключение</dt><dd>Пригласите коллег, отметьте готовность и начните. Всё работает внутри Flux.</dd>
        <dt>Возвращение</dt><dd>Закрытое окно и обрыв сети сохраняют стол в общей базе компании</dd>
      </dl>
    </div>
  </div>;
}
