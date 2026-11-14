/**
 * Полный запуск программы в Studio, главный процесс: подключения, вторая программа и файл пользователю.
 *
 * Сюда сходятся действия `runConnect`, `runConnectAnswer`, `runProgram`, `runSaveFile`, `runStorage*`, `testPrograms`, `testProgramInstall`,
 * `testProgramRemove` (договор — studio/shared/runActions.ts); сама служба разработчика (developer.ts) держит только запуск и
 * передаёт сюда, какая программа сейчас запущена. Данные Flux отсюда недостижимы: решения и журнал — в памяти, вторая программа
 * собирается из черновика и живёт в памяти оболочки.
 */
import type { ModuleManifest } from '../../modules/contract';
import { languageOf } from '../../modules/engine/types';
import { MODULE_VERSION } from '../../modules/trust/claims';
import { parseExports } from '../../modules/programs/model';
import type { ComBackend } from '../../electron/moduleCom';
import type { Lookup } from '../../electron/moduleNet';
import type { ControlsEngine } from '../shared/controlsEngine';
import type { RunEvent, RunProgramReply, RunSaveReply, TestProgramRow } from '../shared/runActions';
import type { ProjectFiles } from '../shared/templates';
import { StudioFailure } from './api';
import { RunConnections, type RunContext } from './runConnections';
import { RunJournal } from './runJournal';
import { RunPrograms } from './runPrograms';
import { RunFileSaver, type SaveDialog } from './runSaveFile';
import { RunStorage } from './runStorage';

export interface RunHostDeps {
  current: () => (RunContext & { name: string }) | null;
  emit: (event: RunEvent) => void;
  engine: ControlsEngine;
  /** Собранный проект: так же, как для «Запустить во Flux» (TypeScript собран, страница и логика проверены); отказ — StudioFailure словами */
  build: (id: string) => Promise<{ manifest: ModuleManifest; files: ProjectFiles }>;
  /** Черновики на этом компьютере: идентификатор и манифест (null — не читается) */
  drafts: () => Array<{ id: string; manifest: ModuleManifest | null }>;
  com?: () => ComBackend;
  lookup?: Lookup;
  askTimeoutMs?: number;
  pickSaveFile?: SaveDialog;
  /** Данные Studio и версия: хранилище самостоятельной программы (область `studio`) лежит в `program-data` рядом с ними */
  storage: { dir: string; version: string };
}

export class RunHost {
  readonly journal = new RunJournal();
  readonly connections: RunConnections;
  readonly programs: RunPrograms;
  private readonly saver: RunFileSaver;
  readonly storage: RunStorage;

  constructor(private readonly deps: RunHostDeps) {
    this.connections = new RunConnections({ current: deps.current, emit: deps.emit, journal: this.journal, com: deps.com, lookup: deps.lookup, askTimeoutMs: deps.askTimeoutMs });
    this.programs = new RunPrograms({ current: deps.current, engine: deps.engine, journal: this.journal });
    this.saver = new RunFileSaver(deps.pickSaveFile);
    this.storage = new RunStorage({ ...deps.storage, current: deps.current });
  }

  /** Список «вторая программа»: все свои черновики; вызвать можно только установленные */
  private rows(): TestProgramRow[] {
    const rows: TestProgramRow[] = [];
    for (const { id, manifest } of this.deps.drafts()) {
      if (!manifest) continue;
      rows.push({
        id, name: String(manifest.name || id), version: String(manifest.version || ''), language: languageOf(manifest),
        exports: (parseExports(manifest.exports) ?? []).map(e => ({ method: e.method, does: e.does })), installed: this.programs.isInstalled(id),
      });
    }
    return rows;
  }

  private async install(id: string): Promise<void> {
    // Собирается так же, как для «Запустить во Flux»: что не собралось, то и не «установлено»
    const { manifest, files } = await this.deps.build(id);
    if (parseExports(manifest.exports) === null) throw new StudioFailure('Раздел exports в manifest.json задан неверно: у метода нужны имя из латинских букв и цифр и описание словами.');
    if (!MODULE_VERSION.test(String(manifest.version))) throw new StudioFailure('Версия в manifest.json должна быть вида 1.0.0.');
    this.programs.install({ manifest, files });
  }

  async handle(action: string, args: Record<string, any>): Promise<unknown> {
    switch (action) {
      case 'runConnect': return this.connections.call(args);
      case 'runConnectAnswer': return { answered: this.connections.answer(args.id, args.decision) };
      case 'runProgram': return this.programs.call(args) satisfies Promise<RunProgramReply>;
      case 'runSaveFile': {
        const run = this.deps.current();
        if (!run) throw new StudioFailure('Программа не запущена.');
        return this.saver.save(run.name, args) satisfies Promise<RunSaveReply>;
      }
      case 'runStorageInfo': return this.storage.info();
      case 'runStorageLoad': return this.storage.load();
      case 'runStorageKeep': return this.storage.keep(args.state);
      case 'runStorageClear': return this.storage.clear();
      case 'testPrograms': return this.rows();
      case 'testProgramInstall': { await this.install(String(args.id)); return this.rows(); }
      case 'testProgramRemove': { this.programs.remove(String(args.id)); return this.rows(); }
      default: throw new StudioFailure('Недоступное действие.');
    }
  }

  /** Запуск закрыт: подключения и объекты COM этого запуска закрыты, вопросы сняты */
  closeRun(runId: string): Promise<void> { return this.connections.closeRun(runId); }

  /** Выход из Studio */
  shutdown(): Promise<void> { return this.connections.shutdown(); }
}
