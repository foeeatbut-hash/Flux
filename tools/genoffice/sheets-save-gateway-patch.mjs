/**
 * Adds Flux's in-place XLSX save-session retention to the pinned GenOffice
 * source. Source edits are pure transforms and are all validated before any
 * file is written, so a stale upstream source cannot leave a partial patch.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

export function transformSheetsMain(source) {
  let out = source
  out = replaceExactly(out,
    '  readonly sha256: string\n  readonly sheetNames: ReadonlyMap<string, string>\n',
    '  readonly sha256: string\n  /** Digest of the last successful disk save; sha256 remains the immutable open snapshot digest. */\n  readonly lastSavedSha256?: string\n  /** Renderer-facing metadata returned at open; retained saves preserve this identity. */\n  readonly baselineFile?: WorkbookFile\n  readonly sheetNames: ReadonlyMap<string, string>\n',
    'session disk baseline fields')
  out = replaceExactly(out,
    'currentSha !== session.sha256',
    'currentSha !== (session.lastSavedSha256 ?? session.sha256)',
    'normal-save disk CAS baseline')
  out = replaceExactly(out,
    '    return workbookFileSchema.parse({\n      ...opened,\n      // The renderer-facing path is what the user opened: for a restored\n      // recovery copy that is the original file, not the copy under userData.\n      path: restoreTarget ?? path,\n      sha256: digest,\n      fileBytes: snapshotStat.size,\n      readOnly: false,\n      needsSaveAs: suggestSaveAs !== undefined,\n      ...(csvSourcePath === undefined ? {} : { csvPath: csvSourcePath }),\n      ...(emptyCsv ? { emptyCsv: true } : {}),\n      restoredFromRecovery: restoreTarget !== undefined,\n      automaticRecoveryDisabled: !allowsAutomaticWorkbookRecovery(opened.sheets),\n    })',
    '    const file = workbookFileSchema.parse({\n      ...opened,\n      // The renderer-facing path is what the user opened: for a restored\n      // recovery copy that is the original file, not the copy under userData.\n      path: restoreTarget ?? path,\n      sha256: digest,\n      fileBytes: snapshotStat.size,\n      readOnly: false,\n      needsSaveAs: suggestSaveAs !== undefined,\n      ...(csvSourcePath === undefined ? {} : { csvPath: csvSourcePath }),\n      ...(emptyCsv ? { emptyCsv: true } : {}),\n      restoredFromRecovery: restoreTarget !== undefined,\n      automaticRecoveryDisabled: !allowsAutomaticWorkbookRecovery(opened.sheets),\n    })\n    const session = sessions.get(opened.sessionId)\n    if (session) sessions.set(opened.sessionId, { ...session, baselineFile: file })\n    return file',
    'open-session baseline file cache')
  out = replaceExactly(out,
    `    const request = resolveTransferredEdits(entry, workbookSaveRequestSchema.parse(input))\n    const session = entry.sessions.get(request.sessionId)\n    if (!session) throw new Error('Unknown workbook session.')\n`,
    `    const request = resolveTransferredEdits(entry, workbookSaveRequestSchema.parse(input))
    const session = entry.sessions.get(request.sessionId)
    if (!session) throw new Error('Unknown workbook session.')
    const retainedSessionId = request.retainedSessionId
    const retainedWorkingSession = retainedSessionId === undefined
      ? undefined
      : entry.sessions.get(retainedSessionId)
    if (retainedSessionId !== undefined &&
      (!retainedWorkingSession || retainedWorkingSession.path !== session.path || retainedSessionId === request.sessionId ||
        retainedWorkingSession.baselineFile === undefined || retainedWorkingSession.csvImport === true ||
        retainedWorkingSession.csvSourcePath !== undefined || retainedWorkingSession.suggestSaveAs !== undefined ||
        retainedWorkingSession.restoreTarget !== undefined)) {
      throw new Error('Unknown retained workbook session.')
    }
    if ((request.saveContinuation === true || retainedSessionId !== undefined) &&
      (request.targetPath !== undefined || session.suggestSaveAs !== undefined || session.restoreTarget !== undefined ||
        session.csvImport === true || session.csvSourcePath !== undefined || session.baselineFile === undefined)) {
      throw new Error('Session retention is unavailable for this workbook session.')
    }
    const capturedSaveSessions = new Map<string, typeof session>([
      [request.sessionId, session],
      ...(retainedSessionId !== undefined && retainedWorkingSession
        ? [[retainedSessionId, retainedWorkingSession] as const]
        : []),
    ])
    const recoverSavedWorkbookAfterDigestFailure = async (staleIds: readonly string[]) => {
      const stale = staleIds.map((id) => {
        const captured = capturedSaveSessions.get(id)
        if (!captured || entry.sessions.get(id) !== captured) throw new Error('Workbook session closed during save.')
        return [id, captured] as const
      })
      let replacement: WorkbookFile | undefined
      let replacementSession: typeof session | undefined
      try {
        for (const [id, captured] of stale) {
          if (entry.sessions.get(id) !== captured) throw new Error('Workbook session closed during save.')
        }
        replacement = await openWorkbookSession(client, targetPath, entry.sessions)
        for (const [id, captured] of stale) {
          if (entry.sessions.get(id) !== captured) throw new Error('Workbook session closed during save.')
        }
        replacementSession = entry.sessions.get(replacement.sessionId)
        if (!replacementSession) throw new Error('Could not establish saved workbook baseline.')
        await commitFluxSave()
        for (const [id, captured] of stale) {
          if (entry.sessions.get(id) !== captured) throw new Error('Workbook session closed during save.')
        }
        if (!replacementSession || entry.sessions.get(replacement.sessionId) !== replacementSession) {
          throw new Error('Recovered workbook session closed during save.')
        }
      } catch (error) {
        if (replacement) {
          const failedReplacementId = replacement.sessionId
          const failedReplacementSession = entry.sessions.get(failedReplacementId)
          if (failedReplacementSession) {
            entry.sessions.delete(failedReplacementId)
            await cleanupSessionResources({
              tempRoot: app.getPath('temp'),
              snapshotPath: failedReplacementSession.snapshotPath,
              importTempDir: failedReplacementSession.importTempDir,
              closeSidecar: () => client.close(failedReplacementId),
            }).catch(() => undefined)
          }
        }
        for (const [id, captured] of stale) {
          if (entry.sessions.get(id) !== captured) continue
          entry.sessions.delete(id)
          await cleanupSessionResources({
            tempRoot: app.getPath('temp'),
            snapshotPath: captured.snapshotPath,
            importTempDir: captured.importTempDir,
            closeSidecar: () => client.close(id),
          }).catch(() => undefined)
        }
        throw error
      }
      if (!replacement || !replacementSession) throw new Error('Could not establish saved workbook baseline.')
      for (const [id] of stale) entry.sessions.delete(id)
      for (const [id, captured] of stale) {
        await cleanupSessionResources({
          tempRoot: app.getPath('temp'),
          snapshotPath: captured.snapshotPath,
          importTempDir: captured.importTempDir,
          closeSidecar: () => client.close(id),
        }).catch(() => undefined)
      }
      if (entry.sessions.get(replacement.sessionId) !== replacementSession) {
        throw new Error('Recovered workbook session closed during save.')
      }
      workbookOpenedHook?.(event.sender, targetPath)
      clearWorkbookRecovery(targetPath)
      return replacement
    }
`,
    'split-save retained session validation')
  out = replaceExactly(out,
    '    const mutation = await writeWorkbookTo(client, session, request, targetPath)\n\n    if (csvInPlace && session.csvSourcePath !== undefined && request.csvContent !== undefined) {',
    `    const mutation = await writeWorkbookTo(client, session, request, targetPath)

    if (request.saveContinuation === true) {
      const savedDiskSha = await sha256File(targetPath).catch(() => undefined)
      if (savedDiskSha === undefined) {
        const recoveredFile = await recoverSavedWorkbookAfterDigestFailure([request.sessionId])
        return { canceled: false, file: recoveredFile, touchedEntries: mutation.touchedEntries }
      }
      if (entry.sessions.get(request.sessionId) !== session) throw new Error('Workbook session closed during save.')
      entry.sessions.set(request.sessionId, { ...session, lastSavedSha256: savedDiskSha })
      await commitFluxSave()
      if (!entry.sessions.has(request.sessionId)) throw new Error('Workbook session closed during save.')
      const continuationFile = await openWorkbookSession(client, targetPath, entry.sessions)
      workbookOpenedHook?.(event.sender, targetPath)
      clearWorkbookRecovery(targetPath)
      return { canceled: false, file: continuationFile, touchedEntries: mutation.touchedEntries, sessionRetained: true }
    }

    if (retainedSessionId !== undefined && retainedWorkingSession) {
      const savedDiskSha = await sha256File(targetPath).catch(() => undefined)
      if (savedDiskSha === undefined) {
        const recoveredFile = await recoverSavedWorkbookAfterDigestFailure([request.sessionId, retainedSessionId])
        return { canceled: false, file: recoveredFile, touchedEntries: mutation.touchedEntries }
      }
      if (entry.sessions.get(request.sessionId) !== session || entry.sessions.get(retainedSessionId) !== retainedWorkingSession) {
        throw new Error('Workbook session closed during save.')
      }
      entry.sessions.set(retainedSessionId, { ...retainedWorkingSession, lastSavedSha256: savedDiskSha })
      await commitFluxSave()
      if (!entry.sessions.has(request.sessionId) || !entry.sessions.has(retainedSessionId)) throw new Error('Workbook session closed during save.')
      entry.sessions.delete(request.sessionId)
      await cleanupSessionResources({
        tempRoot: app.getPath('temp'),
        snapshotPath: session.snapshotPath,
        importTempDir: session.importTempDir,
        closeSidecar: () => client.close(request.sessionId),
      })
      workbookOpenedHook?.(event.sender, targetPath)
      clearWorkbookRecovery(targetPath)
      return {
        canceled: false,
        file: retainedWorkingSession.baselineFile!,
        touchedEntries: mutation.touchedEntries,
        sessionRetained: true,
      }
    }

    const retainSession = request.retainSession === true &&
      request.mode === 'save' &&
      request.targetPath === undefined &&
      targetPath === session.path &&
      session.baselineFile !== undefined &&
      session.suggestSaveAs === undefined &&
      session.restoreTarget === undefined &&
      session.csvImport !== true &&
      session.csvSourcePath === undefined &&
      !csvInPlace

    if (retainSession) {
      // writeWorkbookTo has committed successfully. Advance only the disk CAS
      // digest; snapshotPath, sha256, sidecar reader, and journal stay intact.
      const savedDiskSha = await sha256File(targetPath).catch(() => undefined)
      if (savedDiskSha === undefined) {
        const recoveredFile = await recoverSavedWorkbookAfterDigestFailure([request.sessionId])
        return { canceled: false, file: recoveredFile, touchedEntries: mutation.touchedEntries }
      }
      if (entry.sessions.get(request.sessionId) !== session) throw new Error('Workbook session closed during save.')
      entry.sessions.set(request.sessionId, { ...session, lastSavedSha256: savedDiskSha })
      // The native cache is written; the capability commit must also succeed before acknowledgement.
      await commitFluxSave()
      if (!entry.sessions.has(request.sessionId)) throw new Error('Workbook session closed during save.')
      workbookOpenedHook?.(event.sender, targetPath)
      clearWorkbookRecovery(targetPath)
      return {
        canceled: false,
        file: session.baselineFile!,
        touchedEntries: mutation.touchedEntries,
        sessionRetained: true,
      }
    }

    if (csvInPlace && session.csvSourcePath !== undefined && request.csvContent !== undefined) {`,
    'post-write retain-session branches')
  out = replaceExactly(out,
    '    const mutation = await writeWorkbookTo(client, session, request, targetPath)\n',
    `    if (retainedWorkingSession && (targetPath !== session.path || targetPath !== retainedWorkingSession.path)) {\n      throw new Error('Retained workbook session target changed.')\n    }\n    const mutation = await writeWorkbookTo(client, session, request, targetPath)\n`,
    'split-save target path validation')
  return out
}

