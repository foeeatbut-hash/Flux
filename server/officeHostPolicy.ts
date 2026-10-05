/** Office-host IPC policy for the GenOffice renderers only. */
export type HostApp = 'pdf' | 'sheets';

/** Channel tokens used by GenOffice AI, provider, MCP and image/search APIs. */
export function isGenOfficeAIChannel(channel: string): boolean {
  return /(?:^|[:_-])(?:ai|gsk|genspark|copilot|assistant|mcp)(?:$|[:_-])|(?:^|[:_-])(?:web-search|image-search|fetch-image|generate-image|media-understanding|create-document)(?:$|[:_-])/i.test(String(channel || ''));
}

/** All renderer-to-host calls are checked here, including direct frame messages. */
export const OFFICE_HOST_ALLOWED: Record<HostApp, (channel: string) => boolean> = {
  pdf: (channel) => !isGenOfficeAIChannel(channel) && channel.startsWith('pdf:') && ![
    'pdf:ocr-page', 'pdf:create-document', 'pdf:convert-office', 'pdf:request-redaction-copy',
  ].includes(channel),
  sheets: (channel) => !isGenOfficeAIChannel(channel) && (
    (channel.startsWith('workbook:') && !['workbook:export-pdf', 'workbook:print'].includes(channel))
    || ['sheets:consume-new-blank', 'sheets:has-queued-workbook', 'sheets:consume-headless-export'].includes(channel)
  ),
};
