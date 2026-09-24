/**
 * Граница ошибок вокруг одного раздела рабочего стола.
 *
 * Зачем отдельно от корневой границы в main.tsx: рабочий стол держит разделы
 * «живыми» — до четырёх смонтированных одновременно. Одна корневая граница
 * означает, что сбой рендера в любом разделе сносит всю программу вместе с
 * остальными панелями и несохранёнными правками в них. Здесь сбой остаётся
 * внутри своей панели: остальные разделы продолжают работать, а упавший можно
 * перезапустить или закрыть.
 *
 * Сюда же попадают сбои подгрузки чанка (раздел грузится лениво): если файл не
 * прочитался, «Перезапустить» повторяет загрузку, а не требует перезапуска exe.
 */
import React, { Component, ReactNode, ErrorInfo } from 'react';
import { RotateCcw, X, AlertTriangle } from 'lucide-react';
import { writeCrash } from '../lib/crashLog';

interface Props {
  /** Название раздела — попадает в журнал и в текст сообщения */
  title: string;
  /** Закрыть вкладку раздела; если не передан, кнопка не показывается */
  onClose?: () => void;
  children: ReactNode;
}

interface State {
  error: Error | null;
  /** Счётчик попыток: смена ключа перемонтирует поддерево заново */
  attempt: number;
}

export default class SectionErrorBoundary extends Component<Props, State> {
  state: State = { error: null, attempt: 0 };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // Сбой уходит и в журнал программы, и в файл на рабочем столе. Раньше он
    // оставался только здесь, и человек, которому предлагали «прислать логи»,
    // отдавал файл, в котором этого сбоя не было вовсе
    writeCrash(
      `Раздел: ${this.props.title}`,
      `Сбой раздела «${this.props.title}»: ${error.message}`,
      `${error.stack || ''}\n${info.componentStack || ''}`,
    );
  }

  private retry = () => {
    this.setState((s) => ({ error: null, attempt: s.attempt + 1 }));
  };

  render() {
    const { error, attempt } = this.state;
    if (error) {
      return (
        <div className="w-full h-full overflow-y-auto">
          <div className="w-full max-w-lg p-4">
            <div className="flex items-center gap-2 mb-2">
              <AlertTriangle className="w-4 h-4 text-rose-600 dark:text-rose-400" />
              <div className="text-sm font-semibold text-slate-800 dark:text-slate-100">
                Раздел «{this.props.title}» не открылся
              </div>
            </div>
            <p className="text-xs text-slate-500 dark:text-slate-400 mb-4">
              Остальные разделы продолжают работать — данные в них не потеряны. Попробуйте
              перезапустить раздел; если сбой повторяется, пришлите текст ниже разработчику
              (он же записан в Журнал).
            </p>
            <pre className="text-xs font-mono text-rose-700 dark:text-rose-300 bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-900/60 rounded-md p-3 max-h-40 overflow-auto whitespace-pre-wrap">
              {String(error.message || error)}
            </pre>
            <div className="flex items-center gap-2 mt-4">
              <button
                type="button"
                onClick={this.retry}
                className="fx-btn fx-btn-primary"
              >
                <RotateCcw className="w-3.5 h-3.5" />
                Перезапустить раздел
              </button>
              {this.props.onClose && (
                <button
                  type="button"
                  onClick={this.props.onClose}
                  className="fx-btn"
                >
                  <X className="w-3.5 h-3.5" />
                  Закрыть
                </button>
              )}
            </div>
          </div>
        </div>
      );
    }
    // Ключ по номеру попытки: без него React вернёт то же поддерево с прежним
    // сломанным состоянием и граница сработает повторно на том же месте
    return <React.Fragment key={attempt}>{this.props.children}</React.Fragment>;
  }
}
