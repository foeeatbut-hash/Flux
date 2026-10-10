export interface WindowsFileRef { rootId: string; relativePath: string; draftId?: string }
export type WindowsEquipmentSourcePick =
  | { canceled: true }
  | { canceled: false; selectedFile: { ref: WindowsFileRef; name: string }; sourceFolder: WindowsFileRef };
export type WindowsEquipmentSourceFolderPick =
  | { canceled: true }
  | { canceled: false; folder: WindowsFileRef };
export type WindowsKnownFolder = 'desktop' | 'documents' | 'downloads' | 'custom';
export interface WindowsRoot { id: string; name: string; kind: WindowsKnownFolder; available: boolean; network?: boolean }
export interface WindowsVolume {
  id: string; name: string; kind: 'fixed' | 'removable' | 'network' | 'optical' | 'ram'; networkPath?: string; size: number | null; free: number | null; root: WindowsRoot;
  // Мост заполняет три поля ниже всегда; необязательны они ради заглушек моста в проверках интерфейса, написанных до них.
  /** Метка тома как в Проводнике: «Локальный диск», «Новый том». Пустая метка заменяется названием по типу диска. */
  label?: string;
  /** «C:» — отдельно от имени, чтобы интерфейс мог подписать плитку как в Windows. */
  letter?: string;
  /** size − free; null, когда Windows не сообщила ёмкость (например, пустой дисковод). */
  used?: number | null;
  fileSystem?: string;
}
export interface WindowsFileEntry {
  name: string; relativePath: string; storage: 'flux' | 'windows'; draftId?: string; kind: 'file' | 'directory' | 'link' | 'other';
  fileId: string; size: number; modifiedAt: string; linked: boolean;
  rootId?: string; createdAt?: string; hidden?: boolean; author?: string; metadata?: WindowsFileMetadata;
  /** Названия проектов для показа; идентификаторы остаются в metadata. */
  projectNames?: string[];
}
export interface WindowsFileContent extends WindowsFileEntry { base64: string; sha256: string }
export interface WindowsFileMetadata {
  fileId: string; tags: string[]; projectIds: string[]; revision: string; responsible: string;
  history: { at: string; action: string; relativePath: string; sha256?: string }[];
}
export interface WindowsFilesChanged { rootId: string; relativePath: string; rescan: true }
export type WindowsFilesRequest =
  | { action: 'roots' }
  | { action: 'volumes' }
  | { action: 'openRecycleBin' }
  | { action: 'draftTrash' }
  | { action: 'pickImport'; extensions?: string[]; multiple?: boolean }
  | { action: 'pickEquipmentSource' }
  | { action: 'pickEquipmentSourceFolder' }
  | { action: 'restoreDraft'; ref: WindowsFileRef }
  | { action: 'addRoot' }
  | { action: 'list'; ref: WindowsFileRef; offset?: number; limit?: number }
  | { action: 'fileHash'; ref: WindowsFileRef }
  | { action: 'read' | 'stat'; ref: WindowsFileRef }
  | { action: 'icon'; ref: WindowsFileRef }
  | { action: 'write'; ref: WindowsFileRef; base64: string; baseSha256: string }
  | { action: 'publish'; parent: WindowsFileRef; name: string; base64: string; draftId: string }
  | { action: 'createDraft'; parent: WindowsFileRef; name: string; base64: string; group?: string }
  | { action: 'createDraftFolder'; parent: WindowsFileRef; name: string; group?: string }
  | { action: 'publishDraft' | 'publishDraftTree'; ref: WindowsFileRef; choices?: WindowsPublishChoices; group?: string }
  | { action: 'mkdir'; parent: WindowsFileRef; name: string; group?: string }
  | { action: 'rename'; ref: WindowsFileRef; name: string; group?: string }
  | { action: 'move'; ref: WindowsFileRef; parent: WindowsFileRef; name: string; baseSha256?: string; group?: string }
  | { action: 'copy'; ref: WindowsFileRef; parent: WindowsFileRef; name: string; baseSha256?: string; carryMeta?: boolean; group?: string }
  | { action: 'trash'; ref: WindowsFileRef; baseSha256?: string; group?: string }
  | { action: 'replaceCopy'; ref: WindowsFileRef; parent: WindowsFileRef; name: string; targetSha256: string; baseSha256?: string; move?: boolean; carryMeta?: boolean; group?: string }
  | { action: 'archive'; refs: WindowsFileRef[]; parent: WindowsFileRef; name: string; group?: string }
  | { action: 'purgeDraft'; ref: WindowsFileRef }
  | { action: 'systemProperties'; ref: WindowsFileRef }
  | { action: 'resolveAddress'; text: string }
  | { action: 'placeIcon'; place: 'home' | 'computer' | 'network'; size: number }
  | { action: 'permanentDelete'; ref: WindowsFileRef; baseSha256?: string }
  | { action: 'copyPath'; refs: WindowsFileRef[] }
  | { action: 'reveal' | 'open'; ref: WindowsFileRef }
  | { action: 'metadata'; ref: WindowsFileRef }
  | { action: 'setMetadata'; ref: WindowsFileRef; metadata: Pick<WindowsFileMetadata, 'tags' | 'projectIds' | 'revision' | 'responsible'> }
  | { action: 'watch' | 'unwatch'; ref: WindowsFileRef }
  | WindowsExplorerRequest;
