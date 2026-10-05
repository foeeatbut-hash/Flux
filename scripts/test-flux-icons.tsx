import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { FileIcon, IconBadges, iconBadgeSize } from '../src/components/icons/FluxIcons';

for (const size of [24, 32, 48]) {
  const badge = iconBadgeSize(size);
  assert.ok(badge * 2 <= size, `corner badges fit at ${size}px`);
  assert.equal(renderToStaticMarkup(<IconBadges size={size} flux shared><FileIcon kind="folder" size={size} /></IconBadges>).match(/aria-label="(?:Файл Flux|Общий файл)"/g)?.length, 2);
}

for (const kind of ['folder', 'this-pc', 'bin', 'word', 'excel', 'pdf', 'unknown'] as const) {
  for (const size of [24, 32, 48]) {
    const markup = renderToStaticMarkup(<FileIcon kind={kind} size={size} />);
    assert.match(markup, new RegExp(`width="${size}"`), `${kind} scales to ${size}px`);
    assert.match(markup, /aria-hidden="true"/);
  }
}
