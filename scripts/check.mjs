#!/usr/bin/env node
// Repo checks: the skill's frontmatter, the manifests agree with each other, and nothing that
// should stay private (local paths, emails, tokens, test logs) or off-style slips into the repo.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const problems = [];
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const json = (p) => JSON.parse(read(p));

const skill = read('skills/live-page/SKILL.md');
const fm = /^---\n([\s\S]*?)\n---\n/.exec(skill);
if (!fm) problems.push('SKILL.md: no frontmatter');
else {
  if (!/^name: live-page$/m.test(fm[1])) problems.push('SKILL.md: frontmatter name must be "live-page"');
  const d = /^description: (.*)$/m.exec(fm[1]);
  if (!d || d[1].length < 80) problems.push('SKILL.md: description missing or too short');
  else if (d[1].length > 1024) problems.push('SKILL.md: description over 1024 characters');
}
for (const f of ['skills/live-page/agents/openai.yaml', 'skills/live-page/kit/ghostex-kit.html', 'skills/live-page/kit/NOTICE.md', 'skills/live-page/scripts/live-page.mjs', 'skills/live-page/example.html'])
  if (!fs.existsSync(path.join(root, f))) problems.push(`missing ${f}`);
if (!read('skills/live-page/kit/ghostex-kit.html').includes('<!--live-page:state-->')) problems.push('the kit has no <!--live-page:state--> marker');

const versions = {
  'package.json': json('package.json').version,
  '.claude-plugin/plugin.json': json('.claude-plugin/plugin.json').version,
  '.codex-plugin/plugin.json': json('.codex-plugin/plugin.json').version,
  'live-page.mjs': /export const VERSION = '([^']+)'/.exec(read('skills/live-page/scripts/live-page.mjs'))[1],
};
if (new Set(Object.values(versions)).size !== 1) problems.push(`versions differ: ${JSON.stringify(versions)}`);
if (!json('.claude-plugin/plugin.json').skills.includes('./skills/live-page')) problems.push('.claude-plugin/plugin.json does not list ./skills/live-page');

const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], { cwd: root, encoding: 'utf8' }).split('\n').filter(Boolean);
const banned = [
  [/\u2014/, 'an em dash'],
  [/maestro|t3code|openusage/i, 'a banned name'],
  [/\/Users\/[a-z0-9_-]+\//i, 'a local macOS path'],
  [/\/home\/[a-z0-9_-]+\//i, 'a local Linux path'],
  [/C:\\\\?Users\\\\?[a-z0-9_-]+\\/i, 'a local Windows path'],
  [/[A-Za-z0-9._%+-]+@(gmail|outlook|hotmail|yahoo|icloud|proton)\.(com|me)/i, 'an email address'],
  [/\b(sk-[A-Za-z0-9_-]{20,}|ghp_[A-Za-z0-9]{20,}|gho_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[bp]-[A-Za-z0-9-]{10,}|gxs_[A-Za-z0-9]{10,}|AKIA[0-9A-Z]{16})/, 'a token'],
  [/127\.0\.0\.1:\d{4,5}\/[0-9a-f]{32}\//, 'a live-page link with its key (from a test run)'],
];
for (const f of files) {
  if (/(^|\/)(smoke|logs?)\//.test(f) || /\.(log|jsonl)$/.test(f)) problems.push(`${f}: test logs do not belong in the repo`);
  if (/\.(png|jpg|jpeg|gif|ico|webp)$/i.test(f) || f === 'scripts/check.mjs') continue;
  const text = read(f);
  for (const [re, what] of banned) if (re.test(text)) problems.push(`${f}: ${what}`);
}

if (problems.length) {
  console.error(problems.map((p) => `- ${p}`).join('\n'));
  process.exit(1);
}
console.log(`ok: ${files.length} files checked, version ${versions['package.json']}`);
