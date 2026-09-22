import React from 'react';
import type { BoardProps } from './boards';

/**
 * Игра есть в матче, а доски к ней в окне нет.
 *
 * Такое бывает при обновлении: сервер уже знает новую игру, окно ещё нет.
 * Пустое место человек читает как поломку, поэтому здесь сказано словами, что
 * произошло и что делать.
 */
export default function UnknownBoard(_props: BoardProps) {
  return (
    <div className="blank">
      <div className="blank-title">Эта игра окну незнакома</div>
      <div className="blank-text">
        Похоже, сервер новее программы. Обновите Flux — доска появится вместе с обновлением.
      </div>
    </div>
  );
}