export type WindowsFilesResponse<T = unknown> = { ok: true; data: T } | { ok: false; error: { code: string; message: string } };
export interface ImportedFileBytes { name: string; size: number; base64: string }
export const WINDOWS_FILES_CHANNEL = 'windows-files:invoke';
export const WINDOWS_FILES_CHANGED = 'windows-files:changed';

// ---------------------------------------------------------------------------
// Проводник Windows 11: команды моста. Интерфейс по-прежнему оперирует только
// capability {rootId, relativePath, draftId?}; абсолютный путь не покидает main.
// ---------------------------------------------------------------------------

/** Выбор человека при совпадении имён — те же три слова, что в окне Windows. */
export type WindowsFileChoice = 'replace' | 'skip' | 'keepBoth';
/** Ключ — draftId объекта плана публикации. Объект без выбора публикуется как раньше: совпадение имени — отказ EEXIST. */
export type WindowsPublishChoices = Record<string, WindowsFileChoice>;

export interface WindowsSearchFilters {
  kind?: 'file' | 'directory';
  /** Расширения без точки: ['pdf', 'docx']. */
  extensions?: string[];
  modifiedFrom?: string; modifiedTo?: string;
  sizeMin?: number; sizeMax?: number;
  /** Свойства Flux: ищутся и среди локальных тегов, и среди проектов, и среди ревизий. */
  tag?: string; projectId?: string; revision?: string;
  onlyDrafts?: boolean;
}
export interface WindowsSearchLimits { depth?: number; objects?: number; hits?: number; ms?: number }
export interface WindowsSearchHit extends WindowsFileEntry { parentPath: string }
export type WindowsSearchStop = 'complete' | 'canceled' | 'limit-hits' | 'limit-objects' | 'limit-time' | 'error';
/** Страница результатов. Последняя страница — done: true, она может быть пустой. */
export interface WindowsSearchEvent {
  requestId: string; hits: WindowsSearchHit[]; done: boolean; scanned: number; elapsedMs: number;
  reason?: WindowsSearchStop; /** Папки глубже предела не просматривались. */ depthSkipped?: number; unreadable?: number;
  error?: { code: string; message: string };
}
export interface WindowsFolderNode { name: string; relativePath: string; storage: 'flux' | 'windows'; draftId?: string; hasChildren?: boolean }

