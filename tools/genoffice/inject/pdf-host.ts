/**
 * Flux Office: главный процесс PDF GenOffice на сервере Flux.
 *
 * Сборка (tools/genoffice/build.mjs) кладёт этот файл в apps/pdf/src/ и
 * собирает его вместе с родным главным процессом (pdf-main.ts), подменив
 * «electron» заглушкой (tools/genoffice/shims/electron-main.ts). Сервер Flux
 * (server/officeHostApps.ts) загружает результат и через него:
 *   - открывает окно редактора над файлом во временном каталоге;
 *   - передаёт вызовы окна родным обработчикам (сохранение, страницы,
 *     шрифты, подписи);
 *   - получает сообщения главного процесса окну.
 */
import { configurePdfRuntime, createPdfView } from './main/pdf-main'
import { __flux } from 'electron'

let started = false

/** Один раз на сервер. resources — где лежат wasm/ (pdfium, harfbuzz) */
export function start(resources: string): void {
  if (started) return
  started = true
  ;(globalThis as any).__FLUX_GENOFFICE_RES = resources
  configurePdfRuntime({
    preloadPath: '',
    rendererUrl: undefined,
    rendererFile: '',
    createDocument: async () => ({ ok: false, error: 'Создание документа из PDF во Flux Office пока недоступно' }),
  } as any)
}

/** Окно редактора над файлом; возвращает его номер */
export function open(path: string): number {
  return createPdfView(path).webContents.id
}

export const invoke = (id: number, channel: string, args: unknown[]) => __flux.invoke(id, channel, args)
export const send = (id: number, channel: string, args: unknown[]) => __flux.send(id, channel, args)
export const onSend = (fn: (id: number, channel: string, args: unknown[]) => void) => __flux.onSend(fn)
export const close = (id: number) => __flux.destroy(id)
export const channels = () => __flux.channels()
