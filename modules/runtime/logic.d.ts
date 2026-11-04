declare module 'module-logic' {
  export function recalc(api: import('../contract').ModuleApi): Promise<unknown>;
}
