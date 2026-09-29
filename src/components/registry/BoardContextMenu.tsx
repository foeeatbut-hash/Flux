/**
 * Меню правой кнопки по пустому месту холста: раскладка, «по размеру»,
 * «Создать тег здесь» и «Снять выделение».
 *
 * Вынесено из Registry.tsx как есть. Условие показа остаётся в Registry:
 * блок лежит внутри AnimatePresence mode="wait", и безусловный компонент
 * делал бы там второго ребёнка (см. комментарий у CardActions).
 */
import React from 'react';
import { Network, Maximize2, Plus, X } from 'lucide-react';
import ContextMenu from '../ContextMenu';
import { type Point, type TreeAxis } from '../../lib/tagLayout';

export interface BoardContextMenuProps {
  /** Где открыто на экране и какой точке холста это соответствует */
  menu: { x: number; y: number; at: Point };
  chooseAxis: (axis: TreeAxis) => void;
  arrangeTreeLayout: (dir?: TreeAxis) => Promise<void>;
  fitCanvasToCenter: () => void;
  onCreateHere: (at: Point) => void;
  onClearSelection: () => void;
  onClose: () => void;
}

export default function BoardContextMenu({
  menu, chooseAxis, arrangeTreeLayout, fitCanvasToCenter, onCreateHere, onClearSelection, onClose,
}: BoardContextMenuProps) {
  return (
    <ContextMenu
      x={menu.x}
      y={menu.y}
      items={[
        {
          label: 'Упорядочить сверху вниз',
          icon: <Network className="w-3.5 h-3.5" />,
          onClick: () => { chooseAxis('down'); void arrangeTreeLayout('down'); },
        },
        {
          label: 'Упорядочить слева направо',
          icon: <Network className="w-3.5 h-3.5" />,
          onClick: () => { chooseAxis('right'); void arrangeTreeLayout('right'); },
        },
        {
          label: 'Вписать весь холст',
          icon: <Maximize2 className="w-3.5 h-3.5" />,
          onClick: () => fitCanvasToCenter(),
        },
        {
          label: 'Создать тег здесь',
          icon: <Plus className="w-3.5 h-3.5" />,
          // Точка передаётся сразу, а не читается позже: пока человек
          // набирает код, он успевает подвинуть холст, и «здесь» уезжает
          onClick: () => onCreateHere(menu.at),
        },
        {
          label: 'Снять выделение',
          icon: <X className="w-3.5 h-3.5" />,
          onClick: () => onClearSelection(),
        },
      ]}
      onClose={onClose}
    />
  );
}
