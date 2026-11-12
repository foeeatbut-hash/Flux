/**
 * «Новая программа» одним диалогом: название, язык расчётов, вид, пример — и сразу открывается рабочее окно
 * с проектом, который запускается. Идентификатор получается из названия сам (дополнительно его можно поправить).
 */
import React, { useState } from 'react';
import { call } from '../call';
import Modal from './Modal';
import { slugFromName } from './helpers';

const LANGUAGES: Array<[string, string]> = [
  ['typescript', 'JavaScript / TypeScript'], ['python', 'Python'], ['c', 'C'], ['cpp', 'C++'], ['rust', 'Rust'], ['go', 'Go'], ['csharp', 'C#'],
];
const SAMPLES: Array<[string, string, string]> = [
  ['none', 'Пустая заготовка', 'Небольшой рабочий пример, который можно переписать под себя.'],
  ['calc', 'Калькулятор с графиком', 'Свой экран: поле ввода, таблица и график; расчёт на выбранном языке.'],
  ['translator', 'Переводчик терминов', 'Готовая программа с формой и словарём (TypeScript).'],
];

export default function NewProgram({ onClose, onCreated }: { onClose: () => void; onCreated: (id: string) => void }) {
  const [name, setName] = useState('');
  const [language, setLanguage] = useState('typescript');
  const [kind, setKind] = useState<'form' | 'page'>('form');
  const [sample, setSample] = useState('calc');
  const [idText, setIdText] = useState('');
  const [more, setMore] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const id = idText || slugFromName(name);
  const translator = sample === 'translator', calc = sample === 'calc';

  const create = async (chooseFolder: boolean) => {
    setBusy(true); setError('');
    try {
      const made = await call<{ id: string; canceled?: boolean }>('draftCreate', {
        template: translator ? 'translator' : language, kind: calc ? 'page' : translator ? 'form' : kind, id, name: name.trim(), chooseFolder,
      });
      if (!made.canceled) onCreated(made.id);
    } catch (e) { setError((e as Error).message); }
    setBusy(false);
  };

  return (
    <Modal title="Новая программа" onClose={onClose}>
      <form onSubmit={e => { e.preventDefault(); if (id && name.trim()) void create(false); }}>
        <div className="field"><label htmlFor="np-name">Название</label>
          <input id="np-name" className="fx-input" value={name} maxLength={80} placeholder="Например, Расчёт нагрузки" onChange={e => setName(e.target.value)} /></div>
        <div className="field"><label htmlFor="np-sample">С чего начать</label>
          <select id="np-sample" className="fx-input" value={sample} onChange={e => setSample(e.target.value)}>
            {SAMPLES.map(([v, t]) => <option key={v} value={v}>{t}</option>)}</select>
          <p className="fx-hint">{SAMPLES.find(s => s[0] === sample)?.[2]}</p></div>
        {!translator && <div className="grid">
          <div className="field"><label htmlFor="np-lang">Язык расчётов</label>
            <select id="np-lang" className="fx-input" value={language} onChange={e => setLanguage(e.target.value)}>
              {LANGUAGES.map(([v, t]) => <option key={v} value={v}>{t}</option>)}</select></div>
          {!calc && <div className="field"><label htmlFor="np-kind">Как выглядит программа</label>
            <select id="np-kind" className="fx-input" value={kind} onChange={e => setKind(e.target.value as 'form' | 'page')}>
              <option value="form">Простая форма</option><option value="page">Свой экран (HTML, CSS, JavaScript)</option></select></div>}
        </div>}
        <button type="button" className="fx-btn fx-btn-quiet" onClick={() => setMore(!more)} aria-expanded={more}>{more ? 'Скрыть' : 'Дополнительно'}</button>
        {more && <div className="field"><label htmlFor="np-id">Имя для Flux (латиница, цифры, дефис)</label>
          <input id="np-id" className="fx-input" value={idText || id} maxLength={64} onChange={e => setIdText(e.target.value.toLowerCase())} /></div>}
        {error && <p className="fx-error" role="alert">{error}</p>}
        <div className="row studio-modal-actions">
          <button type="submit" className="fx-btn fx-btn-primary" disabled={busy || !id || !name.trim()}>{busy ? 'Создаём…' : 'Создать'}</button>
          <button type="button" className="fx-btn" disabled={busy || !id || !name.trim()} onClick={() => void create(true)}>Создать в выбранной папке…</button>
          <button type="button" className="fx-btn fx-btn-quiet" onClick={onClose}>Отмена</button>
        </div>
        <p className="fx-hint">Программа — обычная папка с файлами. По умолчанию она появится в папке Studio, а можно выбрать свою.</p>
      </form>
    </Modal>
  );
}