export function transformDesktopApi(source) {
  let out = replaceExactly(source,
    "    mode: z.enum(['save', 'save-as']),\n",
    "    mode: z.enum(['save', 'save-as']),\n    /// Keep the existing native XLSX sidecar session after an eligible normal Save.\n    retainSession: z.boolean().optional(),\n    /// Split-save phase 1: open a temporary continuation reader after this save.\n    saveContinuation: z.boolean().optional(),\n    /// Split-save phase 2: return to and advance the original working session.\n    retainedSessionId: z.string().uuid().optional(),\n",
    'save request retainSession flag')
  out = replaceExactly(out,
    '      touchedEntries: z.array(z.string()).max(MAX_SAVE_EDITS),\n',
    '      touchedEntries: z.array(z.string()).max(MAX_SAVE_EDITS),\n      sessionRetained: z.boolean().optional(),\n',
    'save result sessionRetained marker')
  return replaceExactly(out,
    "  .refine((request) => request.sheetOps.length === 0 || request.sheetOrder.length > 0, {\n    message: 'Sheet operations need the final sheet order.',\n  })",
    `  .refine((request) => request.sheetOps.length === 0 || request.sheetOrder.length > 0, {\n    message: 'Sheet operations need the final sheet order.',\n  })\n  .superRefine((request, context) => {\n    if (request.retainSession && request.mode !== 'save') {\n      context.addIssue({ code: z.ZodIssueCode.custom, message: 'Session retention is only valid for normal Save.' })\n    }\n    if (request.saveContinuation && (!request.retainSession || request.mode !== 'save' || request.targetPath !== undefined || request.retainedSessionId !== undefined)) {\n      context.addIssue({ code: z.ZodIssueCode.custom, message: 'Invalid split-save continuation request.' })\n    }\n    if (request.retainedSessionId !== undefined && (!request.retainSession || request.mode !== 'save' || request.targetPath !== undefined || request.saveContinuation)) {\n      context.addIssue({ code: z.ZodIssueCode.custom, message: 'Invalid retained working-session request.' })\n    }\n  })`,
    'save split-phase request validation')
}

