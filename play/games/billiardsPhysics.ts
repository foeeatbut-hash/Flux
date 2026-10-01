/** Фиксированный шаг нужен для одинакового результата на любом сервере компании. */
export const TABLE = { width: 1000, height: 500, radius: 12, pocketRadius: 27 };
export interface PoolBall { id: number; x: number; y: number; pocketed: boolean }
export interface PoolShot { type: 'shot'; angle: number; power: number; spin?: number }
export interface PoolFrame { t: number; balls: Array<[number, number, number]> }
export interface ShotSimulation {
  balls: PoolBall[]; firstHit: number | null; pocketed: number[]; railAfterHit: boolean;
  rails: number[]; durationMs: number; frames: PoolFrame[];
}
const pockets = [[12, 12], [500, 5], [988, 12], [12, 488], [500, 495], [988, 488]];
const rounded = (n: number) => Math.round(n * 1000) / 1000;

export function simulateShot(input: PoolBall[], shot: PoolShot): ShotSimulation {
  const balls = input.map(b => ({ ...b, vx: 0, vy: 0 }));
  const cue = balls.find(b => b.id === 0 && !b.pocketed);
  if (!cue) throw new Error('Биток отсутствует');
  const speed = 180 + shot.power * 2000;
  cue.vx = Math.cos(shot.angle) * speed; cue.vy = Math.sin(shot.angle) * speed;
  const dt = 1 / 240, radius = TABLE.radius;
  const result: ShotSimulation = { balls: [], firstHit: null, pocketed: [], railAfterHit: false, rails: [], durationMs: 0, frames: [] };
  const record = (step: number) => result.frames.push({ t: Math.round(step * dt * 1000), balls: balls.filter(b => !b.pocketed).map(b => [b.id, rounded(b.x), rounded(b.y)]) });
  record(0);
  let step = 0;
  for (step = 1; step <= 2400; step++) {
    let moving = false;
    for (const b of balls) {
      if (b.pocketed) continue;
      b.x += b.vx * dt; b.y += b.vy * dt;
      if (pockets.some(([x, y]) => Math.hypot(b.x - x, b.y - y) < TABLE.pocketRadius)) {
        b.pocketed = true; b.vx = 0; b.vy = 0; result.pocketed.push(b.id); continue;
      }
      let rail = false;
      if (b.x < radius || b.x > TABLE.width - radius) {
        b.x = Math.max(radius, Math.min(TABLE.width - radius, b.x)); b.vx *= -0.84; rail = true;
        if (b.id === 0) b.vy += (shot.spin || 0) * Math.abs(b.vx) * 0.12;
      }
      if (b.y < radius || b.y > TABLE.height - radius) {
        b.y = Math.max(radius, Math.min(TABLE.height - radius, b.y)); b.vy *= -0.84; rail = true;
        if (b.id === 0) b.vx -= (shot.spin || 0) * Math.abs(b.vy) * 0.12;
      }
      if (rail) {
        if (result.firstHit !== null) result.railAfterHit = true;
        if (!result.rails.includes(b.id)) result.rails.push(b.id);
      }
      const velocity = Math.hypot(b.vx, b.vy);
      if (velocity > 0) {
        const reduced = Math.max(0, velocity - 130 * dt);
        b.vx *= reduced / velocity; b.vy *= reduced / velocity;
        if (reduced > 0) moving = true;
      }
    }
    for (let i = 0; i < balls.length; i++) for (let j = i + 1; j < balls.length; j++) {
      const a = balls[i], b = balls[j];
      if (a.pocketed || b.pocketed) continue;
      const dx = b.x - a.x, dy = b.y - a.y, distance = Math.hypot(dx, dy);
      if (distance >= radius * 2 || distance < 0.00001) continue;
      const nx = dx / distance, ny = dy / distance;
      const overlap = (radius * 2 - distance + 0.001) / 2;
      a.x -= nx * overlap; a.y -= ny * overlap; b.x += nx * overlap; b.y += ny * overlap;
      const approaching = (a.vx - b.vx) * nx + (a.vy - b.vy) * ny;
      if (approaching <= 0) continue;
      if (result.firstHit === null && (a.id === 0 || b.id === 0)) result.firstHit = a.id === 0 ? b.id : a.id;
      const impulse = approaching * 0.985;
      a.vx -= impulse * nx; a.vy -= impulse * ny; b.vx += impulse * nx; b.vy += impulse * ny;
      moving = true;
    }
    if (step % 12 === 0) record(step);
    if (!moving) break;
  }
  record(Math.min(step, 2400));
  result.durationMs = Math.round(Math.min(step, 2400) * dt * 1000);
  result.balls = balls.map(({ id, x, y, pocketed }) => ({ id, x: rounded(Math.max(radius, Math.min(TABLE.width - radius, x))), y: rounded(Math.max(radius, Math.min(TABLE.height - radius, y))), pocketed }));
  return result;
}

export function canPlaceCue(balls: PoolBall[], x: number, y: number, breakOnly = false): boolean {
  return Number.isFinite(x) && Number.isFinite(y) && x >= 30 && x <= (breakOnly ? 250 : 970)
    && y >= 30 && y <= 470 && !pockets.some(([px, py]) => Math.hypot(x - px, y - py) < 36)
    && balls.every(b => b.id === 0 || b.pocketed || Math.hypot(x - b.x, y - b.y) >= TABLE.radius * 2 + 1);
}
