/** Виртуальный модуль: build.cjs подставляет настоящий раздел редакторов или заглушку (см. editorsEntry) */
declare module 'studio-editors' {
  import type { ComponentType } from 'react';
  import type { EditorProps } from '../shared/editorContract';
  const Editors: ComponentType<EditorProps>;
  export default Editors;
}
