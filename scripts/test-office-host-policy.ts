import assert from 'node:assert/strict';
import { isGenOfficeAIChannel, OFFICE_HOST_ALLOWED } from '../server/officeHostPolicy.js';

const denied = [
  'ai:chat', 'ai:stream-chunk', 'ai:image-search', 'app:get-ai-panel-prefs',
  'docs:consume-ai-doc-content', 'sheets:ai-generate-image', 'sheets:mcp-command',
  'workbook:ai-translate', 'workbook:create-document', 'pdf:generate-image',
  'pdf:ai-summarize', 'pdf:copilot:run',
];
for (const channel of denied) {
  assert.equal(isGenOfficeAIChannel(channel), true, `${channel} was not identified as GenOffice AI`);
  assert.equal(OFFICE_HOST_ALLOWED.sheets(channel), false, `Sheets gateway allowed ${channel}`);
  assert.equal(OFFICE_HOST_ALLOWED.pdf(channel), false, `PDF gateway allowed ${channel}`);
}

for (const channel of ['workbook:save', 'workbook:read-range', 'pdf:save', 'pdf:page-preview-png']) {
  assert.equal(isGenOfficeAIChannel(channel), false, `${channel} was mistaken for AI`);
}
for (const channel of ['workbook:save', 'workbook:read-range']) assert.equal(OFFICE_HOST_ALLOWED.sheets(channel), true);
for (const channel of ['pdf:save', 'pdf:page-preview-png']) assert.equal(OFFICE_HOST_ALLOWED.pdf(channel), true);

console.log('Office gateway rejects current and prefixed GenOffice AI channels; normal read/save channels remain allowed.');
