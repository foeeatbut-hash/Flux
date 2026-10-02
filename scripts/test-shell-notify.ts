const values = new Map<string, string>();
Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
  getItem: (key: string) => values.get(key) ?? null,
  setItem: (key: string, value: string) => values.set(key, value),
  removeItem: (key: string) => values.delete(key),
} });
values.set('flux_snoozed', JSON.stringify({ 'legacy-reminder': Date.now() + 3600000 }));

let fail = 0;
const check = (name: string, result: boolean) => {
  if (result) console.log('  ✓', name);
  else { fail++; console.error('  ✗', name); }
};

async function run() {
  const { useShellNotifyStore } = await import('../src/store/shellNotifyStore');
  const legacy = useShellNotifyStore.getState().snoozed['legacy-reminder'];
  check('старый срок откладывания сохраняется после миграции', legacy?.until > Date.now() && !legacy.toast);

  const reminder = {
    id: 'event@2026-10-02T10:00:00.000Z', title: 'Планёрка', body: 'Через пять минут',
    route: '/calendar', source: 'reminder' as const,
    action: { label: 'Подключиться', url: 'https://company.invalid/meeting' }, category: 'СИСТЕМА',
  };
  useShellNotifyStore.getState().push(reminder);
  useShellNotifyStore.getState().snooze(reminder.id, '15m');
  const persisted = JSON.parse(values.get('flux_snoozed') || '{}')[reminder.id];
  check('отложенное напоминание хранит источник и кнопку действия',
    persisted?.toast?.source === 'reminder' && persisted.toast.action?.url === reminder.action.url);
  useShellNotifyStore.setState({ snoozed: {
    ...useShellNotifyStore.getState().snoozed,
    [reminder.id]: { until: Date.now() - 1, toast: persisted.toast },
  } });
  const released = useShellNotifyStore.getState().releaseDue();
  check('вернувшаяся карточка сохраняет маршрут и действие',
    released[0]?.toast?.route === '/calendar' && released[0]?.toast?.action?.label === 'Подключиться');
  check('просроченная запись убрана из сохранённых сроков', !useShellNotifyStore.getState().snoozed[reminder.id]);
  console.log(`\n${fail ? `✗ ${fail} провалено` : 'Все проверки пройдены'}`);
  process.exit(fail ? 1 : 0);
}
void run();
