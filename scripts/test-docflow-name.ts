/**
 * Проверка имени файла по маске проекта (docs/docflow-program.md, 4.2) —
 * общий модуль Проводника, ДО и сервера: shared/docflow/nameMask.ts.
 */
import assert from 'node:assert/strict';
import { DEFAULT_DOCFLOW_CONFIG, normalizeDocflowConfig, legacyMask, diffSections, mergeSections } from '../shared/docflow/config';
import { parseFileName, checkName, buildFileName, maskErrors, folderPath, rowFields, isIgnored, revisionValid } from '../shared/docflow/nameMask';

let passed = 0;
const check = (label: string, ok: unknown, detail?: unknown) => {
  assert.ok(ok, `${label}${detail === undefined ? '' : `: ${JSON.stringify(detail)}`}`);
  passed++;
};
const cfg = normalizeDocflowConfig({});
const row = { contractorNo: '3700-B01-E02-001', vdrCode: 'E02', revision: 'A', language: 'RU', tags: ['П-1'] };

// ── Разбор ──
const parsed = parseFileName(cfg, '3700-B01-E02-001_B.pdf');
check('имя по маске разбирается до полей', parsed.ok && parsed.fields['заказ'] === '3700' && parsed.fields['тип'] === 'E02' && parsed.fields['номер'] === '001' && parsed.fields['ред'] === 'B' && parsed.fields['шифр'] === '3700-B01-E02-001', parsed);
check('расширение отделяется', parsed.ext === '.pdf' && parsed.base === '3700-B01-E02-001_B');
const noRev = parseFileName(cfg, '3700-B01-E02-001.pdf');
check('нет ревизии — подсказка «нет поля Ревизия»', !noRev.ok && noRev.problems.some((p) => /Ревизия/.test(p)), noRev.problems);
const unknownType = parseFileName(cfg, '3700-B01-E2-001_B.pdf');
check('неизвестный тип назван', unknownType.ok && unknownType.problems.includes('неизвестный тип «E2»'), unknownType.problems);
check('совсем чужое имя — понятный отказ', !parseFileName(cfg, 'Отчёт за май.docx').ok);

// ── Сверка со строкой ──
const good = checkName(cfg, '3700-B01-E02-001_A.pdf', row);
check('совпавшее имя связывается', good.ok && !good.blocking.length && !good.isNewRevision, good.fields);
const newer = checkName(cfg, '3700-B01-E02-001_B.pdf', row);
check('новая ревизия не блокирует, а отмечается', newer.ok && newer.isNewRevision && newer.revision === 'B');
const otherType = checkName(cfg, '3700-B01-C32-001_A.pdf', { ...row, contractorNo: '3700-B01-C32-001' });
check('другой тип блокирует и объясняет по полям', !otherType.ok && otherType.blocking.some((f) => f.text === 'в имени тип C32, в строке E02'), otherType.blocking);
const otherCipher = checkName(cfg, '3700-B01-E02-002_A.pdf', row);
check('другой шифр блокирует', !otherCipher.ok && otherCipher.blocking.some((f) => f.field === 'шифр'));
const badRev = checkName(cfg, '3700-B01-E02-001_B7Q.pdf', row);
check('ревизия не по схеме блокирует', !badRev.ok && badRev.blocking.some((f) => f.field === 'ред'), badRev.fields);
const notMask = checkName(cfg, 'чертёж.pdf', row);
check('имя не по маске не связывается', !notMask.ok && notMask.blocking.length > 0);
check('кириллица в шифре не мешает (омоглифы)', checkName(cfg, '3700-В01-Е02-001_А.pdf', row).ok);
const tagged = normalizeDocflowConfig({ masks: { file: '{шифр}_{ред}_{тег}' } });
const tagWarn = checkName(tagged, '3700-B01-E02-001_A_П-2.pdf', row);
check('необязательное поле расходится — предупреждение, связь можно', tagWarn.ok && tagWarn.warnings.some((w) => w.field === 'тег'), tagWarn.fields);
const parts = normalizeDocflowConfig({ masks: { file: '{заказ}-{установка}-{тип}-{номер}_{ред}', cipher: '{заказ}-{установка}-{тип}-{номер}' } });
check('шифр собирается из частей, если в маске имени нет {шифр}', checkName(parts, '3700-B01-E02-001_A.pdf', row).ok && !checkName(parts, '3700-B02-E02-001_A.pdf', row).ok);

// ── Сборка имени и папок ──
check('правильное имя собирается из строки', buildFileName(cfg, row, '.pdf') === '3700-B01-E02-001_A.pdf');
check('и для новой ревизии', buildFileName(cfg, row, '.pdf', 'B') === '3700-B01-E02-001_B.pdf');
check('без шифра имя не собирается', buildFileName(cfg, { ...row, contractorNo: '' }, '.pdf') === '');
check('папка по маске структуры', folderPath(cfg.folders.returns, rowFields(cfg, row, 'B')) === 'E02/3700-B01-E02-001/B');
check('ошибочные сегменты папки не меняются молча', folderPath('{тип}/{шифр}', { тип: 'CON', шифр: 'имя. ' }) === 'CON/имя. ');
const unsafeName = normalizeDocflowConfig({ masks: { file: '{шифр}' } });
check('недопустимые символы имени не заменяются молча', buildFileName(unsafeName, { ...row, contractorNo: 'имя?' }, '.pdf') === 'имя?.pdf');
check('поля шифра раскладываются обратно', rowFields(cfg, row).заказ === '3700');

// ── Маски и правила ──
check('ошибка маски: неизвестное поле', maskErrors('{шифр}_{рев}').some((e) => /рев/.test(e)));
check('ошибка маски: поля без разделителя', maskErrors('{тип}{номер}').length > 0);
check('шифр не содержит ревизию', maskErrors('{тип}-{ред}', 'cipher').length > 0);
check('исправная маска без ошибок', maskErrors(cfg.masks.file).length === 0 && maskErrors(cfg.masks.cipher, 'cipher').length === 0);
check('служебные файлы — «не документ»', isIgnored(cfg, '~$чертёж.docx') && isIgnored(cfg, 'старое.BAK') && !isIgnored(cfg, '3700-B01-E02-001_A.pdf'));
check('особые ревизии по схеме', revisionValid(cfg, 'V') && revisionValid(cfg, '0') && !revisionValid(cfg, 'A-1'));

// ── Прежний стандарт и перенос ──
check('метки прежнего стандарта переводятся', legacyMask('{docNo}_{rev}_{lang}') === '{шифр}_{ред}_{язык}');
const legacy = normalizeDocflowConfig({ fileNameMask: '{docNo}_{rev}', vdrTypes: [{ code: 'K32', titleRu: 'Паспорт' }], reviewCodes: [{ code: 'A', label: 'ok', action: 'accept', deadlineDays: 7 }] });
check('прежний стандарт читается как настройки проекта', legacy.masks.file === '{шифр}_{ред}' && legacy.vdrTypes[0].code === 'K32' && legacy.statuses.length === DEFAULT_DOCFLOW_CONFIG.statuses.length);
const merged = mergeSections(cfg, legacy, ['types']);
check('перенос только отмеченных разделов', merged.vdrTypes[0].code === 'K32' && merged.reviewCodes[0].code === cfg.reviewCodes[0].code);
const diff = diffSections(cfg, merged);
check('предпросмотр различий называет изменения', diff.find((d) => d.key === 'types')!.lines.includes('добавится K32') && diff.find((d) => d.key === 'reviewCodes')!.lines.length === 0, diff);

console.log(`Проверка имени по маске: ${passed} проверок прошли`);
