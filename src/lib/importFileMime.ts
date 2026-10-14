const MIME_BY_EXTENSION: Record<string, string> = {
  bmp: 'image/bmp', csv: 'text/csv', gif: 'image/gif', jpeg: 'image/jpeg', jpg: 'image/jpeg', json: 'application/json', svg: 'image/svg+xml',
  pdf: 'application/pdf', png: 'image/png', tif: 'image/tiff', tiff: 'image/tiff', tmx: 'application/xml', txt: 'text/plain',
  tsv: 'text/tab-separated-values', webp: 'image/webp', xls: 'application/vnd.ms-excel', xlsm: 'application/vnd.ms-excel.sheet.macroEnabled.12',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', xml: 'application/xml', zip: 'application/zip',
  doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
};

/** Файлы из системного окна должны иметь тот же MIME, что и обычный input[type=file]. */
export function importFileMime(name: string): string {
  const extension = name.split('.').pop()?.toLowerCase() || '';
  return MIME_BY_EXTENSION[extension] || '';
}
