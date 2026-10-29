/**
 * Слой поверх программы для презентационного видео: курсор, «нажатие», подпись
 * шага, рамка-подсветка, всплывашка о выгрузке и заставки.
 *
 * Слой ставится через addInitScript и сам восстанавливается после перезагрузки
 * страницы; положение курсора и подпись переживают её через sessionStorage.
 * Всё внутри pointer-events:none, поэтому программа работает как обычно.
 * Палитра — из стиля Flux: изумрудный акцент и сланцевые тона.
 */
export const OVERLAY_SCRIPT = String.raw`(() => {
  if (window.__demo) return;
  const KEY = '__demo_state';
  const load = () => { try { return JSON.parse(sessionStorage.getItem(KEY) || '{}'); } catch (_) { return {}; } };
  const save = (patch) => { try { sessionStorage.setItem(KEY, JSON.stringify(Object.assign(load(), patch))); } catch (_) {} };

  const CSS = '' +
    '#__demo{position:fixed;inset:0;z-index:2147483647;pointer-events:none;font-family:Inter,"Segoe UI",system-ui,sans-serif}' +
    '#__demo *{box-sizing:border-box}' +
    '#__demo .cur{position:absolute;left:0;top:0;width:44px;height:44px;will-change:transform;filter:drop-shadow(0 3px 5px rgba(0,0,0,.45))}' +
    '#__demo .ring{position:absolute;left:0;top:0;width:76px;height:76px;margin:-38px 0 0 -38px;border-radius:50%;border:5px solid #10b981;background:rgba(16,185,129,.28);opacity:0;transform:scale(.3)}' +
    '#__demo .ring.go{animation:__demo_ring .5s ease-out}' +
    '@keyframes __demo_ring{0%{opacity:.95;transform:scale(.3)}100%{opacity:0;transform:scale(1.5)}}' +
    '#__demo .hl{position:absolute;border:5px solid #10b981;border-radius:10px;box-shadow:0 0 0 6px rgba(16,185,129,.28),0 0 28px rgba(16,185,129,.55);opacity:0;transition:opacity .25s,left .25s,top .25s,width .25s,height .25s}' +
    '#__demo .cap{position:absolute;left:48px;width:1640px;max-width:calc(100vw - 96px);padding:20px 32px 24px;border-radius:20px;background:rgba(15,23,42,.9);color:#f8fafc;opacity:0;transform:translateY(14px);transition:opacity .35s,transform .35s,top .35s,bottom .35s;box-shadow:0 14px 40px rgba(0,0,0,.35)}' +
    '#__demo .cap.on{opacity:1;transform:none}' +
    '#__demo .cap.bot{bottom:60px}#__demo .cap.top{top:24px}' +
    '#__demo .cap .t{display:flex;align-items:center;gap:18px;font-size:42px;font-weight:700;line-height:1.15}' +
    '#__demo .cap .n{display:inline-flex;align-items:center;justify-content:center;min-width:56px;height:56px;padding:0 14px;border-radius:14px;background:#059669;color:#fff;font-size:34px;font-weight:700}' +
    '#__demo .cap .d{margin-top:10px;font-size:30px;line-height:1.35;color:#e2e8f0}' +
    '#__demo .toast{position:absolute;top:170px;right:32px;max-width:900px;padding:18px 30px;border-radius:16px;background:#059669;color:#fff;font-size:32px;font-weight:600;opacity:0;transform:translateY(-16px);transition:opacity .3s,transform .3s;box-shadow:0 14px 40px rgba(0,0,0,.35)}' +
    '#__demo .toast.on{opacity:1;transform:none}' +
    '#__demo .slide{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;padding:0 140px;color:#f8fafc;background:radial-gradient(1200px 700px at 78% 12%,rgba(16,185,129,.30),transparent 60%),linear-gradient(160deg,#0f172a 0%,#1e293b 100%);opacity:0;transition:opacity .6s}' +
    '#__demo .slide.on{opacity:1}' +
    '#__demo .slide .logo{display:flex;align-items:center;gap:26px;margin-bottom:34px}' +
    '#__demo .slide .mark{width:104px;height:104px;border-radius:26px;background:#059669;display:flex;align-items:center;justify-content:center;font-size:68px;font-weight:800}' +
    '#__demo .slide h1{margin:0;font-size:104px;font-weight:800;letter-spacing:-.02em}' +
    '#__demo .slide h2{margin:0;font-size:52px;font-weight:500;color:#a7f3d0;line-height:1.3}' +
    '#__demo .slide .chn{font-size:30px;font-weight:700;letter-spacing:.18em;text-transform:uppercase;color:#6ee7b7;margin-bottom:22px}' +
    '#__demo .slide .chb{width:160px;height:6px;border-radius:3px;background:#10b981;margin:30px 0 0}' +
    '#__demo .slide ul{list-style:none;margin:36px 0 0;padding:0;text-align:left;font-size:44px;line-height:1.5}' +
    '#__demo .slide li{display:flex;gap:22px;align-items:flex-start;margin:14px 0}' +
    '#__demo .slide li::before{content:"";flex:none;width:18px;height:18px;margin-top:20px;border-radius:50%;background:#10b981}';

  const ARROW = '<svg viewBox="0 0 44 44" width="44" height="44"><path d="M5 3 L5 33 L13 26 L19 40 L25 37.5 L19 24 L30 24 Z" fill="#fff" stroke="#0f172a" stroke-width="2.4" stroke-linejoin="round"/></svg>';

  let root, cur, ring, hl, cap, toast, slide;
  const build = () => {
    if (root && root.isConnected) return;
    const st = document.createElement('style'); st.textContent = CSS;
    root = document.createElement('div'); root.id = '__demo';
    root.innerHTML = '<div class="hl"></div><div class="cur">' + ARROW + '</div><div class="ring"></div><div class="cap bot"></div><div class="toast"></div><div class="slide"></div>';
    root.prepend(st);
    (document.documentElement).appendChild(root);
    hl = root.querySelector('.hl'); cur = root.querySelector('.cur'); ring = root.querySelector('.ring');
    cap = root.querySelector('.cap'); toast = root.querySelector('.toast'); slide = root.querySelector('.slide');
    const s = load();
    const x = s.x == null ? 960 : s.x, y = s.y == null ? 560 : s.y;
    cur.style.transition = 'none'; cur.style.transform = 'translate(' + x + 'px,' + y + 'px)';
    if (s.cap) setCap(s.cap.n, s.cap.title, s.cap.text, s.cap.pos, true);
    if (s.slide) { slide.innerHTML = s.slide; slide.classList.add('on'); }
  };
  const esc = (t) => String(t).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

  function setCap(n, title, text, pos, quiet) {
    build();
    cap.className = 'cap ' + (pos === 'top' ? 'top' : 'bot');
    cap.innerHTML = '<div class="t"><span class="n">' + esc(n) + '</span><span>' + esc(title) + '</span></div>' + (text ? '<div class="d">' + esc(text) + '</div>' : '');
    void cap.offsetWidth;
    cap.classList.add('on');
    if (!quiet) save({ cap: { n, title, text, pos: pos || 'bot' } });
  }

  const hit = (a, b, pad) => a.left < b.right + pad && a.right > b.left - pad && a.top < b.bottom + pad && a.bottom > b.top - pad;

  window.__demo = {
    ensure: build,
    caption(n, title, text, pos) { setCap(n, title, text, pos); },
    hideCaption() { build(); cap.classList.remove('on'); save({ cap: null }); },
    // Подпись не должна закрывать то, на что показывает курсор: уходит на другую сторону
    avoid(r) {
      build();
      const s = load(); if (!s.cap) return;
      const cr = cap.getBoundingClientRect();
      const box = { left: r.x, top: r.y, right: r.x + r.width, bottom: r.y + r.height };
      if (hit(cr, box, 24)) { const pos = (s.cap.pos === 'top') ? 'bot' : 'top'; setCap(s.cap.n, s.cap.title, s.cap.text, pos); }
    },
    highlight(r) {
      build();
      if (!r) { hl.style.opacity = '0'; return; }
      const p = 6;
      hl.style.left = (r.x - p) + 'px'; hl.style.top = (r.y - p) + 'px';
      hl.style.width = (r.width + 2 * p) + 'px'; hl.style.height = (r.height + 2 * p) + 'px';
      hl.style.opacity = '1';
    },
    move(x, y, ms) {
      build();
      cur.style.transition = 'transform ' + ms + 'ms cubic-bezier(.45,.05,.25,1)';
      cur.style.transform = 'translate(' + x + 'px,' + y + 'px)';
      save({ x, y });
    },
    click(x, y) {
      build();
      ring.style.left = x + 'px'; ring.style.top = y + 'px';
      ring.classList.remove('go'); void ring.offsetWidth; ring.classList.add('go');
    },
    toast(text, ms) {
      build(); toast.textContent = text; toast.classList.add('on');
      setTimeout(() => toast.classList.remove('on'), ms || 4500);
    },
    showSlide(html) { build(); slide.innerHTML = html; void slide.offsetWidth; slide.classList.add('on'); save({ slide: html }); },
    hideSlide() { build(); slide.classList.remove('on'); save({ slide: null }); },
  };

  const boot = () => { build(); };
  if (document.documentElement) boot(); else document.addEventListener('DOMContentLoaded', boot);
  // Если программа переписала корень документа — слой возвращается на место
  new MutationObserver(() => { if (root && !root.isConnected) build(); }).observe(document, { childList: true, subtree: false });
})();`;
