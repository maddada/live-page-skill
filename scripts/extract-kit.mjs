#!/usr/bin/env node
// Maintainers only: refresh skills/live-page/kit/ghostex-kit.html from a page Ghostex exported.
//
//   ghostex visual guide example > example.html
//   ghostex visual export example.html --out exported.html
//   node scripts/extract-kit.mjs exported.html
//
// It keeps the theme, the page API, the question kit and the fit script Ghostex inlines into an
// exported page, drops the export marker, the content policy and the page's own state, and puts a
// `<!--live-page:state-->` marker where live-page.mjs adds each page's state when it serves it.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const [input] = process.argv.slice(2);
if (!input) {
  console.error('usage: node scripts/extract-kit.mjs <exported.html>');
  process.exit(1);
}
const html = fs.readFileSync(input, 'utf8');
const blocks = [];
const re = /<(script|style)([^>]*)>([\s\S]*?)<\/\1>/g;
let m;
while ((m = re.exec(html))) blocks.push({ tag: m[1], attrs: m[2], body: m[3], text: m[0] });

const themeAt = blocks.findIndex((b) => b.tag === 'style' && /id="ghostex-theme"/.test(b.attrs));
const fitAt = blocks.findIndex((b) => b.tag === 'style' && /id="ghostex-fit"/.test(b.attrs));
if (themeAt < 0 || fitAt < 0) {
  console.error('not an exported Ghostex page: no ghostex-theme or ghostex-fit block');
  process.exit(1);
}
const parts = [];
for (const b of blocks.slice(themeAt, fitAt + 2)) {
  if (b.tag === 'script' && /ghostex\.__state\(/.test(b.body) && b.body.length < 400) {
    parts.push('<!--live-page:state-->');
    continue;
  }
  parts.push(b.text);
}
if (!parts.includes('<!--live-page:state-->')) {
  console.error('no page state script found between the page API and the kit');
  process.exit(1);
}
const header =
  '<!-- Ghostex page kit (theme, page API, question kit, fit), from Ghostex (https://github.com/maddada/Ghostex), MIT License, Copyright 2026 Mohamad Yahia (maddada). See NOTICE.md next to this file. -->';
const body = parts.join('\n');
// The repo checks refuse em dashes; rewriting them here could change the kit's code, so stop instead.
if (body.includes('\u2014')) {
  console.error('the exported kit holds an em dash: check where, and refresh the kit by hand');
  process.exit(1);
}
const out = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'skills', 'live-page', 'kit', 'ghostex-kit.html');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, header + '\n' + body + '\n');
console.log(`wrote ${path.relative(process.cwd(), out)} (${fs.statSync(out).size} bytes)`);
