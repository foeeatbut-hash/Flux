import { buildDocx } from './docxWrite';

export type DocflowEmptyFormat = 'docx' | 'xlsx' | 'pdf' | 'txt';

function emptyPdf(): Uint8Array {
  const encoder = new TextEncoder();
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << >> /Contents 4 0 R >>',
    '<< /Length 0 >>\nstream\n\nendstream',
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(encoder.encode(pdf).length);
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = encoder.encode(pdf).length;
  pdf += `xref\n0 ${offsets.length}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return encoder.encode(pdf);
}

/** Файл создаётся пустым: сведения проекта не попадают в его содержимое. */
export async function emptyDocflowFile(format: DocflowEmptyFormat): Promise<Uint8Array> {
  if (format === 'txt') return new Uint8Array();
  if (format === 'docx') return buildDocx([{ kind: 'para', text: '' }]);
  if (format === 'pdf') return emptyPdf();
  if (format === 'xlsx') {
    const mod = await import('exceljs');
    const ExcelJS = mod.default || mod;
    const workbook = new ExcelJS.Workbook();
    workbook.addWorksheet('Лист1');
    return new Uint8Array(await workbook.xlsx.writeBuffer());
  }
  throw new Error('Неподдерживаемый формат файла');
}
