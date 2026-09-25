/**
 * Flux Office: главный процесс Таблицы GenOffice на сервере Flux.
 *
 * Как pdf-host.ts: сборка кладёт этот файл в apps/sheets/src/ и собирает его
 * с родным главным процессом (sheets-main.ts) и заглушкой «electron».
 * Движок Excel — родной Rust-процесс xlsx-sidecar рядом со сборкой
 * (genoffice-server/xlsx-sidecar[.exe]): открывает книгу, отдаёт диапазоны,
 * пишет файл по месту, не трогая того, что не правили.
 */
import { basename, join } from 'node:path'
import { configureSheetsRuntime, createSheetsView, queueWorkbookForView } from './main/sheets-main'
import { __flux } from 'electron'

let started = false

export function start(resources: string): void {
  if (started) return
  started = true
  ;(globalThis as any).__FLUX_GENOFFICE_RES = resources
  configureSheetsRuntime({
    preloadPath: '',
    rendererUrl: undefined,
    rendererFile: '',
    sidecarPath: process.env.XLSX_SIDECAR_PATH || join(resources, process.platform === 'win32' ? 'xlsx-sidecar.exe' : 'xlsx-sidecar'),
    createDocument: async () => ({ ok: false, error: 'Создание документа из Таблицы во Flux Office пока недоступно' }),
  } as any)
}

/** Окно редактора над книгой; книга откроется первым selectWorkbook окна */
export function open(path: string): number {
  const view = createSheetsView({ includeAiHandlers: false })
  queueWorkbookForView(view.webContents as any, path)
  return view.webContents.id
}

/**
 * Имя книги движок берёт у своего снимка (случайное имя в temp), и оно
 * видно в строке состояния. Временный файл сервер называет как файл Flux —
 * его имя и отдаём окну
 */
function realName<T>(file: T): T {
  const f = file as any
  if (f && typeof f === 'object' && typeof f.sessionId === 'string' && typeof f.path === 'string') f.name = basename(f.path)
  return file
}

export async function invoke(id: number, channel: string, args: unknown[]) {
  const result = await __flux.invoke(id, channel, args)
  if (channel === 'workbook:select') return realName(result)
  if (channel === 'workbook:save' && result && typeof result === 'object') realName((result as any).file)
  return result
}
export const send = (id: number, channel: string, args: unknown[]) => __flux.send(id, channel, args)
export const onSend = (fn: (id: number, channel: string, args: unknown[]) => void) => __flux.onSend(fn)
export const close = (id: number) => __flux.destroy(id)
export const channels = () => __flux.channels()
