/**
 * Морской бой: правила доски.
 *
 * Проверяется то, из-за чего такая игра выглядит рабочей и не является ею:
 *
 *   — **касания**, включая диагональ: угол к углу — тоже касание;
 *   — **состав флота**: лишний двухпалубный вместо однопалубного не проходит;
 *   — **корабль по прямой** и без переезда на следующую строку;
 *   — **чужие корабли не видны в снимке** до конца партии — ни числом, ни
 *     пометкой: снимок уходит на сторону игрока целиком;
 *   — **попал — стреляешь снова**, промахнулся — ход переходит;
 *   — **убитый обводится промахами**, чтобы не тратить ходы на пустое;
 *   — **дважды в одну клетку** не стреляют;
 *   — расстановка по семени законна и повторяется.
 *
 * Запуск: npx tsx scripts/test-game-seabattle.ts
 */

import {
  seabattle, whyFleet, autoFleet, shipAt, around, FLEET, DECKS, CELLS, SIDE,
  type SeaState, type Ship,
} from '../play/games/seabattle';

let failed = 0;
const ok = (name: string, cond: boolean, detail?: unknown) =>
  cond
    ? console.log('  ✓', name)
    : (failed++, console.error('  ✗', name, detail === undefined ? '' : JSON.stringify(detail).slice(0, 300)));

const SEATS = ['первый', 'второй'];
const at = (x: number, y: number) => y * SIDE + x;

/** Законный флот руками: столбцами по левому краю, с зазором в клетку */
function handFleet(): Ship[] {
  return [
    shipAt(at(0, 0), 4, true),
    shipAt(at(2, 0), 3, true),
    shipAt(at(4, 0), 3, true),
    shipAt(at(6, 0), 2, true),
    shipAt(at(8, 0), 2, true),
    shipAt(at(0, 6), 2, true),
    shipAt(at(2, 6), 1, false),
    shipAt(at(4, 6), 1, false),
    shipAt(at(6, 6), 1, false),
    shipAt(at(8, 6), 1, false),
  ];
}

console.log('1. Законность расстановки');
{
  ok('флот руками законен', whyFleet(handFleet()) === '', whyFleet(handFleet()));

  const touch = handFleet();
  // Однопалубный впритык по диагонали к двухпалубному у (8,0)-(8,1)
  touch[6] = [at(7, 2)];
  ok('касание по диагонали отвергнуто', /соприкасаются/.test(whyFleet(touch)), whyFleet(touch));

  const over = handFleet();
  over[6] = [at(0, 1)];
  ok('наложение отвергнуто', /накладываются/.test(whyFleet(over)), whyFleet(over));

  const bent = handFleet();
  bent[3] = [at(6, 0), at(7, 0), at(7, 1)];
  ok('корабль буквой «Г» отвергнут', whyFleet(bent) !== '', whyFleet(bent));

  const wrap = handFleet();
  wrap[3] = [at(9, 2), at(0, 3)];
  ok('переезд на следующую строку отвергнут', /по прямой/.test(whyFleet(wrap)), whyFleet(wrap));

  const wrong = handFleet();
  wrong[6] = shipAt(at(0, 9), 2, false);
  ok('состав флота проверяется', /Флот должен быть/.test(whyFleet(wrong)), whyFleet(wrong));

  ok('короткий список отвергнут', whyFleet(handFleet().slice(0, 9)) !== '');
  ok('не список — отказ, а не падение', whyFleet(null as any) !== '');
  ok('клетка за краем отвергнута', whyFleet([[CELLS + 5], ...handFleet().slice(1)]) !== '');
}

console.log('2. Расстановка по семени');
{
  const a = autoFleet('семя', 0);
  const b = autoFleet('семя', 0);
  ok('расстановка законна', whyFleet(a) === '', whyFleet(a));
  ok('по тому же семени — та же', JSON.stringify(a) === JSON.stringify(b));
  ok('по другому счётчику — другая', JSON.stringify(a) !== JSON.stringify(autoFleet('семя', 1)));
  ok('палуб ровно двадцать', a.reduce((s, sh) => s + sh.length, 0) === DECKS);
  let all = true;
  for (let i = 0; i < 50; i++) if (whyFleet(autoFleet(`с${i}`, i)) !== '') all = false;
  ok('пятьдесят расстановок подряд законны', all);
}

console.log('3. Порядок партии');
{
  let s = seabattle.init('семя', SEATS) as SeaState;
  ok('сначала расстановка', seabattle.turnOf(s) === SEATS[0]);
  ok('стрелять до расстановки нельзя', /расставьте/.test(seabattle.why(s, SEATS[0], { shot: 0 })));

  s = seabattle.apply(s, SEATS[0], { place: handFleet() });
  ok('ждут второго', seabattle.turnOf(s) === SEATS[1]);
  ok('расставиться второй раз нельзя', /уже расставлены/.test(seabattle.why(s, SEATS[0], { place: handFleet() })));
  ok('расставившийся ждёт соперника', /ещё расставляет/.test(seabattle.why(s, SEATS[0], { shot: 0 })));

  s = seabattle.apply(s, SEATS[1], { place: autoFleet('вражеский', 3) });
  ok('бой начинает первый', seabattle.turnOf(s) === SEATS[0]);
  ok('чужой ход отвергнут', /ходит соперник/.test(seabattle.why(s, SEATS[1], { shot: 0 })));
  ok('расставляться в бою поздно', /Расстановка закончена/.test(seabattle.why(s, SEATS[0], { place: handFleet() })));
  ok('клетки за полем нет', seabattle.why(s, SEATS[0], { shot: CELLS }) !== '');
  ok('посторонний не за доской', seabattle.why(s, 'третий', { shot: 0 }) !== '');
}

