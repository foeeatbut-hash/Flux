/**
 * Палитра и меры Проводника — одним местом.
 *
 * Проводник не следует палитре Flux: решение владельца «вид точно такой же»,
 * как в Windows 11 (docs/explorer-windows11.md, раздел «Как выглядит —
 * эталон»). Тёмные значения сняты с эталона пикселями; светлые — палитра
 * светлого Проводника Windows 11 (Mica Alt), снимка владельца для неё нет.
 *
 * Классы записаны целыми строками: Tailwind находит их по тексту, а собранные
 * из кусков (`bg-[${hex}]`) не увидел бы.
 */

/** Меры в точках — по эталону; проверка измеряет их у готовой разметки */
export const SIZE = {
  titleBar: 38,
  addressRow: 48,
  addressStep: 48,
  addressField: 32,
  navWidth: 287,
  navItem: 32,
  tabHeight: 32,
} as const;

/** Системный шрифт Windows: на других системах уступает тому, что есть */
export const FONT_STACK = '"Segoe UI Variable Text", "Segoe UI Variable", "Segoe UI", system-ui, sans-serif';

export const X = {
  /** Полоса вкладок, она же заголовок окна */
  strip: 'bg-[#e9e9e9] dark:bg-[#202020]',
  /** Активная вкладка и строка адреса: один цвет, чтобы вкладка «росла» из строки */
  surface: 'bg-[#f9f9f9] dark:bg-[#2c2c2c]',
  /** Поле адреса и поле поиска */
  field: 'bg-white dark:bg-[#383838]',
  fieldBorder: 'border border-[#e5e5e5] dark:border-transparent',
  /** Панель навигации и содержимое */
  pane: 'bg-white dark:bg-[#191919]',
  paneSelected: 'bg-[#e5e5e5] dark:bg-[#333333]',
  paneHover: 'hover:bg-[#f0f0f0] dark:hover:bg-[#2d2d2d]',
  groupLine: 'bg-[#e0e0e0] dark:bg-[#383838]',
  line: 'border-[#e5e5e5] dark:border-[#3a3a3a]',
  text: 'text-[#1b1b1b] dark:text-white',
  muted: 'text-[#5d5d5d] dark:text-[#c5c5c5]',
  faint: 'text-[#8a8a8a] dark:text-[#8c8c8c]',
  /** Кнопка в строке адреса: прямоугольник 48×48 без заливки, при наведении — светлая плашка */
  iconButton: 'hover:bg-black/[0.04] dark:hover:bg-white/[0.06]',
  menu: 'bg-white dark:bg-[#2c2c2c] border border-[#e0e0e0] dark:border-[#3f3f3f]',
} as const;
