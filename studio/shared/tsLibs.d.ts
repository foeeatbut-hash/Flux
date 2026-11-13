/** Стандартная библиотека TypeScript (lib.*.d.ts), встроенная в рабочий поток сверки типов при сборке (studio/build-assets.cjs) */
declare module 'virtual:ts-libs' {
  const libs: Record<string, string>;
  export default libs;
}
