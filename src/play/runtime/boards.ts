/**
 * Какая доска рисует какую игру.
 *
 * Реестр, а не `switch` в раме матча: игр будет больше, и выбор, зашитый
 * ветками, заставил бы править раму на каждую новую. Доска, которой нет,
 * показывается словами — «игра не подключена», а не пустым местом.
 */

import type React from 'react';
import ReversiBoard from './ReversiBoard';
import G2048Board from './G2048Board';
import SudokuBoard from './SudokuBoard';
import CheckersBoard from './CheckersBoard';
import SeaBattleBoard from './SeaBattleBoard';
import UnknownBoard from './UnknownBoard';

export interface BoardProps {
  view: any;
  yourTurn: boolean;
  busy: boolean;
  onMove: (move: unknown) => void | Promise<void>;
}

const BOARDS: Record<string, React.ComponentType<BoardProps>> = {
  reversi: ReversiBoard,
  g2048: G2048Board,
  sudoku: SudokuBoard,
  checkers: CheckersBoard,
  seabattle: SeaBattleBoard,
};

export const boardFor = (gameId: string): React.ComponentType<BoardProps> =>
  BOARDS[String(gameId || '')] || UnknownBoard;
