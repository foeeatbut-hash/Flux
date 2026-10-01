/** Данные каталога приводов «НЕМАН» 2026 года. */
import type { Component, Manufacturer } from '../model';
import { NEMAN_STANDARD_COMPONENTS } from './nemanStandard';
import { NEMAN_SPRING_COMPONENTS } from './nemanSpring';
import { NEMAN_FIRE_COMPONENTS } from './nemanFire';
import { NEMAN_SMOKE_COMPONENTS } from './nemanSmoke';

export const NEMAN_MANUFACTURER: Manufacturer = {
  id: 'mf-neman', name: 'НЕМАН', shortName: 'НЕМАН', country: 'Россия',
  notes: 'Приводы по каталогу основных видов 2026 года; карточки имеют статус partial до проверки всех подробных параметров.',
};

export const NEMAN_COMPONENTS: Component[] = [
  ...NEMAN_STANDARD_COMPONENTS,
  ...NEMAN_SPRING_COMPONENTS,
  ...NEMAN_FIRE_COMPONENTS,
  ...NEMAN_SMOKE_COMPONENTS,
];
