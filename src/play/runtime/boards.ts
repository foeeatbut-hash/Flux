/**
 * Какая доска рисует какую игру.
 *
 * Реестр, а не `switch` в раме матча: игр будет больше, и выбор, зашитый
 * ветками, заставил бы править раму на каждую новую. Доска, которой нет,
 * показывается словами — «игра не подключена», а не пустым местом.
 */

import type React from 'react';
import BilliardsBoard from './BilliardsBoard';
import DurakBoard from './DurakBoard';
import UnknownBoard from './UnknownBoard';

export interface BoardProps {
  view: any;
  yourTurn: boolean;
  busy: boolean;
  names?: Record<string, string>;
  onMove: (move: unknown) => void | Promise<void>;
}

const BOARDS: Record<string, React.ComponentType<BoardProps>> = { billiards: BilliardsBoard, cards: DurakBoard };

export const boardFor = (gameId: string): React.ComponentType<BoardProps> =>
  BOARDS[String(gameId || '')] || UnknownBoard;
