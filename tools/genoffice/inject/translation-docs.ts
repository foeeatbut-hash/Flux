/**
 * Переводчик Flux Office: подключение к Документу (только apps/docs).
 *
 * Здесь всё, что знает про устройство GenOffice Docs: где лежит редактор и когда он готов, как собрать DOCX
 * из подменённого JSON. Чистая логика — в translation-word.ts, протокол — в translation-bridge.ts.
 * Вызывается из App.tsx правкой patches.mjs (flux-translation-docs).
 */
import type { FileActionContext } from '../file-actions'
import { buildDocBytes } from '../file-actions'
import { isPhasedContentPending } from '../phased-content'
import { waitForEditor } from './editor-readiness'
import { installTranslationBridge, type EditorTranslator } from './translation-bridge'
import { createWordTranslator } from './translation-word'

const ctxNow = (): FileActionContext | null => (window as any).__fluxCtxRef?.current || null

export function installDocsTranslation(): void {
  let cached: { editor: unknown; translator: EditorTranslator } | null = null
  installTranslationBridge('docs', async () => {
    // Запрос из окна может прийти раньше, чем документ загружен целиком: коротко ждём, потом честно «не готов»
    const ctx = await waitForEditor(() => { const c = ctxNow(); return c?.editor && c.doc && !isPhasedContentPending() ? c : null }, 7_000)
    if (!ctx) return null
    if (cached?.editor === ctx.editor) return cached.translator
    const translator = createWordTranslator(ctx.editor, {
      // Копия собирается из подменённого getJSON: открытый редактор и его состояние остаются прежними.
      // settleFontSettings сбрасывается, иначе он вернул бы настоящий контекст и подмена пропала бы
      buildBytes: (json) => {
        const live = ctxNow()
        if (!live) return Promise.resolve(null)
        return buildDocBytes({ ...live, settleFontSettings: undefined, editor: { getJSON: () => json } as any })
      },
      suggestedName: () => {
        const name = String((ctxNow() as any)?.fileName || (ctxNow() as any)?.doc?.name || 'Документ')
        return name.replace(/\.docx$/i, '') + ' (перевод).docx'
      },
    })
    cached = { editor: ctx.editor, translator }
    return translator
  })
}
