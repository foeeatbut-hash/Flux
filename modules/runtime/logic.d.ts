declare module 'module-logic' {
  export function setup(api: import('../contract').ModuleApi): void | Promise<void>;
}
