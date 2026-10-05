import React from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import NotesManagement from '../../../../src/screens/NotesManagement';
import { useStore } from '../../../../src/store/store';
import { useModalStore } from '../../../../src/store/modalStore';
import './fixture.css';

const now = Date.now();
const iso = (delta: number) => new Date(now + delta).toISOString();
let notes: any[] = [
  { id: 'note-zulu', title: 'Zulu fixture', content: 'Only owner text', color: 'bg-amber-50 dark:bg-amber-950/20 border-amber-200', groupName: 'Existing group', createdAt: iso(-3000), updatedAt: iso(-3000), ownerId: 'files-notes-ui-user', mine: true, canEdit: true, sharedWith: [] },
  { id: 'note-alpha', title: 'Alpha fixture', content: 'Searchable unique phrase', color: 'bg-amber-50 dark:bg-amber-950/20 border-amber-200', groupName: null, createdAt: iso(-2000), updatedAt: iso(-2000), ownerId: 'files-notes-ui-user', mine: true, canEdit: true, sharedWith: [] },
  { id: 'note-group-buddy', title: 'Group buddy fixture', content: 'Another item in the same group', color: 'bg-amber-50 dark:bg-amber-950/20 border-amber-200', groupName: 'Existing group', createdAt: iso(-1500), updatedAt: iso(-1500), ownerId: 'files-notes-ui-user', mine: true, canEdit: true, sharedWith: [] },
  { id: 'note-shared', title: 'Shared fixture', content: 'Read-only colleague note', color: 'bg-rose-50 dark:bg-rose-950/20 border-rose-200', groupName: null, createdAt: iso(-1000), updatedAt: iso(-1000), ownerId: 'another-user', mine: false, canEdit: false, sharedWith: [] },
  { id: 'note-legacy', title: 'Legacy fixture', content: 'Old common note', color: 'bg-amber-50 dark:bg-amber-950/20 border-amber-200', groupName: null, createdAt: iso(-500), updatedAt: iso(-500), ownerId: null, mine: false, legacy: true, canEdit: true, sharedWith: [] },
];
let nextId = 1;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
(window as any).__notesFixture = { get notes() { return notes.map(note => ({ ...note })); } };
(window as any).fetch = async (input: string | URL, init?: RequestInit) => {
  const url = new URL(String(input), location.href);
  const path = url.pathname.replace(/^.*\/api/, '');
  const method = init?.method || 'GET';
  const payload = init?.body ? JSON.parse(String(init.body)) : {};
  if (path === '/notes' && method === 'GET') return json({ notes: notes.map(note => ({ ...note })) });
  if (path === '/notes' && method === 'POST') {
    const note = { ...payload, id: `note-new-${nextId++}`, ownerId: 'files-notes-ui-user', mine: true, canEdit: true, legacy: false, sharedWith: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    notes = [note, ...notes];
    return json({ note });
  }
  const match = path.match(/^\/notes\/([^/]+)$/);
  if (match) {
    const id = decodeURIComponent(match[1]);
    const index = notes.findIndex(note => note.id === id);
    if (method === 'GET') return index >= 0 ? json({ note: { ...notes[index] } }) : json({ error: 'not found' }, 404);
    if (method === 'PATCH' && index >= 0) {
      notes[index] = { ...notes[index], ...payload, updatedAt: new Date().toISOString() };
      return json({ note: { ...notes[index] } });
    }
    if (method === 'DELETE' && index >= 0) { notes = notes.filter(note => note.id !== id); return json({ success: true }); }
  }
  if (path === '/logs' && method === 'POST') return json({ log: { id: 'fixture-log' } });
  if (/\/projects\/[^/]+\/tags$/.test(path)) return json({ tags: [] });
  return json({ error: `unhandled fixture request ${method} ${path}` }, 404);
};
useStore.setState({ user: { id: 'files-notes-ui-user', name: 'Synthetic Notes Tester', symbol: 'SNT', role: 'ENGINEER_VENT' } as any, activeProject: null });
useModalStore.getState().openConfirm = async () => true;
createRoot(document.getElementById('mount')!).render(<MemoryRouter initialEntries={['/notes']}><NotesManagement /></MemoryRouter>);
