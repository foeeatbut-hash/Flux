/**
 * Настройки уведомлений: когда показывать всплывашку и когда звучать.
 *
 * Правило простое, а ошибались в нём дважды: звук привязывали к показу (при
 * выключенных «Всплывающих» он пропадал, хотя «Звук» включён), а ошибки
 * звучали всегда, даже при выключенном общем «Звуке». Здесь перебираются все
 * сочетания общих и категорийных флагов, чтобы привязка не вернулась.
 *
 * Запуск: npx tsx scripts/test-notif-prefs.ts
 */

// notifPrefs читает localStorage; в Node его нет, и подставляется простая
// замена — иначе настройки нечем задать, а getPrefs молча вернёт умолчания
const store = new Map<string, string>();
(globalThis as any).localStorage = {
  getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
  setItem: (k: string, v: string) => { store.set(k, String(v)); },
  removeItem: (k: string) => { store.delete(k); },
};

let failed = 0;
let passed = 0;
const check = (name: string, cond: boolean, got?: unknown) => {
  if (cond) { passed++; return; }
  failed++;
  console.error(`  ✗ ${name}${got === undefined ? '' : ` — получили ${JSON.stringify(got)}`}`);
};

(async () => {
  const P = await import('../src/lib/notifPrefs');
  const { NOTIF_CATEGORIES, defaultPrefs, savePrefs, shouldPopup, shouldSound, toastPlan } = P;

  const set = (popups: boolean, sound: boolean, cat?: { id: string; show: boolean; sound: boolean }) => {
    const p = defaultPrefs();
    p.popups = popups;
    p.sound = sound;
    if (cat) p.categories[cat.id] = { show: cat.show, sound: cat.sound };
    savePrefs(p);
  };

  console.log('Умолчания');
  set(true, true);
  check('по умолчанию всплывашка разрешена', shouldPopup('ЧАТ') === true);
  check('по умолчанию звук разрешён', shouldSound('ЧАТ') === true);
  check('умолчания есть у каждой категории из списка',
    NOTIF_CATEGORIES.every((c) => shouldPopup(c.id) && shouldSound(c.id)));

  console.log('Общие переключатели без категории');
  for (const popups of [true, false]) for (const sound of [true, false]) {
    set(popups, sound);
    check(`без категории: показ = «Всплывающие» (${popups}/${sound})`, shouldPopup() === popups);
    check(`без категории: звук = «Звук» (${popups}/${sound})`, shouldSound() === sound);
  }

  console.log('Все сочетания общих и категорийных флагов');
  for (const popups of [true, false]) for (const sound of [true, false])
    for (const show of [true, false]) for (const snd of [true, false]) {
      set(popups, sound, { id: 'ДОКУМЕНТЫ', show, sound: snd });
      const tag = `общие ${popups ? 'П' : '-'}${sound ? 'З' : '-'}, категория ${show ? 'п' : '-'}${snd ? 'з' : '-'}`;
      check(`показ только если разрешён и общий, и категорийный: ${tag}`, shouldPopup('ДОКУМЕНТЫ') === (popups && show));
      check(`звук только если разрешён и общий, и категорийный: ${tag}`, shouldSound('ДОКУМЕНТЫ') === (sound && snd));
      // Главное: звук не зависит от показа ни в какую сторону
      check(`звук не зависит от показа: ${tag}`,
        shouldSound('ДОКУМЕНТЫ') === (sound && snd) && shouldPopup('ДОКУМЕНТЫ') === (popups && show));
    }

  console.log('Именно те случаи, на которых ошибались');
  set(false, true);
  check('«Всплывающие» выключены, «Звук» включён: карточки нет', shouldPopup('ЧАТ') === false);
  check('«Всплывающие» выключены, «Звук» включён: сигнал звучит', shouldSound('ЧАТ') === true);
  set(true, false);
  check('«Звук» выключен, «Всплывающие» включены: карточка есть', shouldPopup('ЧАТ') === true);
  check('«Звук» выключен, «Всплывающие» включены: тишина', shouldSound('ЧАТ') === false);
  set(true, true, { id: 'ЧАТ', show: false, sound: true });
  check('категория без показа не гасит свой звук', shouldPopup('ЧАТ') === false && shouldSound('ЧАТ') === true);
  check('соседняя категория не затронута', shouldPopup('ДОКУМЕНТЫ') === true && shouldSound('ДОКУМЕНТЫ') === true);

  console.log('Неизвестная категория');
  set(true, true);
  check('«ПОЧТА» (на сервере есть, в настройках нет): общий «Показ» решает', shouldPopup('ПОЧТА') === true);
  check('«ПОЧТА»: общий «Звук» решает', shouldSound('ПОЧТА') === true);
  set(false, true);
  check('неизвестная категория подчиняется выключенным «Всплывающим»', shouldPopup('ПОЧТА') === false && shouldSound('ПОЧТА') === true);
  set(true, false);
  check('неизвестная категория подчиняется выключенному «Звуку»', shouldPopup('ПОЧТА') === true && shouldSound('ПОЧТА') === false);
  set(false, false);
  check('выдуманная категория при всём выключенном молчит', shouldPopup('НЕТ-ТАКОЙ') === false && shouldSound('НЕТ-ТАКОЙ') === false);
  set(true, true);
  check('выдуманная категория при всём включённом разрешена', shouldPopup('НЕТ-ТАКОЙ') === true && shouldSound('НЕТ-ТАКОЙ') === true);

  console.log('Ошибки: показ всегда, звук — по общему «Звуку»');
  for (const popups of [true, false]) for (const sound of [true, false]) {
    set(popups, sound);
    const plan = toastPlan('error');
    check(`ошибка показывается всегда (${popups}/${sound})`, plan.show === true);
    check(`звук ошибки = «Звук» (${popups}/${sound})`, plan.sound === sound, plan);
  }
  set(false, false);
  check('всё выключено: ошибка всё равно видна, но без звука', toastPlan('error').show === true && toastPlan('error').sound === false);
  set(true, true, { id: 'СИСТЕМА', show: true, sound: false });
  check('ошибка в категории с выключенным звуком не звучит', toastPlan('error', 'СИСТЕМА').sound === false);
  check('…но видна', toastPlan('error', 'СИСТЕМА').show === true);

  console.log('Обычные всплывашки идут по настройкам');
  for (const type of ['success', 'info'] as const) {
    set(false, true);
    check(`${type} при выключенных «Всплывающих» не показывается`, toastPlan(type).show === false);
    check(`${type} при выключенных «Всплывающих» всё же звучит`, toastPlan(type).sound === true);
    set(true, false);
    check(`${type} при выключенном «Звуке» показывается без звука`, toastPlan(type).show === true && toastPlan(type).sound === false);
    set(true, true, { id: 'ПРОЕКТЫ', show: false, sound: true });
    check(`${type}: категория с выключенным показом не показывается`, toastPlan(type, 'ПРОЕКТЫ').show === false);
  }

  console.log('Хранилище');
  set(false, false);
  store.set('notif_prefs_default', '{повреждено');
  check('битая запись настроек не роняет и даёт умолчания', shouldPopup('ЧАТ') === true && shouldSound('ЧАТ') === true);
  store.clear();
  check('пустое хранилище — умолчания', shouldPopup('ЧАТ') === true && shouldSound('ЧАТ') === true);
  store.set('notif_prefs_default', JSON.stringify({ popups: false }));
  check('в сохранённом нет поля «звук» — считается включённым', shouldSound('ЧАТ') === true && shouldPopup('ЧАТ') === false);
  store.set('notif_prefs_default', JSON.stringify({ categories: { ЧАТ: { show: false, sound: false } } }));
  check('сохранена одна категория — остальные по умолчанию',
    shouldPopup('ЧАТ') === false && shouldSound('ЧАТ') === false && shouldPopup('ДОСТУП') === true);

  console.log('Проводка в интерфейсе (разбор текста: Layout и toastStore не обходят правило)');
  {
    const { readFileSync } = await import('fs');
    const read = (rel: string) => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');
    const layout = read('src/components/Layout.tsx');
    const loop = layout.slice(layout.indexOf('onFreshNotifications('));
    const sound = loop.indexOf('shouldSound(n.category)');
    const popupGate = loop.indexOf('if (!shouldPopup(n.category)) continue;');
    check('в Layout звук решается через shouldSound', sound > 0);
    check('в Layout звук стоит раньше «continue» по показу — не зависит от всплывашки', popupGate > sound, { sound, popupGate });
    const toasts = read('src/store/toastStore.ts');
    check('toastStore берёт решение из toastPlan', toasts.includes('toastPlan(type, category)'));
    check('toastStore не звучит «всегда» для ошибок', !/force\s*\|\|/.test(toasts));
  }

  console.log(`\n${passed} проверок пройдено, ${failed} провалено`);
  process.exit(failed ? 1 : 0);
})();
