# Вызов программ: flux.programs.call (часть 2 реестра разрешений)

Задание: пункт 2б очереди `docs/roadmap/studio-next.md`; направление — `docs/roadmap/modules.md`, `module-api.md`.
Ветка `claude/admiring-fermat-tad55v`, старт — ae9b0d06. После каждого шага: коммит `wip: вызов программ — шаг N из 3: …`, отметка здесь, push.
`.claude/progress/studio-queue.md` не трогать.

Решения (сжато): `exports: [{method, does}]` у вызываемой (до 16); у вызывающей `permissions: [{kind:'program', program, does}]`;
исполнение — логика вызываемой (Python/WASM) без окна, вход `{export, data}`, выход `calc.out`; проверки: разрешение, установлена/допущена,
метод в exports, не себя, не вложенный; 256 КиБ, 4 одновременно, 20/с на программу; ошибки NOT_ALLOWED, NOT_INSTALLED, NO_METHOD, LIMIT, TIMEOUT, FAILED;
журнал у обеих; TypeScript — ясная ошибка, если нет пути вне окна.

## Шаги
- [x] 1. Реестр и схема (exports, вид program), строки/разница/отпечаток, окно установки и разница владельца + проверки модели.
- [ ] 2. Мост, клиент, исполнение и проверки вызова, журнал + набор проверок с двумя подписанными программами.
- [ ] 3. Studio и документы (module-api.md, modules.md, 03-programs/modules.md, studio.md).

## Проверки «до»
Известно: test-modules-restart-ui и test-studio-electron-start падают и на main.

## Где остановился
Шаг 1 сделан (modules/programs/model.ts, registry kind program, schemas exports; test-modules-permissions 63). Следующий — шаг 2: мост (type 'program'), client, electron/moduleProgramCalls.ts (begin/end, два вызова IPC), окно исполняет через moduleCompute, журнал у обеих.
