/** Pure query behavior against the repository's real published seed data. */
import { seedCatalog } from '../catalog/seed';
import { veza2026Pack } from '../catalog/packs/veza2026';
import { queryCatalog } from '../catalog/query';

let failed = false;
const check = (name: string, ok: boolean, detail?: unknown) => {
  if (!ok) { failed = true; console.error(`✗ ${name}`, detail ?? ''); }
  else console.log(`✓ ${name}`);
};

const catalog = seedCatalog();
const family = catalog.families.find((f) => f.code === 'КПУ-1Н')!;
const example = family.examples![1];

const nameResult = queryCatalog(catalog, 'КПУ-1Н');
check('exact family code resolves the real family', nameResult.matches.some((m) => m.familyId === family.id));
check('model answer keeps provenance internally and hides it from readers', !nameResult.answer.includes(family.catalog!.file) && nameResult.sources.some(source => source.file === family.catalog!.file));

const designationResult = queryCatalog(catalog, `Что означает маркировка ${example}?`);
check('full real designation parses and reports existing code labels', designationResult.answer.includes('ЭПВ24') && designationResult.answer.includes('Код'));
check('designation answer retains the source page reference', designationResult.sources.some((s) => s.file === family.catalog!.file && !!s.pages));

const genericSpecs = queryCatalog(catalog, 'КПУ-1Н характеристики');
check('unselected conditional values are explicitly unknown/dependent', genericSpecs.answer.includes('зависит от выбранного исполнения'));
check('known family-level value comes from the real family record', genericSpecs.answer.includes('EI 90'));

const selectedSpecs = queryCatalog(catalog, `КПУ-1Н ${example} характеристики`);
check('a parsed real variant returns its matching conditional value', selectedSpecs.answer.includes('до 2000 Па'));

const unknown = queryCatalog(catalog, 'несуществующая модель QZX-778 характеристики');
check('unknown model does not invent a specification', unknown.matches.length === 0 && !unknown.answer.includes('вольт') && !unknown.answer.includes('Па'));

const broad = queryCatalog(catalog, 'клапан');
check('broad category query surfaces ambiguity', broad.ambiguous && broad.matches.length > 1);

// Keep catalog facts and PDFs from two real seed families; add only a shared
// alias to exercise the real ambiguity path for article/free designations.
const secondFamily = catalog.families.find((f) => f.code === 'КПУ-2Н')!;
const articleCatalog = {
  ...catalog,
  families: [
    { ...family, designationMode: 'article' as const, article: 'ARTICLE-KPU1', aliases: ['SHARED-ARTICLE'] },
    { ...secondFamily, designationMode: 'article' as const, article: 'ARTICLE-KPU2', aliases: ['SHARED-ARTICLE'] },
  ],
};
const articleResult = queryCatalog(articleCatalog, 'SHARED-ARTICLE');
check('shared article alias returns both real model records as ambiguous', articleResult.ambiguous && articleResult.matches.length === 2);
check('article alias results retain a PDF source for each model', articleResult.sources.length === 2 && articleResult.sources.every((s) => !!s.file && !!s.pages));
const uniqueArticle = queryCatalog(articleCatalog, 'ARTICLE-KPU1');
check('unique article code resolves one model', !uniqueArticle.ambiguous && uniqueArticle.matches.length === 1 && uniqueArticle.matches[0].familyId === family.id);

const osaCatalog = {
  ...catalog,
  classes: [...catalog.classes, ...veza2026Pack.classes],
  manufacturers: [...catalog.manufacturers, ...veza2026Pack.manufacturers],
  families: [...catalog.families, ...veza2026Pack.families],
  components: [...catalog.components, ...veza2026Pack.components],
};
const osaQuestion = queryCatalog(osaCatalog, 'Что означает ОСА 300-050/Б-50-Н-00400/2-У1-02');
check('spaced family alias parses the complete real ОСА designation', osaQuestion.matches.some((m) => m.familyId === 'veza-osa-300'));
check('ОСА designation maps index, motor and body with their actual labels', ['Индекс колеса', 'Индекс мощности двигателя', 'Тип корпуса'].every((label) => osaQuestion.answer.includes(label)));
check('selected ОСА climate supplies its conditional temperature value', osaQuestion.answer.includes('−45…+40'));
check('ОСА marking answer cites the marking PDF page', osaQuestion.sources.some((s) => s.file === 'ОСА 300/301, осевые вентиляторы.pdf' && s.pages === '10'));
const osaUnknownCode = queryCatalog(osaCatalog, 'Что означает ОСА 300-050/Б-50-999-00400/2-У1-02');
check('unknown ОСА segment stays explicitly unresolved', osaUnknownCode.answer.includes('значение неизвестно') && !osaUnknownCode.answer.includes('Код «999»'));

const osaSelectedTable = queryCatalog(osaCatalog, 'ОСА 300 ОСА300-040/А-40-Н-00055/2-У1-01 характеристики, номер кривой 1');
check('full verified table axes return the one exact row', osaSelectedTable.answer.includes('Nном: 0.55 кВт'));
check('exact table row cites its physical PDF page rather than only the family overview', osaSelectedTable.sources.some((s) => s.file === 'ОСА 300/301, осевые вентиляторы.pdf' && s.pages === '13'));
const osaMissingAxis = queryCatalog(osaCatalog, 'ОСА300-040/А-40-Н-00055/2-У1-01 мощность двигателя');
check('table value is withheld when curve axis is missing', osaMissingAxis.answer.includes('укажите Номер кривой') && !osaMissingAxis.answer.includes('Nном: 0.55 кВт'));

const motor = catalog.components.find((c) => c.code === 'LM230')!;
const motorResult = queryCatalog(catalog, 'LM230 напряжение');
check('exact component code returns its structured actuator specifications', motorResult.matches.some((m) => m.familyId === motor.id) && motorResult.answer.includes('230 В AC'));
check('component answer cites its catalog source', motorResult.sources.some((s) => s.file === motor.catalog?.file && !!s.pages));
const tooLong = queryCatalog(catalog, 'x'.repeat(4097));
check('overlong question is rejected before catalog scanning', tooLong.matches.length === 0 && tooLong.answer.includes('4096'));

if (failed) process.exitCode = 1;