export interface WindowsQuickAccessItem { name: string; pinned: boolean; ref: WindowsFileRef }
export interface WindowsQuickAccessList { supported: boolean; items: WindowsQuickAccessItem[]; message?: string }
export interface WindowsCloudRoot { id: string; name: string; provider: 'yandex' | 'other'; icon: string | null; root: WindowsRoot }
export interface WindowsCloudRoots { supported: boolean; items: WindowsCloudRoot[]; message?: string }
export interface WindowsThumbnail { dataUrl: string; width: number; height: number; /** false — Windows дала значок типа, а не содержимое файла. */ thumbnail: boolean }
export interface WindowsOpenWithHandler { id: string; name: string; recommended: boolean; icon: string | null }
export interface WindowsShellMenuItem {
  /** Номер команды в этом меню; -1 у разделителя и у подменю без собственной команды. */
  id: number; label: string; enabled: boolean; checked?: boolean; separator?: boolean;
  /** Каноничное имя команды Windows («open», «properties», «delete»): по нему интерфейс скрывает дубли своих пунктов. */
  verb?: string; submenu?: WindowsShellMenuItem[];
}
export interface WindowsShellMenu { token: string; items: WindowsShellMenuItem[] }
export interface WindowsRecycleItem {
  id: string; name: string; /** Только подпись «Исходное расположение», открыть по ней ничего нельзя. */ location: string;
  deletedAt: string | null; size: number | null; kind: 'file' | 'directory' | 'other';
}
export interface WindowsRecycleBin { supported: boolean; items: WindowsRecycleItem[]; message?: string; /** При отказе помощника интерфейс открывает системную корзину командой openRecycleBin. */ fallback?: 'openRecycleBin' }
export interface WindowsImportCollision { index: number; name: string; kind: 'file' | 'directory'; incoming: { size: number; modifiedAt: string }; existing: { size: number; modifiedAt: string; kind: 'file' | 'directory' } }
export interface WindowsImportResult {
  imported: { name: string; ref: WindowsFileRef }[]; collisions: WindowsImportCollision[];
  skipped: string[]; failed: { name: string; code: string; message: string }[]; /** true — все объекты обработаны, билет погашен. */ complete: boolean;
}
export interface WindowsUndoLabel { id: string; label: string; at: string }
export interface WindowsUndoState { undo: WindowsUndoLabel | null; redo: WindowsUndoLabel | null }
export interface WindowsUndoResult { label: string; state: WindowsUndoState }
export interface WindowsPublishPlanItem {
  draftId: string; name: string; kind: 'file' | 'directory'; /** Куда ляжет объект по умолчанию, относительно корня. */ targetPath: string;
  status: 'free' | 'collision' | 'blocked';
  /** Свободное имя в стиле Windows: «Отчёт (2).docx». */ suggestedName?: string;
  existing?: { kind: 'file' | 'directory' | 'other'; size: number; modifiedAt: string };
  /** false — на месте объекта лежит другой вид (папка вместо файла): заменить нельзя, остаётся «оставить оба» или «пропустить». */
  replaceable?: boolean;
  reason?: string; /** Объект внутри папки, у которой уже есть одноимённая в Windows: проверен по содержимому существующей папки, как при слиянии. */ underMergedFolder?: boolean;
}
export interface WindowsPublishPlan { ref: WindowsFileRef; items: WindowsPublishPlanItem[]; collisions: number; blocked: number; truncated: boolean }

export type WindowsExplorerRequest =
  | { action: 'search'; ref: WindowsFileRef; requestId: string; query: string; filters?: WindowsSearchFilters; limits?: WindowsSearchLimits }
  | { action: 'searchCancel'; requestId: string }
  | { action: 'children'; ref: WindowsFileRef; peek?: boolean }
  | { action: 'quickAccess' }
  | { action: 'quickAccessPin'; ref: WindowsFileRef; pinned: boolean }
  | { action: 'cloudRoots' }
  | { action: 'thumbnail'; ref: WindowsFileRef; size: number; thumbnailOnly?: boolean }
  | { action: 'openWithList'; ref: WindowsFileRef }
  | { action: 'openWith'; ref: WindowsFileRef; handlerId: string }
  | { action: 'shellMenu'; refs: WindowsFileRef[]; extended?: boolean }
  | { action: 'shellMenuInvoke'; token: string; commandId: number; label: string }
  | { action: 'shellMenuClose'; token: string }
  | { action: 'recycleBin' }
  | { action: 'recycleBinRestore' | 'recycleBinPurge'; ids: string[] }
  | { action: 'recycleBinEmpty' }
  | { action: 'startDrag'; refs: WindowsFileRef[] }
  | { action: 'importPaths'; ticket: string; parent: WindowsFileRef; resolutions?: Record<string, WindowsFileChoice>; group?: string }
  | { action: 'undoState' } | { action: 'undo' } | { action: 'redo' }
  | { action: 'publishPlan'; ref: WindowsFileRef }
  | { action: 'viewStateGet'; keys: string[] }
  | { action: 'viewStateSet'; entries: Record<string, unknown> }
  | { action: 'viewStateDelete'; keys: string[] };

/** Событие потока поиска: страницы результатов приходят отдельно от ответа на команду. */
export const WINDOWS_FILES_SEARCH = 'windows-files:search';
/** preload → main: пути файлов, которые человек бросил в окно. В renderer эта дверь не открыта. */
export const WINDOWS_FILES_DROP = 'windows-files:drop-paths';
