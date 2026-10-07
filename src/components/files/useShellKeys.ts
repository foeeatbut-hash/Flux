import { useCallback, useRef } from 'react';
import type React from 'react';
import { matchShellKey, type ShellAction } from './explorerKeys';

/**
 * Клавиши окна Проводника (`SHELL_KEYS`): вешается один `onKeyDown` на корень
 * экрана, и всё, что в нём всплывает, попадает сюда. Всплывает и то, что
 * вынесено порталом в заголовок окна (вкладки), потому что React пускает
 * события по дереву компонентов, а не по дереву узлов.
 *
 * Обработчики берутся из ссылки на последние, а не из замыкания: экран не
 * обязан оборачивать их в `useCallback`, и нажатие всегда видит свежее
 * состояние.
 */
export function useShellKeys(handlers: Record<ShellAction, () => void>) {
  const latest = useRef(handlers); latest.current = handlers;
  return useCallback((event: React.KeyboardEvent) => {
    const binding = matchShellKey(event.nativeEvent);
    if (!binding) return;
    // Браузерные значения (Alt+← «назад по странице», F5 «перезагрузить», Ctrl+F «поиск по странице») здесь не нужны
    event.preventDefault();
    latest.current[binding.action]();
  }, []);
}
