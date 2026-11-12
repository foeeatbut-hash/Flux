// Тема окна — как у Flux: выбор человека лежит под ключом `theme` и включает класс dark на <html> (src/store/store.ts)
try { document.documentElement.classList.toggle('dark', localStorage.getItem('theme') === 'dark'); } catch (e) { /* приватный режим: светлая */ }
