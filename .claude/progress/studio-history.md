# studio-history — функции «как в GitHub» в рабочем окне Studio

Задание: `docs/roadmap/studio-next.md`, «Очередь до выпуска», пункт 2 (История, Сравнение, Откат, Замечания владельца, Выпуски).
Карта: `docs/methodology/03-programs/studio.md`. Откат пишет файлы человека — `flux-data-safety`.
Своя ветка worktree `worktree-agent-a03a627a59ef8bbf2`; пуш: `git fetch origin && git rebase origin/claude/flux-stage-1-pjmxgt && git push origin HEAD:claude/flux-stage-1-pjmxgt` (без force).
Порты: сервер 3270, Vite 5270.
Ревизия старта: a714d363 (origin/claude/flux-stage-1-pjmxgt).

## Шаги
- [x] 1. `studio/shared/history.ts` + `scripts/test-studio-history.ts` (58 проверок, 11 мутаций), `.flux` скрыт в workspace.ts и архиве, набор в manifest и build-studio.yml
- [ ] 2. Действия главного процесса и окно: вкладка «История», автоснимки при сборке и отправке
- [ ] 3. Замечания владельца в редакторе
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
Шаг 1 готов, дальше шаг 2 (studio/shell/developer.ts, api.ts, ProjectWindow.tsx).