console.log('4. Попал — стреляешь снова, промахнулся — ход переходит');
{
  let s = seabattle.init('семя', SEATS) as SeaState;
  s = seabattle.apply(s, SEATS[0], { place: handFleet() });
  s = seabattle.apply(s, SEATS[1], { place: handFleet() });

  // У второго тот же флот: четырёхпалубный стоит столбцом от (0,0)
  ok('ход первого', seabattle.turnOf(s) === SEATS[0]);
  s = seabattle.apply(s, SEATS[0], { shot: at(0, 0) });
  ok('попал — ходит снова', seabattle.turnOf(s) === SEATS[0]);
  ok('дважды в одну клетку нельзя', /уже стреляли/.test(seabattle.why(s, SEATS[0], { shot: at(0, 0) })));

  s = seabattle.apply(s, SEATS[0], { shot: at(5, 5) });
  ok('промах — ход перешёл', seabattle.turnOf(s) === SEATS[1]);
}

console.log('5. Убитый обводится промахами');
{
  let s = seabattle.init('семя', SEATS) as SeaState;
  s = seabattle.apply(s, SEATS[0], { place: handFleet() });
  s = seabattle.apply(s, SEATS[1], { place: handFleet() });

  // Однопалубный соперника стоит на (2,6): один выстрел — и он убит
  s = seabattle.apply(s, SEATS[0], { shot: at(2, 6) });
  const view: any = seabattle.viewOf(s, SEATS[0]);
  ok('убитый помечен', view.theirs[at(2, 6)] === 4);
  ok('клетка над убитым отмечена промахом', view.theirs[at(2, 5)] === 2);
  ok('клетка углом к убитому отмечена промахом', view.theirs[at(1, 5)] === 2);
  ok('стрелять в обведённое нельзя', /уже стреляли/.test(seabattle.why(s, SEATS[0], { shot: at(1, 5) })));
  ok('обводка не считается попаданием', view.foeDecks === DECKS - 1);
  ok('соседний корабль не раскрылся', view.theirs[at(4, 6)] === 0);
}

console.log('6. Чужие корабли в снимке не видны');
{
  let s = seabattle.init('семя', SEATS) as SeaState;
  s = seabattle.apply(s, SEATS[0], { place: handFleet() });
  s = seabattle.apply(s, SEATS[1], { place: autoFleet('вражеский', 7) });

  const view: any = seabattle.viewOf(s, SEATS[0]);
  const text = JSON.stringify(view);
  const foe = autoFleet('вражеский', 7);
  ok('целое чужое поле пусто', view.theirs.every((c: number) => c === 0));
  ok('расстановки соперника в снимке нет',
    !foe.some((ship) => text.includes(JSON.stringify(ship))));
  ok('своё поле видно целиком', view.mine.filter((c: number) => c === 1).length === DECKS);
  ok('зритель не видит ничего', (seabattle.viewOf(s, 'зритель') as any).watcher === true);
}

console.log('7. Конец партии');
{
  let s = seabattle.init('семя', SEATS) as SeaState;
  s = seabattle.apply(s, SEATS[0], { place: handFleet() });
  s = seabattle.apply(s, SEATS[1], { place: handFleet() });

  ok('партия идёт', seabattle.outcome(s).done === false);

  // Расстреливаем весь флот второго: ходы не передаются, пока попадаем
  for (const ship of handFleet()) {
    for (const cell of ship) {
      if (seabattle.why(s, SEATS[0], { shot: cell })) continue;
      s = seabattle.apply(s, SEATS[0], { shot: cell });
    }
  }
  const out = seabattle.outcome(s);
  ok('партия окончена', out.done === true);
  ok('победил первый', out.winnerTeam === 1, out);
  ok('после конца ходить нельзя', /окончена/.test(seabattle.why(s, SEATS[0], { shot: at(9, 9) })));
  ok('очереди больше нет', seabattle.turnOf(s) === '');

  const view: any = seabattle.viewOf(s, SEATS[0]);
  ok('после конца чужая расстановка открылась', view.theirs.filter((c: number) => c === 4).length === DECKS);
  ok('у победителя палубы целы', view.myDecks === DECKS);
}

console.log('8. Мелочи, на которых падают');
{
  ok('соседей у угла три', around(0).length === 3);
  ok('соседей у середины восемь', around(at(5, 5)).length === 8);
  ok('корабль за краем не строится', shipAt(at(9, 0), 2, false).length === 0);
  ok('флот описан десятью кораблями', FLEET.length === 10 && DECKS === 20);
  const s = seabattle.init('семя', SEATS) as SeaState;
  ok('ход без клетки и без флота не прочитан', /не прочитан/.test(seabattle.why(s, SEATS[0], {} as any)));
}

console.log(failed ? `\nПРОВАЛЕНО: ${failed}` : '\nВСЕ ТЕСТЫ ПРОЙДЕНЫ');
process.exit(failed ? 1 : 0);
