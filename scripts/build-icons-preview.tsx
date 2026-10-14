/**
 * Стенд значков docs/stand/icons-preview.html — собирается из тех же
 * компонентов, что рисуют программу (AppIcons, SystemIcons, FileBadge), так что
 * он не может разойтись с кодом: правка рисунка видна здесь после пересборки.
 *
 * Запуск: npx tsx scripts/build-icons-preview.tsx
 */
import React from 'react';
import { writeFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { AppIcon, APP_ICON_BY_PATH, FileIcon, type FileIconKind } from '../src/components/icons/FluxIcons';
import FileBadge from '../src/components/ui/FileBadge';
import { ICON_SIZE } from '../src/lib/metrics';
import { badgeOf, BADGE_COLOR } from '../src/lib/fileBadge';
import { canOpenInFlux } from '../src/lib/fileTypes';

const TITLES: Record<string, string> = {
  '/': 'Главная', '/projects': 'Проекты', '/registry': 'Теги', '/equipment': 'Оборудование', '/directory': 'Справочник',
  '/management': 'Менеджмент', '/builder': 'Конструктор', '/catalog': 'Каталог', '/e3flux': 'E3Flux', '/archives': 'Архив',
  '/explorer': 'Проводник', '/sheet': 'Таблица', '/doc': 'Документ', '/pdf': 'PDF', '/guide': 'Flux Guide', '/translate': 'Переводчик',
  '/browser': 'Браузер', '/calendar': 'Календарь', '/notes': 'Блокнот', '/chat': 'Мессенджер', '/mail': 'Почта',
  '/feedback': 'Замечания', '/settings': 'Настройки', '/logs': 'Журнал', '/users': 'Сотрудники',
};
const APPS = Object.keys(TITLES).filter((path) => APP_ICON_BY_PATH[path]);
const FORMATS = ['Договор.docx', 'Старый.doc', 'Текст.rtf', 'Смета.xlsx', 'Макрос.xlsm', 'Выгрузка.csv', 'Таблица.ods', 'План.pdf', 'Заметки.md', 'Журнал.txt',
  'Фото.png', 'Снимок.jpg', 'Рисунок.svg', 'Архив.zip', 'Архив.rar', 'Схема.dwg', 'Чертёж.dxf', 'Проект.e3s', 'Данные.json', 'Данные.xml',
  'Страница.html', 'Доклад.pptx', 'Обзор.mp4', 'Запись.wav', 'Setup.exe', 'Пакет.msi', 'Скрипт.bat', 'Ярлык.lnk',
  'Модель.sldprt', 'Библиотека.dll', 'Образ.psd'];
const SYSTEM: Array<[FileIconKind, string]> = [['folder', 'Папка'], ['this-pc', 'Этот компьютер'], ['drive', 'Диск'], ['network', 'Сеть'], ['cloud', 'Облако'], ['bin', 'Корзина']];

const h = (node: React.ReactElement) => renderToStaticMarkup(node);
const tiles = (items: Array<{ label: string; note?: string; sizes: React.ReactElement[] }>) => items.map((item) =>
  `<div class="card"><div class="stage">${item.sizes.map(h).join('')}</div><b>${item.label}</b>${item.note ? `<small>${item.note}</small>` : ''}</div>`).join('\n');

const ladder = Object.entries({
  'Строка, список, таблица, меню, вкладка, заголовок окна': ICON_SIZE.row, 'Панель задач (в кнопке 40)': ICON_SIZE.taskbar,
  'Пуск, «содержимое» Проводника': ICON_SIZE.start, 'Рабочий стол, «средние» значки': ICON_SIZE.desktop, 'Проводник: «крупные»': ICON_SIZE.large,
});

const html = `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Значки Flux</title>
<style>
:root { --bg:#f8fafc; --surface:#fff; --border:#e2e8f0; --text:#1e293b; --muted:#64748b; }
html.dark { --bg:#0f1412; --surface:#171d1a; --border:#2a322f; --text:#f1f5f9; --muted:#94a3b8; }
* { box-sizing: border-box; }
body { margin:0; padding:24px 28px 60px; background:var(--bg); color:var(--text); font:13px/1.45 -apple-system,"Segoe UI",Inter,sans-serif; }
header { display:flex; justify-content:space-between; align-items:center; gap:16px; padding-bottom:16px; border-bottom:1px solid var(--border); margin-bottom:8px; }
h1 { font-size:18px; font-weight:600; margin:0; } h2 { font-size:14px; font-weight:600; margin:28px 0 10px; }
.sub, small { color:var(--muted); font-size:12px; }
button { border:1px solid var(--border); background:var(--surface); color:var(--text); border-radius:8px; padding:6px 12px; font:inherit; cursor:pointer; }
.grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(168px,1fr)); gap:10px; }
.card { background:var(--surface); border:1px solid var(--border); border-radius:10px; padding:12px; display:flex; flex-direction:column; align-items:center; gap:4px; text-align:center; }
.stage { display:flex; align-items:flex-end; gap:12px; min-height:48px; }
table { border-collapse:collapse; } td { padding:6px 14px 6px 0; vertical-align:middle; }
.fill-white{fill:#fff}.stroke-slate-300{stroke:#cbd5e1}.fill-slate-100{fill:#f1f5f9}
html.dark .dark\\:fill-slate-800{fill:#1e293b}html.dark .dark\\:stroke-slate-600{stroke:#475569}html.dark .dark\\:fill-slate-700{fill:#334155}
</style>
</head>
<body>
<header><div><h1>Значки Flux</h1><div class="sub">Собрано из компонентов программы: scripts/build-icons-preview.tsx. Системных значков Windows нет.</div></div><button id="t">Светлая / тёмная</button></header>
<h2>Лестница размеров <small>как в Windows 11 при 100 % (ICON_SIZE в src/lib/metrics.ts)</small></h2>
<table>${ladder.map(([role, size]) => `<tr><td>${h(<FileBadge file="Договор.docx" size={size} />)}</td><td>${h(<AppIcon path="/registry" size={size} />)}</td><td><b>${size} px</b> <small>${role}</small></td></tr>`).join('')}
<tr><td>${h(<FileBadge file="Договор.docx" size={ICON_SIZE.extraLarge} />)}</td><td></td><td><b>256 px</b> <small>Проводник: «огромные»</small></td></tr></table>
<h2>Программы <small>24 · 32 · 48 px</small></h2>
<div class="grid">${tiles(APPS.map((path) => ({ label: TITLES[path], note: path, sizes: [24, 32, 48].map((size) => <AppIcon path={path} size={size} />) })))}</div>
<h2>Файлы по формату <small>16 · 32 · 48 px; серая полоса и замок — Flux файл не открывает</small></h2>
<div class="grid">${tiles(FORMATS.map((name) => ({ label: name, note: `${badgeOf(name)} · ${canOpenInFlux(name) ? 'открывается во Flux' : 'не открывается'}`, sizes: [16, 32, 48].map((size) => <FileBadge file={name} size={size} />) })))}</div>
<h2>Места Проводника <small>16 · 32 · 48 px</small></h2>
<div class="grid">${tiles(SYSTEM.map(([kind, label]) => ({ label, sizes: [16, 32, 48].map((size) => <FileIcon kind={kind} size={size} />) })))}</div>
<p class="sub">Цвета полос: ${Object.entries(BADGE_COLOR).map(([kind, color]) => `<span style="color:${color}">■</span> ${kind}`).join(' · ')}</p>
<script>document.getElementById('t').onclick=()=>document.documentElement.classList.toggle('dark');</script>
</body>
</html>
`;
writeFileSync('docs/stand/icons-preview.html', html);
console.log(`docs/stand/icons-preview.html ${Math.round(html.length / 1024)} КБ`);
