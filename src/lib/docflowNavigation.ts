/** Старые ссылки сохраняют все параметры, чтобы открыть нужную строку реестра. */
export function docflowRedirect(search: URLSearchParams): string | null {
  const tab = search.get('tab');
  if (tab !== 'vdr' && tab !== 'docflow' && !search.get('vdr')) return null;
  const next = new URLSearchParams(search);
  next.set('tab', tab === 'docflow' ? 'settings' : 'registry');
  return `/docflow?${next.toString()}`;
}
