import 'electron'

declare module 'electron' {
  export function isFluxCopySave(): boolean
  export function commitFluxSave(): Promise<void>

  export const __flux: {
    withDataDir<T>(path: string | undefined, fn: () => T): T
    setDataDir(wcId: number, path: string): void
    withSaveTarget<T>(path: string, fn: () => Promise<T>): Promise<T>
    withSaveCommit<T>(commit: () => Promise<void>, fn: () => Promise<T>): Promise<T>
    invoke(wcId: number, channel: string, args: unknown[]): Promise<unknown>
    send(wcId: number, channel: string, args: unknown[]): void
    onSend(fn: (wcId: number, channel: string, args: unknown[]) => void): () => void
    destroy(wcId: number): void
    channels(): string[]
  }
}
