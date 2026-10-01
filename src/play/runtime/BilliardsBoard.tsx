import React from 'react';
import type { BoardProps } from './boards';
import type { PoolState } from '../../../play/games/billiards';
import { canPlaceCue, TABLE, type PoolBall, type PoolFrame } from '../../../play/games/billiardsPhysics';
const COLORS = ['#ffffff', '#ecc94b', '#4299e1', '#e53e3e', '#805ad5', '#ed8936', '#38a169', '#9b2c2c', '#171717'];

function interpolated(frames: PoolFrame[], time: number): PoolBall[] {
  let index = 0;
  while (index + 1 < frames.length && frames[index + 1].t < time) index++;
  const from = frames[index], to = frames[Math.min(index + 1, frames.length - 1)];
  const fraction = to.t > from.t ? Math.min(1, Math.max(0, (time - from.t) / (to.t - from.t))) : 1;
  return from.balls.map(([id, x, y]) => {
    const target = to.balls.find(b => b[0] === id);
    return { id, x: target ? x + (target[1] - x) * fraction : x, y: target ? y + (target[2] - y) * fraction : y, pocketed: !target && fraction > 0.8 };
  });
}

export default function BilliardsBoard({ view, yourTurn, busy, onMove, names = {} }: BoardProps) {
  const state = view as PoolState;
  const svg = React.useRef<SVGSVGElement>(null);
  const seenShot = React.useRef(0);
  const [balls, setBalls] = React.useState(state.balls);
  const [aim, setAim] = React.useState(0);
  const [power, setPower] = React.useState(0.7);
  const [spin, setSpin] = React.useState(0);
  const [replaying, setReplaying] = React.useState(false);
  const [replay, setReplay] = React.useState(0);
  const seenReplay = React.useRef(0);
  const [help, setHelp] = React.useState(false);
  const [clock, setClock] = React.useState(Date.now());
  const locked = busy || replaying || Number(state.shotEndAt || 0) > clock;
  React.useEffect(() => {
    const timer = setInterval(() => setClock(Date.now()), 200);
    return () => clearInterval(timer);
  }, []);
  React.useEffect(() => {
    const shot = state.lastShot;
    const isNew = shot && shot.number !== seenShot.current;
    const manualReplay = replay !== seenReplay.current;
    seenReplay.current = replay;
    seenShot.current = shot?.number || 0;
    if (!shot || (!isNew && !manualReplay) || !shot.frames.length) { setBalls(state.balls); return; }
    let handle = 0;
    let started = performance.now();
    const elapsed = !manualReplay && state.shotEndAt ? Math.max(0, shot.durationMs - (state.shotEndAt - Date.now())) : 0;
    if (elapsed >= shot.durationMs && !manualReplay) { setBalls(state.balls); return; }
    setReplaying(true);
    const tick = (now: number) => {
      const time = now - started + elapsed;
      if (time >= shot.durationMs) { setBalls(state.balls); setReplaying(false); return; }
      setBalls(interpolated(shot.frames, time));
      handle = requestAnimationFrame(tick);
    };
    handle = requestAnimationFrame(tick);
    return () => { cancelAnimationFrame(handle); setReplaying(false); };
  }, [state.shots, state.ballInHand, replay]);
  // Неподвижный стол обновляется после размещения битка без повторного проигрывания удара.
  React.useEffect(() => { if (!replaying) setBalls(state.balls); }, [state.balls.find(b => b.id === 0)?.x, state.balls.find(b => b.id === 0)?.y, state.ballInHand]);
  const cue = balls.find(b => b.id === 0 && !b.pocketed);
  const point = (event: React.PointerEvent) => {
    const transform = svg.current!.getScreenCTM();
    if (!transform) return { x: -1, y: -1 };
    const translated = new DOMPoint(event.clientX, event.clientY).matrixTransform(transform.inverse());
    return { x: translated.x, y: translated.y };
  };
  const aimAt = (event: React.PointerEvent) => {
    if (!yourTurn || locked || state.ballInHand || !cue) return;
    const p = point(event); setAim(Math.atan2(p.y - cue.y, p.x - cue.x));
  };
  const place = (event: React.PointerEvent) => {
    if (!yourTurn || locked || !state.ballInHand) return;
    const p = point(event); if (canPlaceCue(state.balls, p.x, p.y)) void onMove({ type: 'place', ...p });
  };
  const shot = () => { if (yourTurn && !locked && !state.ballInHand) void onMove({ type: 'shot', angle: aim, power, spin }); };
  return <div className="flex flex-col gap-3 min-w-0" data-pool-table>
    <div className="flex flex-wrap gap-x-5 gap-y-1 text-xs text-slate-600 dark:text-slate-300">
      {state.groups.map((group, i) => <span className="max-w-full break-words" key={i}>{names[state.seats[i]] || `Игрок ${i + 1}`}: {group === 'solids' ? 'сплошные 1–7' : group === 'stripes' ? 'полосатые 9–15' : 'группа ещё не выбрана'}
        {group && ` · осталось ${state.balls.filter(b => !b.pocketed && (group === 'solids' ? b.id >= 1 && b.id <= 7 : b.id >= 9)).length}`}</span>)}
    </div>
    <p role="status" className="text-xs text-slate-600 dark:text-slate-300">
      {replaying ? 'Шары движутся…' : state.ballInHand && yourTurn ? 'Шар с руки: нажмите на свободное место для битка' : state.message}
    </p>
    <svg ref={svg} viewBox="-40 -40 1080 580" onPointerMove={aimAt} onPointerDown={place}
      tabIndex={0} role="img" aria-label="Бильярдный стол. Прицельтесь мышью, затем нажмите Ударить"
      onKeyDown={event => { if (event.key === ' ') { event.preventDefault(); shot(); } if (event.key === 'ArrowLeft') setAim(a => a - Math.PI / 180); if (event.key === 'ArrowRight') setAim(a => a + Math.PI / 180); }}
      className="w-full max-h-[62vh] min-h-40 rounded-xl bg-slate-200 dark:bg-slate-950 touch-none" style={{ aspectRatio: '1080 / 580', cursor: state.ballInHand ? 'crosshair' : 'default' }}>
      <defs><radialGradient id="pool-ball-light"><stop offset="0" stopColor="#ffffff" stopOpacity="0.5" /><stop offset="1" stopColor="#000000" stopOpacity="0.15" /></radialGradient></defs>
      <rect x="-30" y="-30" width="1060" height="560" rx="35" fill="#744c2d" />
      <rect width="1000" height="500" rx="18" fill="#236277" />
      <rect x="10" y="10" width="980" height="480" rx="10" fill="none" stroke="#163e4b" strokeWidth="10" />
      {[[12, 12], [500, 5], [988, 12], [12, 488], [500, 495], [988, 488]].map(([x, y], i) => <circle key={i} cx={x} cy={y} r="27" fill="#111827" />)}
      <line x1="250" y1="32" x2="250" y2="468" stroke="#b5d5de" strokeOpacity="0.15" strokeDasharray="5 9" />
      {yourTurn && cue && !locked && !state.ballInHand && <g>
        <line x1={cue.x} y1={cue.y} x2={cue.x + Math.cos(aim) * 190} y2={cue.y + Math.sin(aim) * 190} stroke="#ffffff" strokeWidth="2" strokeOpacity="0.7" strokeDasharray="6 8" />
        <line x1={cue.x - Math.cos(aim) * 35} y1={cue.y - Math.sin(aim) * 35} x2={cue.x - Math.cos(aim) * 170} y2={cue.y - Math.sin(aim) * 170} stroke="#d7b67a" strokeWidth="5" strokeLinecap="round" />
      </g>}
      {balls.filter(b => !b.pocketed).map(b => <g key={b.id} transform={`translate(${b.x} ${b.y})`}>
        <circle r={TABLE.radius} fill={b.id > 8 ? '#f9fafb' : COLORS[b.id]} stroke="#102a35" strokeWidth="0.6" />
        {b.id > 8 && <path d="M -11 -5 A 12 12 0 0 1 11 -5 L 11 5 A 12 12 0 0 1 -11 5 Z" fill={COLORS[b.id - 8]} />}
        <circle r="12" fill="url(#pool-ball-light)" />
        {!!b.id && <><circle r="5.8" fill="#ffffff" /><text y="3.6" textAnchor="middle" fontSize="9" fontWeight="600" fill="#111827">{b.id}</text></>}
      </g>)}
    </svg>
    <div className="flex items-end flex-wrap gap-3">
      <label className="flex-1 min-w-36 fx-field"><span className="fx-label">Сила удара · {Math.round(power * 100)}%</span>
        <input type="range" aria-label="Сила удара" min="0.02" max="1" step="0.01" value={power} disabled={!yourTurn || locked} onChange={e => setPower(Number(e.target.value))} className="w-full accent-emerald-600" /></label>
      <label className="min-w-32 fx-field"><span className="fx-label">Вращение у борта</span>
        <select className="fx-input" value={spin} disabled={!yourTurn || locked} onChange={e => setSpin(Number(e.target.value))}><option value="0">Без вращения</option><option value="-0.5">Левое</option><option value="0.5">Правое</option></select></label>
      <button className="fx-btn fx-btn-primary" disabled={!yourTurn || locked || state.ballInHand || state.done} onClick={shot}>{busy ? 'Отправляем…' : locked ? 'Шары движутся' : 'Ударить'}</button>
      <button className="fx-btn" disabled={!state.lastShot || locked} onClick={() => setReplay(n => n + 1)}>Повтор удара</button>
      <button className="fx-btn fx-btn-quiet" aria-expanded={help} onClick={() => setHelp(v => !v)}>Правила</button>
    </div>
    {help && <div className="text-xs text-slate-600 dark:text-slate-300 leading-relaxed border-t border-slate-200 dark:border-slate-800 pt-3">
      Прицельтесь мышью; стрелки ← и → дают точную поправку, пробел делает удар. После разбоя стол открыт. Первое корректное забивание только одной группы назначает сплошные или полосатые.
      Свой забитый шар сохраняет ход. Фол: биток в лузе, первый контакт с чужой группой, отсутствие контакта или борта после него. После фола соперник ставит биток.
      Забейте все свои шары, затем восьмёрку отдельным ударом. Ранняя восьмёрка или восьмёрка с фолом — поражение. Восьмёрка на разбое возвращается на стол.
      Разбой законен при забитом шаре или четырёх прицельных шарах у бортов. Если на открытом столе одним ударом забиты обе группы, стол остаётся открытым.
    </div>}
  </div>;
}
