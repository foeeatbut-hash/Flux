/**
 * Поддельный COM для проверок на любой ОС: те же вызовы, что у помощника Windows
 * (open / invoke / release), но объекты — обычные JS-объекты. Имитирует
 * Scripting.FileSystemObject только строковыми методами без побочных эффектов и
 * объект с вложенными объектами и ref-параметром, как у E3 (Job.GetAllDeviceIds).
 */
import { ConnectError } from '../../modules/connections/model';
import type { ComBackend } from '../../electron/moduleCom';

export class FakeCom implements ComBackend {
  calls: Array<{ kind: string; name: string }> = [];
  released: number[] = [];
  private next = 0;
  private objects = new Map<number, any>();
  available() { return true; }
  async open(progId: string) {
    if (progId === 'Scripting.FileSystemObject') return this.put(this.fso());
    if (progId === 'CT.Application') return this.put(this.app());
    throw new ConnectError('FAILED', 'unknown progId');
  }
  private put(o: any) { this.objects.set(++this.next, o); return this.next; }
  private fso() {
    return {
      GetBaseName: (p: string) => String(p).replace(/^.*[\\/]/, '').replace(/\.[^.]*$/, ''),
      BuildPath: (a: string, b: string) => `${a}\\${b}`,
    };
  }
  private app() {
    const put = (o: any) => this.put(o);
    return {
      Version: '2023', Title: 'old',
      CreateJob: () => ({ $object: put({ GetIds: (out: number[]) => { out.push(10, 20, 30); return 3; } }) }),
    };
  }
  async invoke(handle: number, kind: 'call' | 'get' | 'set', name: string, args: unknown[], value?: unknown) {
    this.calls.push({ kind, name });
    const target = this.objects.get(handle);
    if (!target) throw new ConnectError('FAILED', 'no object');
    if (kind === 'set') { target[name] = value; return null; }
    if (kind === 'get') return target[name] ?? null;
    if (typeof target[name] !== 'function') throw new ConnectError('FAILED', 'no method');
    // Ref-параметры: `{$out:true}` заменяется местом для ответа, как ParameterModifier в помощнике
    const isOut = (a: unknown) => !!a && typeof a === 'object' && (a as any).$out === true;
    const real = args.map(a => (isOut(a) ? [] : a));
    let ret = target[name](...real);
    if (ret && typeof ret === 'object' && '$object' in ret) ret = { $com: ret.$object };
    const outIdx = args.map((a, i) => (isOut(a) ? i : -1)).filter(i => i >= 0);
    return outIdx.length ? { ret, out: Object.fromEntries(outIdx.map(i => [String(i), real[i]])) } : ret;
  }
  async release(handle: number) { this.released.push(handle); this.objects.delete(handle); }
  async shutdown() { this.objects.clear(); }
}
