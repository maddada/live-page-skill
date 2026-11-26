// The whole loop end to end (no browser, no agent): node --test test/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkPage, pageIdFor, formatAnswers } from '../skills/live-page/scripts/live-page.mjs';

const script = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'skills', 'live-page', 'scripts', 'live-page.mjs');
const page = (body, title = 'Settings: one page or tabs') =>
  `<!doctype html><html><head><meta charset="utf-8"><meta name="ghostex-page" content="v2"><title>${title}</title></head><body>${body}</body></html>`;

test('checkPage passes a good page and names what is wrong with a bad one', () => {
  assert.equal(checkPage(page('<gx-questions><gx-question title="Which?"><gx-choice>A</gx-choice></gx-question></gx-questions>')).ok, true);
  const bad = checkPage(page('<gx-question title="Which?"></gx-question><gx-question title="Which?"></gx-question>', 'Questions'));
  assert.equal(bad.ok, false);
  assert.ok(bad.errors.some((e) => /generic title/.test(e)));
  assert.ok(bad.errors.some((e) => /inside one <gx-questions>/.test(e)));
  assert.ok(bad.errors.some((e) => /share a title/.test(e)));
});

test('a page keeps its id across shows', () => {
  assert.equal(pageIdFor('a/Pick a layout.html'), pageIdFor('a/Pick a layout.html'));
  assert.match(pageIdFor('a/Pick a layout.html'), /^pick-a-layout-[0-9a-f]{6}$/);
});

test('the answers block carries the exact JSON', () => {
  const block = formatAnswers({ page: 'p-1', title: 'T', answeredAt: 'now', answers: { 'Which?': ['a', 'b'] } });
  assert.match(block, /^<live-page-answers page="p-1" title="T" answered="now">/);
  assert.deepEqual(JSON.parse(block.split('\n').slice(1, -1).join('\n')), { 'Which?': ['a', 'b'] });
});

test('selftest: show, the server, wait, copy-free answers, Ghostex refusal', () => {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (/^(GHOSTEX_|ZMX_)/.test(k)) delete env[k];
  const r = spawnSync(process.execPath, [script, 'selftest'], { encoding: 'utf8', env, timeout: 120000 });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /All \d+ checks passed/);
});
