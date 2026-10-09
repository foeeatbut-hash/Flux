/** Проверяет тихое обновление списка Builder без потери открытой ведомости. */
import assert from 'node:assert/strict';
import { catalogService, type SelectionList } from '../src/services/catalogService';
import { useBuilderStore } from '../src/store/builderStore';

const sample = (id: string): SelectionList => ({
  id, projectId: 'p1', classId: 'valve', name: id, header: {}, orderNos: {},
  templateId: null, lang: 'ru', updatedAt: '2026-10-09T00:00:00.000Z',
});

async function main() {
  const original = catalogService.lists;
  try {
    let requested = '';
    catalogService.lists = async (projectId) => { requested = projectId; return { lists: [sample('l1'), sample('l2')] }; };
    const item: any = { id: 'item-1', sort: 1, qty: 4 };
    useBuilderStore.setState({ projectId: 'p1', lists: [sample('l1')], listId: 'l1', list: sample('l1'), items: [item], loading: false, saving: false });
    await useBuilderStore.getState().refreshLists();
    const state = useBuilderStore.getState();
    assert.equal(requested, 'p1');
    assert.deepEqual(state.lists.map((l) => l.id), ['l1', 'l2']);
    assert.equal(state.listId, 'l1');
    assert.deepEqual(state.list, sample('l1'));
    assert.deepEqual(state.items, [item]);
    assert.equal(state.loading, false);
    console.log('✓ список обновлён без переключения или затирания открытой ведомости');
  } finally {
    catalogService.lists = original;
  }
}

void main();
