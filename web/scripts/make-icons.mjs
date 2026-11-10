// Renders the PWA icons from the Homecast logo (logo/homecast-app-icon.svg).
// Not part of the build; run when the logo changes:
//   npm i --no-save playwright-core && node web/scripts/make-icons.mjs [path-to-chrome]
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { chromium } from 'playwright-core';

const here = path.dirname(fileURLToPath(import.meta.url));
const source = readFileSync(path.join(here, '../../logo/homecast-app-icon.svg'), 'utf8');
if (!source.includes('translate(160 138) scale(11)')) throw new Error('logo changed: update the maskable transform in make-icons.mjs');

// "any" icons use the logo as is (rounded tile). Maskable and Apple icons are full-bleed squares with
// the glyph shrunk into the safe zone, because the OS applies its own mask.
const full = source.replace(/ rx="224"/, '');
const safe = full.replace('translate(160 138) scale(11)', 'translate(240 223) scale(8.5)');

const jobs = [
  ['icon-192.png', source, 192],
  ['icon-512.png', source, 512],
  ['icon-maskable-512.png', safe, 512],
  ['apple-touch-icon.png', safe, 180],
];
const browser = await chromium.launch({ executablePath: process.argv[2] });
const page = await browser.newPage();
for (const [file, svg, size] of jobs) {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(`<style>html,body{margin:0;background:transparent}svg{display:block;width:${size}px;height:${size}px}</style>${svg}`);
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(150);
  writeFileSync(path.join(here, '../public', file), await page.screenshot({ omitBackground: true }));
}
await browser.close();
console.log('icons written');