export function transformIpcChannels(source) {
  if (!source.includes("saveWorkbook: 'workbook:save'")) {
    throw new Error('Cannot patch IPC channels: expected saveWorkbook channel was not found')
  }
  return source
}

export function transformSheetsPreload(source) {
  let out = replaceExactly(source,
    "  if (!isRecord(input)) throw new Error('Invalid workbook save response.')\n  if (input.canceled === true) {",
    "  if (!isRecord(input)) throw new Error('Invalid workbook save response.')\n  if (input.ok === false) {\n    throw new Error(typeof input.error === 'string' && input.error.length > 0 ? input.error : 'Workbook save failed.')\n  }\n  if (input.canceled === true) {\n    if (input.sessionRetained !== undefined) throw new Error('Invalid workbook save response.')",
    'preload failed-save response handling')
  out = replaceExactly(out,
    "    input.canceled !== false ||\n    !Array.isArray(input.touchedEntries) ||",
    "    input.canceled !== false ||\n    (input.sessionRetained !== undefined && typeof input.sessionRetained !== 'boolean') ||\n    !Array.isArray(input.touchedEntries) ||",
    'preload retained-session response validation')
  return replaceExactly(out,
    '    touchedEntries: input.touchedEntries as string[],\n  }',
    '    touchedEntries: input.touchedEntries as string[],\n    ...(input.sessionRetained === undefined ? {} : { sessionRetained: input.sessionRetained }),\n  }',
    'preload retained-session response preservation')
}

function replaceExactly(source, before, after, label) {
  if (source.includes(after)) return source
  const index = source.indexOf(before)
  if (index < 0 || source.indexOf(before, index + before.length) >= 0) {
    throw new Error(`Cannot patch ${label}: expected one exact source anchor`)
  }
  return source.slice(0, index) + after + source.slice(index + before.length)
}

export function applyGatewaySavePatches(root) {
  if (typeof root !== 'string' || root.length === 0) {
    throw new Error('applyGatewaySavePatches requires the GenOffice source root')
  }
  const files = [
    ['apps/sheets/src/main/sheets-main.ts', transformSheetsMain],
    ['apps/sheets/src/shared/desktop-api.ts', transformDesktopApi],
    ['apps/sheets/src/shared/ipc-channels.ts', transformIpcChannels],
    ['apps/sheets/src/preload/index.ts', transformSheetsPreload],
  ]
  const transformed = files.map(([path, transform]) => {
    const absolute = resolve(root, path)
    return [absolute, transform(readFileSync(absolute, 'utf8'))]
  })
  for (const [path, contents] of transformed) writeFileSync(path, contents)
  return files.map(([path]) => `sheets save gateway ${path}: applied`)
}

