// Оболочка стенда: окно раздела на весь стол и панель задач, как в программе.
// Страница кладёт только тело раздела (<div class="win-body" data-title data-ic>),
// оболочка оборачивает его. Тема — ?theme=dark, чтобы снимать обе без щелчков.
(() => {
  const q = new URLSearchParams(location.search);
  if (q.get('theme') === 'dark') document.documentElement.classList.add('dark');

  const body = document.querySelector('.win-body');
  const title = body.dataset.title || '';
  const ic = body.dataset.ic || 'square';
  const app = body.dataset.app || title;

  const desk = document.createElement('div');
  desk.className = 'desk';
  desk.innerHTML = `
    <div class="win">
      <div class="win-title">
        <i data-ic="${ic}" data-s="14"></i><span class="t">${title}</span>
        <span class="win-btn"><i data-ic="minus" data-s="14"></i></span>
        <span class="win-btn"><i data-ic="copy" data-s="13"></i></span>
        <span class="win-btn"><i data-ic="x" data-s="14"></i></span>
      </div>
    </div>`;
  body.replaceWith(desk);
  desk.querySelector('.win').appendChild(body);

  const apps = [['tag', 'Теги'], ['fan', 'Оборудование'], ['folder-open', 'Проводник'], ['table-2', 'Таблица'],
    ['mail', 'Почта'], ['folder-kanban', 'Проекты'], ['settings', 'Настройки'], ['users', 'Сотрудники'], ['clipboard-list', 'Журнал']];
  const bar = document.createElement('div');
  bar.className = 'taskbar';
  bar.innerHTML = `<span class="tb-start"><i data-ic="layout-grid" data-s="18"></i></span>` +
    apps.map(([i, n]) => `<span class="tb-app${n === app ? ' on' : ''}"><i data-ic="${i}"></i>${n === app || ['Теги', 'Оборудование', 'Проводник'].includes(n) ? n : ''}</span>`).join('') +
    `<span class="tb-right">
       <span class="tb-proj"><span class="st ok"></span>9900 · Приточно-вытяжная система</span>
       <span class="clock"><b>05:05</b>24 сентября</span>
       <i data-ic="bell"></i>
     </span>`;
  document.body.appendChild(bar);
  paintIcons();
})();
