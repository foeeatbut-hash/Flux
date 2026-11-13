# studio-history — функции «как в GitHub» в рабочем окне Studio

Задание: `docs/roadmap/studio-next.md`, «Очередь до выпуска», пункт 2 (История, Сравнение, Откат, Замечания владельца, Выпуски).
Карта: `docs/methodology/03-programs/studio.md`. Откат пишет файлы человека — `flux-data-safety`.
Своя ветка worktree `worktree-agent-a03a627a59ef8bbf2`; пуш: `git fetch origin && git rebase origin/claude/flux-stage-1-pjmxgt && git push origin HEAD:claude/flux-stage-1-pjmxgt` (без force).
Порты: сервер 3270, Vite 5270.
Ревизия старта: a714d363 (origin/claude/flux-stage-1-pjmxgt).

## Шаги
- [x] 1. `studio/shared/history.ts` + `scripts/test-studio-history.ts` (58 проверок, 11 мутаций), `.flux` скрыт в workspace.ts и архиве, набор в manifest и build-studio.yml
- [x] 2. Действия historyList/Save/Compare/Plan/Rollback/Remove в developer.ts, вкладка «История» (History.tsx, HistoryDialogs.tsx, DiffView.tsx), автоснимки при сборке и перед отправкой (promote после приёма); UI-случаи добавлены в test-studio-ui-developer (125 проверок, обе темы, снимки смотрены)
- [x] 3. Замечания владельца: shared/ownerNotes.ts (перенос по diffLines, «строка изменилась»), действие ownerNotes (существующий ответ requests + снимок отправки, нового маршрута нет), метки в CodeView marks (стили lint-меток и скрытие распорки только у номеров строк), вкладка «Замечания»; тест — в test-studio-history (66) и UI-случай (137)
- [ ] 4. Список выпусков и «Сравнить с текущим»
- [ ] 5. UI-проверки, journey, манифест, studio.md, убрать из плана сделанное

## Проверки «до»
tsc (код 0); studio-workspace, studio-project — зелёные.
test-verification-coverage падает только из-за симлинка public/genoffice среды (path escapes repository through a symlink) — не из-за правок.

## Решения
- Снимок = файлы пакета + `.fluxignore`; игнорируемое и сборочное в историю не входит и откатом не трогается; такой файл, который откат перезапишет, попадает в «перед откатом» (`shadowed`).
- Порядок вытеснения: сборка < перед откатом < ручная < отправка; новейший и цель отката не вытесняются.
- Пакет/архив защищены и validBundlePath (имя `.flux`), и HIDDEN_DIRS: мутируется только скрытие в дереве.

## На чём остановился
Шаги 2–3 готовы. Дальше шаг 4: выпуски своей программы (список, «Сравнить с текущим» по снимку отправки); источник — существующие маршруты выпусков (lastRelease/releases в developerServer.ts, /api/studio/releases).
(старая заметка: замечания владельца в редакторе (CodeView `marks` умеет метки в полях; список — BottomPanel, вкладка «Публикация»; данные — requests[].review.comments).
Браузер: scripts/chromePath.ts (findChrome) — после rebase проверить, нужен ли в test-studio-ui-developer.)
