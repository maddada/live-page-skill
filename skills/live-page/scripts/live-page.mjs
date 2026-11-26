#!/usr/bin/env node
// live-page: show a Live page (one self-contained HTML file in Ghostex's page format) in the
// browser and get the user's answers back to the agent. Node 18+, standard library only, macOS,
// Linux and Windows.
//
//   node live-page.mjs new <file.html> --title "..."   write a page skeleton
//   node live-page.mjs check <file.html>                check a page before showing it
//   node live-page.mjs show <file.html>                 check, serve on 127.0.0.1 and open it
//   node live-page.mjs wait [<page>] [--timeout <s>]    block until the user sends, print the answers
//   node live-page.mjs answers [<page>]                 print the answers now (no waiting)
//   node live-page.mjs list | stop | export | doctor | selftest
//
// Everything lives in ~/.live-page (or $LIVE_PAGE_HOME): the server's port and key, and one folder
// per page with its snapshot, draft and answers. Answers stay there until read, and after.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const VERSION = '0.1.0';
const SCRIPT = fileURLToPath(import.meta.url);
const SKILL_DIR = path.join(path.dirname(SCRIPT), '..');
const IS_WIN = process.platform === 'win32';
const IDLE_MS = Number(process.env.LIVE_PAGE_IDLE_HOURS || 12) * 3600_000;

// ---------------------------------------------------------------------------------------------
// Small helpers

class CliError extends Error {
  constructor(message, code = 1) {
    super(message);
    this.code = code;
  }
}
const fail = (message, code = 1) => {
  throw new CliError(message, code);
};
const exists = (p) => {
  try {
    fs.statSync(p);
    return true;
  } catch {
    return false;
  }
};
const readText = (p) => {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return null;
  }
};
const readJson = (p, fallback = null) => {
  const t = readText(p);
  if (t == null) return fallback;
  try {
    return JSON.parse(t);
  } catch {
    return fallback;
  }
};
function writeJson(p, value) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n');
  fs.renameSync(tmp, p);
}
const nowIso = () => new Date().toISOString();
const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const slug = (s) =>
  String(s)
    .toLowerCase()
    .replace(/\.html?$/, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'page';
function pidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

export function home(env = process.env) {
  return env.LIVE_PAGE_HOME ? path.resolve(env.LIVE_PAGE_HOME) : path.join(os.homedir(), '.live-page');
}
const pagesDir = () => path.join(home(), 'pages');
const pageDir = (id) => path.join(pagesDir(), id);
const serverFile = () => path.join(home(), 'server.json');

function parseArgs(argv) {
  const pos = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') {
      pos.push(...argv.slice(i + 1));
      break;
    }
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq > 0) flags[a.slice(2, eq)] = a.slice(eq + 1);
      else if (argv[i + 1] !== undefined && !argv[i + 1].startsWith('--') && VALUE_FLAGS.has(a.slice(2))) flags[a.slice(2)] = argv[++i];
      else flags[a.slice(2)] = true;
    } else pos.push(a);
  }
  return { pos, flags };
}
const VALUE_FLAGS = new Set(['title', 'timeout', 'out', 'port']);

// ---------------------------------------------------------------------------------------------
// Inside Ghostex? Ghostex has Live pages built in (with answers that come back as the agent's next
// message, on desktop, web and phone), so this skill steps aside there.

const GHOSTEX_VARS = /^GHOSTEX_(SESSION_ID|SESSION_TOKEN|GLOBAL_SESSION_REF|COORDINATOR_SESSION|CLI_EXECUTABLE|GXSERVER_BASE_URL)$/;
export function insideGhostex(env = process.env) {
  if (env.LIVE_PAGE_IGNORE_GHOSTEX) return null;
  const hit = Object.keys(env).find((k) => GHOSTEX_VARS.test(k) && env[k]);
  if (hit) return hit;
  // Ghostex's terminal sessions name themselves S<n>-<project>-<session>.
  if (/^S\d+-[A-Za-z0-9]+-[A-Za-z0-9]+$/.test(env.ZMX_SESSION || '')) return 'ZMX_SESSION';
  // The ghostex CLI alone does not mean this agent runs in Ghostex: only a session it knows does.
  const cli = findOnPath('ghostex', env);
  if (!cli) return null;
  try {
    const r = spawnSync(cli, ['agents', 'whoami'], { encoding: 'utf8', timeout: 4000, env, windowsHide: true, shell: IS_WIN && /\.(cmd|bat)$/i.test(cli) });
    if (r.status === 0 && /Session ID:/i.test(r.stdout || '')) return 'ghostex agents whoami';
  } catch {
    /* not a Ghostex session */
  }
  return null;
}
const GHOSTEX_NOTE =
  'You are inside Ghostex, which has Live pages built in: use them instead of this skill. Run `ghostex visual guide pages`, write the page the same way, and publish it with `ghostex show <file.html>`; paste the block it prints into your reply and end your turn. The answers arrive as your next message.';
function refuseInsideGhostex() {
  const why = insideGhostex();
  if (why) fail(`${GHOSTEX_NOTE}\n(detected: ${why}; set LIVE_PAGE_IGNORE_GHOSTEX=1 only to test this skill there)`, 3);
}

function findOnPath(name, env = process.env) {
  const dirs = String(env.PATH || env.Path || '').split(path.delimiter).filter(Boolean);
  const exts = IS_WIN ? String(env.PATHEXT || '.EXE;.CMD;.BAT').split(';') : [''];
  for (const d of dirs)
    for (const e of exts) {
      const p = path.join(d, name + e.toLowerCase());
      const P = path.join(d, name + e);
      if (exists(p)) return p;
      if (exists(P)) return P;
    }
  return null;
}

// ---------------------------------------------------------------------------------------------
// Pages: check, ids and the registry

const GENERIC_TITLES = /^(questions?|mockups?|report|options?|page|live page|untitled|document|choices|survey|form)$/i;
const POINTER_RE = /\b(on|see|in) (the )?(live )?(page|form)\b|\bpick on\b/i;

export function pageTitle(html) {
  const m = /<title>([\s\S]*?)<\/title>/i.exec(html);
  return m ? m[1].replace(/\s+/g, ' ').trim() : '';
}
export function pageQuestions(html) {
  return [...html.matchAll(/<gx-question\b([^>]*)>/gi)].map((m) => {
    const attr = (n) => (new RegExp(`\\b${n}="([^"]*)"`, 'i').exec(m[1]) || [])[1] || '';
    return { tag: attr('tag'), title: attr('title'), name: attr('name') };
  });
}

/** The checks a page gets before the user sees it. Errors stop `show`; warnings are advice. */
export function checkPage(html) {
  const errors = [];
  const warnings = [];
  const title = pageTitle(html);
  if (!/<meta\s+name="ghostex-page"\s+content="v2"\s*\/?>/i.test(html)) errors.push('missing <meta name="ghostex-page" content="v2"> in <head>');
  if (!title) errors.push('missing <title>: give the page a short, specific title (what it asks or shows)');
  else if (GENERIC_TITLES.test(title)) errors.push(`generic title "${title}": name the subject, such as "Settings: where search goes"`);
  if (html.includes('\u2014')) errors.push('an em dash: rewrite with commas, colons, parentheses or two sentences');
  const hasRoot = /<gx-(page|questions)\b/i.test(html);
  if (!hasRoot) errors.push('no <gx-page> or <gx-questions>: put the whole page in one of them');
  const qs = pageQuestions(html);
  if (qs.length && !/<gx-questions\b/i.test(html)) errors.push('questions must sit inside one <gx-questions> (in place of <gx-page>)');
  if ((html.match(/<gx-questions\b/gi) || []).length > 1) errors.push('more than one <gx-questions>: use one for the whole page');
  const keys = qs.map((q) => q.name || q.title);
  const dup = keys.filter((k, i) => k && keys.indexOf(k) !== i);
  if (dup.length) errors.push(`two questions share a title or name (their answers would collide): ${[...new Set(dup)].join(', ')}`);
  const tags = qs.map((q) => q.tag).filter(Boolean);
  const dupTags = tags.filter((t, i) => tags.indexOf(t) !== i);
  if (dupTags.length) errors.push(`question tags used twice: ${[...new Set(dupTags)].join(', ')}`);
  for (const q of qs) {
    if (!q.title) errors.push('a <gx-question> without a title');
    else if (POINTER_RE.test(q.title)) warnings.push(`the question "${q.title}" points at a page or form: ask it directly`);
  }
  if (/<form\b/i.test(html)) warnings.push('a <form> of your own: the kit adds the questions, the note boxes and the Send button');
  if (/<button[^>]*type="submit"/i.test(html)) warnings.push('a submit button of your own: the kit adds Send');
  if (/(?:^|[;{\s])(?:html|body|:root)\s*\{[^}]*(background|color|font|max-width|padding|margin)\s*:/i.test(html))
    warnings.push('the page styles html, body or :root: leave them to the kit (no colours, fonts, padding or max-width there)');
  if (/grid-template-columns:\s*1fr\s+1fr\s*[;}]/i.test(html)) warnings.push('a bare "grid-template-columns: 1fr 1fr": use .gx-options, .gx-grid or repeat(auto-fit, minmax(min(100%, 280px), 1fr)) so it stacks on a phone');
  if (/\b100vw\b/.test(html)) warnings.push('100vw: use the column, <gx-wide> or a .gx-frame instead');
  if (/<script[^>]+src="http:/i.test(html)) warnings.push('a script over plain http: use https or inline it');
  if (!qs.length && /<gx-questions\b/i.test(html)) warnings.push('a <gx-questions> page with no <gx-question>: the reader can still write in "Anything else?"');
  if (!qs.length && !/<gx-questions\b/i.test(html)) warnings.push('no questions: the page ends with a reply box and an Archive button; ask "What next?" with choices when you need a decision');
  return { ok: !errors.length, errors, warnings, title, questions: qs };
}

/** A page's id: readable, and the same every time the same file is shown. */
export function pageIdFor(file) {
  const abs = path.resolve(file);
  const key = IS_WIN ? abs.toLowerCase() : abs;
  return `${slug(path.basename(abs))}-${crypto.createHash('sha1').update(key).digest('hex').slice(0, 6)}`;
}

function resolvePage(arg) {
  if (!arg) {
    const last = readJson(path.join(home(), 'last.json'));
    if (!last || !last.id) fail('no page shown yet: pass the page id or file');
    return last.id;
  }
  if (exists(pageDir(arg))) return arg;
  if (/\.html?$/i.test(arg) || exists(arg)) {
    const id = pageIdFor(arg);
    if (exists(pageDir(id))) return id;
    fail(`${arg} was not shown yet: run show first`);
  }
  fail(`no page "${arg}" (see list)`);
}
const metaOf = (id) => readJson(path.join(pageDir(id), 'meta.json'));

// ---------------------------------------------------------------------------------------------
// Serving a page: the kit, the state and the bridge in its <head>

let kitCache = null;
function kitHtml() {
  if (kitCache == null) {
    const p = path.join(SKILL_DIR, 'kit', 'ghostex-kit.html');
    kitCache = readText(p);
    if (!kitCache) fail(`the page kit is missing (${p}): reinstall the skill`);
  }
  return kitCache;
}
const jsonForScript = (v) => JSON.stringify(v).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');

/** The page with Ghostex's kit, its state and the live-page bridge in its head. */
export function withKit(html, state, { exported = null, page } = {}) {
  const stateScript = `<script>window.ghostex&&ghostex.__state(${jsonForScript(state)});</script>`;
  let block = kitHtml().replace('<!--live-page:state-->', stateScript);
  if (exported) block = `<script>window.__gxExported=${jsonForScript(exported)};</script>\n` + block;
  block += `\n<script>window.__livePage=${jsonForScript(page)};</script>\n<style id="live-page-bridge">${BRIDGE_CSS}</style>\n<script>${BRIDGE_JS}</script>`;
  const charset = /<meta charset[^>]*>/i.exec(html);
  if (charset) return html.slice(0, charset.index + charset[0].length) + '\n' + block + html.slice(charset.index + charset[0].length);
  const head = /<head[^>]*>/i.exec(html);
  if (head) return html.slice(0, head.index + head[0].length) + '\n' + block + html.slice(head.index + head[0].length);
  return block + html;
}

const IMAGE_TYPES = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.avif': 'image/avif', '.ico': 'image/x-icon' };
const TYPES = {
  ...IMAGE_TYPES,
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
};

/** Images by absolute path (as Ghostex allows) become data URLs, so the page shows them anywhere. */
function embedLocalImages(html) {
  const swap = (p) => {
    let file = p;
    try {
      if (/^file:\/\//i.test(file)) file = fileURLToPath(file);
    } catch {
      return null;
    }
    const isAbs = file.startsWith('/') || /^[a-z]:[\\/]/i.test(file);
    const type = IMAGE_TYPES[path.extname(file).toLowerCase()];
    if (!isAbs || !type || file.startsWith('//')) return null;
    try {
      const buf = fs.readFileSync(file);
      if (buf.length > 6 * 1024 * 1024) return null;
      return `data:${type};base64,${buf.toString('base64')}`;
    } catch {
      return null;
    }
  };
  return html
    .replace(/(<(?:img|source|image|video)\b[^>]*?\s(?:src|href|poster)=")([^"]+)(")/gi, (all, a, p, b) => {
      const d = swap(p);
      return d ? a + d + b : all;
    })
    .replace(/url\((['"]?)([^'")]+)\1\)/gi, (all, q, p) => {
      const d = swap(p);
      return d ? `url(${q}${d}${q})` : all;
    });
}

// ---------------------------------------------------------------------------------------------
// show: register the page, make sure the server runs, open it

function registerPage(file, flags) {
  const abs = path.resolve(file);
  const html = readText(abs);
  if (html == null) fail(`no page at ${file}`);
  const check = checkPage(html);
  if (!check.ok) fail(`Page check failed for ${file}:\n- ${check.errors.join('\n- ')}${check.warnings.length ? `\nWarnings:\n- ${check.warnings.join('\n- ')}` : ''}`);
  const id = pageIdFor(abs);
  const dir = pageDir(id);
  fs.mkdirSync(dir, { recursive: true });
  const old = metaOf(id);
  const notes = [];
  // A newer version of an answered page starts unanswered; the old answers stay, renamed.
  const answersFile = path.join(dir, 'answers.json');
  const prev = readJson(answersFile);
  if (prev) {
    const kept = path.join(dir, `answers.${Date.now()}.json`);
    fs.renameSync(answersFile, kept);
    fs.rmSync(path.join(dir, 'draft.json'), { force: true });
    if (!prev.readAt) notes.push(`The previous version's answers were never read; they are kept in ${kept}:\n${formatAnswers(prev)}`);
  }
  fs.writeFileSync(path.join(dir, 'page.html'), embedLocalImages(html));
  const title = flags.title && typeof flags.title === 'string' ? flags.title : check.title;
  const meta = { id, title, source: abs, dir: path.dirname(abs), questions: check.questions, awaitsSeen: !check.questions.length, version: (old ? old.version || 1 : 0) + 1, shownAt: nowIso() };
  writeJson(path.join(dir, 'meta.json'), meta);
  writeJson(path.join(home(), 'last.json'), { id, at: meta.shownAt });
  return { meta, check, notes };
}

function cmdShow(pos, flags) {
  refuseInsideGhostex();
  const file = pos[0] || fail('usage: live-page show <file.html> [--no-open] [--app] [--title "..."]');
  const { meta, check, notes } = registerPage(file, flags);
  const server = ensureServer();
  const url = `${server.url}/${server.key}/p/${meta.id}/`;
  const opened = openPage(url, flags);
  const me = `node ${quoteArg(SCRIPT)}`;
  const lines = [
    `Showing "${meta.title}" (page ${meta.id}).`,
    `Link: ${url}`,
    opened.opened ? `Opened it in ${opened.how}.` : `Not opened here (${opened.why}). Give the user the link above: ${opened.tell}`,
    `Answers are saved to ${path.join(pageDir(meta.id), 'answers.json')} the moment the user presses Send, and kept until you read them.`,
    `Get them: ${me} wait ${meta.id}   (blocks until they send; add --timeout <seconds> to come back sooner)`,
    `If the user pastes a <live-page-answers> block into the chat instead, read it the same way.`,
  ];
  if (check.warnings.length) lines.push(`Page warnings (fix them and run show again):\n- ${check.warnings.join('\n- ')}`);
  lines.push(...notes);
  return { text: lines.join('\n'), json: { ok: true, id: meta.id, title: meta.title, url, opened: opened.opened, openedIn: opened.how || null, answersFile: path.join(pageDir(meta.id), 'answers.json'), wait: `${me} wait ${meta.id}`, warnings: check.warnings, notes } };
}

function quoteArg(s) {
  return /[\s"'$`\\()&|;<>]/.test(s) ? JSON.stringify(s) : s;
}

/** Where the page opens: the default browser, an app window, or nowhere (the link is printed). */
function openPage(url, flags, env = process.env) {
  if (flags['no-open'] || env.LIVE_PAGE_NO_OPEN) return { opened: false, why: flags['no-open'] ? '--no-open' : 'LIVE_PAGE_NO_OPEN is set', tell: 'they open it in any browser on this computer.' };
  if (env.TERM_PROGRAM === 'vscode' && !flags.browser && !flags.app)
    return {
      opened: false,
      why: 'running in a VS Code or Cursor terminal',
      tell: 'in VS Code, Command Palette > "Simple Browser: Show" and paste it; in Cursor, open it in the built-in browser (or Cmd/Ctrl+click it to use the system browser). Pass --browser to open the system browser yourself.',
    };
  if ((env.SSH_CONNECTION || env.SSH_TTY) && !IS_WIN && process.platform !== 'darwin' && !env.DISPLAY && !env.WAYLAND_DISPLAY)
    return { opened: false, why: 'an SSH session with no display', tell: `forward the port first (ssh -L ${new URL(url).port}:127.0.0.1:${new URL(url).port} <host>), then open the link on their computer.` };
  if (flags.app) {
    const how = openAppWindow(url);
    if (how) return { opened: true, how };
  }
  const how = openDefault(url);
  return how ? { opened: true, how } : { opened: false, why: 'no way to open a browser was found', tell: 'they open it in any browser on this computer.' };
}

function detach(cmd, args, opts = {}) {
  try {
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true, windowsHide: true, ...opts });
    child.on('error', () => {});
    child.unref();
    return true;
  } catch {
    return false;
  }
}
function openDefault(url) {
  if (process.platform === 'darwin') return detach('open', [url]) && 'the default browser';
  if (IS_WIN) return detach('rundll32', ['url.dll,FileProtocolHandler', url]) && 'the default browser';
  for (const opener of ['xdg-open', 'gio', 'wslview']) {
    const p = findOnPath(opener);
    if (p) return detach(p, opener === 'gio' ? ['open', url] : [url]) && 'the default browser';
  }
  return null;
}
function openAppWindow(url) {
  if (process.platform === 'darwin') {
    for (const app of ['Google Chrome', 'Microsoft Edge', 'Brave Browser', 'Chromium']) {
      if (exists(`/Applications/${app}.app`) || exists(path.join(os.homedir(), 'Applications', `${app}.app`))) {
        if (detach('open', ['-na', app, '--args', `--app=${url}`])) return `an app window (${app})`;
      }
    }
    return null;
  }
  if (IS_WIN) {
    const roots = [process.env['ProgramFiles'], process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA].filter(Boolean);
    const rel = ['Google\\Chrome\\Application\\chrome.exe', 'Microsoft\\Edge\\Application\\msedge.exe', 'BraveSoftware\\Brave-Browser\\Application\\brave.exe'];
    for (const r of roots)
      for (const x of rel) {
        const p = path.join(r, x);
        if (exists(p) && detach(p, [`--app=${url}`])) return `an app window (${path.basename(p, '.exe')})`;
      }
    return null;
  }
  for (const b of ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge', 'brave-browser']) {
    const p = findOnPath(b);
    if (p && detach(p, [`--app=${url}`])) return `an app window (${b})`;
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// The answer server: 127.0.0.1 only, a random port and key, pages and answers in files.

function serverInfo() {
  const info = readJson(serverFile());
  return info && pidAlive(info.pid) ? info : null;
}

function healthy(info) {
  if (!info) return false;
  const r = spawnSync(
    process.execPath,
    ['-e', `require('http').get({host:'127.0.0.1',port:${Number(info.port)},path:'/${info.key}/api/health',headers:{host:'127.0.0.1:${Number(info.port)}'},timeout:2500},r=>{let b='';r.on('data',c=>b+=c);r.on('end',()=>process.exit(r.statusCode===200&&/"ok":true/.test(b)?0:1))}).on('error',()=>process.exit(1)).on('timeout',function(){this.destroy();process.exit(1)})`],
    { timeout: 5000, windowsHide: true },
  );
  return r.status === 0;
}

/** The running server, started in the background when there is none. */
export function ensureServer() {
  const running = serverInfo();
  if (running && healthy(running)) return running;
  fs.mkdirSync(home(), { recursive: true });
  const child = spawn(process.execPath, [SCRIPT, '__serve'], { detached: true, stdio: 'ignore', windowsHide: true, env: { ...process.env, LIVE_PAGE_HOME: home() } });
  child.unref();
  const until = Date.now() + 10000;
  while (Date.now() < until) {
    sleepSync(100);
    const info = serverInfo();
    if (info && info.pid === child.pid) return info;
  }
  fail(`the answer server did not start: run "node ${quoteArg(SCRIPT)} serve" to see why`);
}

function runServer(flags) {
  fs.mkdirSync(home(), { recursive: true });
  const prev = readJson(serverFile()) || {};
  // Keep the port and key of the last run where possible, so a page left open still reaches us.
  const key = /^[0-9a-f]{32}$/.test(prev.key || '') ? prev.key : crypto.randomBytes(16).toString('hex');
  let lastSeen = Date.now();
  const server = http.createServer((req, res) => {
    lastSeen = Date.now();
    handle(req, res, key).catch((e) => send(res, 500, { ok: false, error: e.message }));
  });
  const listen = (port) =>
    new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', () => {
        server.off('error', reject);
        resolve(server.address().port);
      });
    });
  return (async () => {
    let port;
    const wanted = flags.port ? Number(flags.port) : prev.port || 0;
    try {
      port = await listen(wanted);
    } catch {
      port = await listen(0);
    }
    const url = `http://127.0.0.1:${port}`;
    writeJson(serverFile(), { pid: process.pid, port, key, url, version: VERSION, startedAt: nowIso() });
    process.stdout.write(`live-page answer server on ${url} (Ctrl+C to stop)\n`);
    const stop = () => {
      const i = readJson(serverFile());
      if (i && i.pid === process.pid) writeJson(serverFile(), { ...i, pid: null, stoppedAt: nowIso() });
      process.exit(0);
    };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
    // Quiet for a long time with no page waiting: stop, the next show starts it again.
    setInterval(() => {
      if (Date.now() - lastSeen > IDLE_MS) stop();
    }, 60_000).unref();
    await new Promise((r) => server.on('close', r));
  })();
}

function send(res, status, body, type = 'application/json; charset=utf-8', extra = {}) {
  const data = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'content-security-policy': "frame-ancestors 'none'", ...extra });
  res.end(data);
}
function readBody(req, max = 2_000_000) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > max) {
        reject(Object.assign(new Error('too large'), { status: 413 }));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
const sameKey = (a, b) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));

async function handle(req, res, key) {
  const port = req.socket.localPort;
  // Only this machine, only with the key, and only from pages this server served.
  const host = String(req.headers.host || '');
  if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) return send(res, 403, { ok: false, error: 'bad host' });
  const origin = req.headers.origin;
  if (req.method !== 'GET' && req.method !== 'HEAD' && origin && origin !== `http://127.0.0.1:${port}` && origin !== `http://localhost:${port}`) return send(res, 403, { ok: false, error: 'bad origin' });
  if (req.headers['sec-fetch-site'] && !['same-origin', 'none'].includes(String(req.headers['sec-fetch-site'])) && req.method !== 'GET') return send(res, 403, { ok: false, error: 'cross-site request' });
  const url = new URL(req.url, `http://${host}`);
  let parts;
  try {
    parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
  } catch {
    return send(res, 400, { ok: false, error: 'bad path' });
  }
  if (!parts[0] || !sameKey(parts[0], key)) return send(res, 403, { ok: false, error: 'this link needs its key: use the link live-page printed' });
  if (parts[1] === 'api' && parts[2] === 'health') return send(res, 200, { ok: true, version: VERSION });
  if (parts[1] !== 'p' || !parts[2] || !/^[a-z0-9-]+$/.test(parts[2])) return send(res, 404, { ok: false, error: 'not found' });
  const id = parts[2];
  const dir = pageDir(id);
  const meta = metaOf(id);
  if (!meta) return send(res, 404, { ok: false, error: 'no such page' });
  const answersFile = path.join(dir, 'answers.json');
  const draftFile = path.join(dir, 'draft.json');
  const rest = parts.slice(3);
  if (!rest.length && req.method === 'GET') {
    if (!url.pathname.endsWith('/')) {
      res.writeHead(302, { location: url.pathname + '/' + url.search });
      return res.end();
    }
    const html = readText(path.join(dir, 'page.html'));
    const ans = readJson(answersFile);
    const draft = readJson(draftFile);
    const state = ans
      ? { answered: true, answers: ans.answers, answeredAt: ans.answeredAt, awaitsSeen: meta.awaitsSeen }
      : { answered: false, draft: draft ? draft.draft : null, draftEditedAt: draft ? draft.editedAt : null, awaitsSeen: meta.awaitsSeen };
    return send(res, 200, withKit(html, state, { page: { id, title: meta.title } }), 'text/html; charset=utf-8');
  }
  const verb = rest.join('/');
  if (verb === 'answers' && req.method === 'POST') {
    let body;
    try {
      body = JSON.parse((await readBody(req, 1_000_000)).toString('utf8') || '{}');
    } catch {
      return send(res, 400, { ok: false, error: 'Your answers were not sent: they were not valid JSON.' });
    }
    if (body.answers === undefined) return send(res, 400, { ok: false, error: 'Your answers were not sent: nothing to send.' });
    if (exists(answersFile)) return send(res, 409, { ok: false, error: 'This page was already answered.' });
    const answeredAt = nowIso();
    writeJson(answersFile, { page: id, title: meta.title, version: meta.version, answers: body.answers, answeredAt, via: 'page' });
    fs.rmSync(draftFile, { force: true });
    return send(res, 200, { ok: true, answeredAt });
  }
  if (verb === 'draft') {
    if (req.method === 'GET') return send(res, 200, readJson(draftFile, { draft: null, editedAt: 0 }));
    if (req.method === 'POST') {
      if (exists(answersFile)) return send(res, 409, { ok: false, error: 'already answered' });
      let body = {};
      try {
        body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
      } catch {
        return send(res, 400, { ok: false, error: 'bad draft' });
      }
      writeJson(draftFile, { draft: body.draft && typeof body.draft === 'object' ? body.draft : {}, editedAt: Number(body.editedAt) || Date.now() });
      return send(res, 200, { ok: true });
    }
  }
  if (verb === 'notice' && req.method === 'POST') return send(res, 200, { ok: true });
  if (verb === 'image' && req.method === 'POST') {
    const buf = await readBody(req, 12 * 1024 * 1024);
    const ext = sniffImage(buf);
    if (!ext) return send(res, 400, { ok: false, error: 'That is not an image this page can keep (PNG, JPEG, GIF or WebP).' });
    const imgDir = path.join(dir, 'images');
    fs.mkdirSync(imgDir, { recursive: true });
    const file = path.join(imgDir, `${Date.now()}-${crypto.randomBytes(3).toString('hex')}${ext}`);
    fs.writeFileSync(file, buf);
    return send(res, 200, { ok: true, path: file });
  }
  if (verb === 'image' && req.method === 'GET') {
    const p = url.searchParams.get('path') || '';
    const imgDir = path.join(dir, 'images');
    if (path.resolve(p).startsWith(imgDir + path.sep) && exists(p)) return send(res, 200, fs.readFileSync(p), IMAGE_TYPES[path.extname(p).toLowerCase()] || 'application/octet-stream');
    return send(res, 404, { ok: false, error: 'no such image' });
  }
  if (verb === 'mentions') return send(res, 404, { ok: false });
  // Anything else is a file next to the page (an image by relative path, a stylesheet).
  if (req.method === 'GET') {
    const target = path.resolve(meta.dir, ...rest);
    const inside = target.startsWith(path.resolve(meta.dir) + path.sep);
    // Never anything hidden (.git, .env, .secrets/...) or installed packages.
    const hidden = rest.some((seg) => seg.startsWith('.') || seg === 'node_modules');
    if (inside && !hidden && TYPES[path.extname(target).toLowerCase()] && exists(target) && fs.statSync(target).isFile()) return send(res, 200, fs.readFileSync(target), TYPES[path.extname(target).toLowerCase()]);
  }
  return send(res, 404, { ok: false, error: 'not found' });
}

function sniffImage(b) {
  if (b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return '.png';
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return '.jpg';
  if (b.length > 6 && b.toString('latin1', 0, 4) === 'GIF8') return '.gif';
  if (b.length > 12 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') return '.webp';
  return null;
}

function cmdStop() {
  const info = serverInfo();
  if (!info) return { text: 'The answer server is not running.', json: { ok: true, running: false } };
  try {
    process.kill(info.pid);
  } catch {
    /* already gone */
  }
  writeJson(serverFile(), { ...info, pid: null, stoppedAt: nowIso() });
  return { text: `Stopped the answer server (pid ${info.pid}). Answers already sent stay in ${pagesDir()}.`, json: { ok: true, stopped: info.pid } };
}

// ---------------------------------------------------------------------------------------------
// Answers: wait, answers, list

/** The block an agent reads, the same one the page's Copy answers button gives the user. */
export function formatAnswers(a) {
  const title = String(a.title || '').replace(/"/g, "'");
  return `<live-page-answers page="${a.page}" title="${title}" answered="${a.answeredAt || ''}">\n${JSON.stringify(a.answers, null, 2)}\n</live-page-answers>`;
}

function readAnswers(id, { markRead = true } = {}) {
  const file = path.join(pageDir(id), 'answers.json');
  const a = readJson(file);
  if (!a) return null;
  if (markRead && !a.readAt) writeJson(file, { ...a, readAt: nowIso() });
  return a;
}

async function cmdWait(pos, flags) {
  refuseInsideGhostex();
  const id = resolvePage(pos[0]);
  const meta = metaOf(id);
  const timeout = flags.timeout ? Number(flags.timeout) * 1000 : 0;
  // The server may be gone (a restart): start it again on the same port and key, so the open page can still send.
  try {
    ensureServer();
  } catch {
    /* the answers file is what counts; wait on it anyway */
  }
  const started = Date.now();
  for (;;) {
    const a = readAnswers(id);
    if (a) return { text: `The user answered "${meta.title}":\n${formatAnswers(a)}`, json: { ok: true, ...a } };
    if (timeout && Date.now() - started >= timeout)
      throw new CliError(`No answers yet for "${meta.title}" (page ${id}); the page is still open for the user. Run the same wait again to keep waiting; nothing is lost.`, 2);
    await sleep(400);
  }
}

function cmdAnswers(pos, flags) {
  const id = resolvePage(pos[0]);
  const meta = metaOf(id);
  const a = readAnswers(id, { markRead: !flags.peek });
  if (!a) throw new CliError(`No answers yet for "${meta.title}" (page ${id}).`, 2);
  return { text: formatAnswers(a), json: { ok: true, ...a } };
}

function cmdList() {
  const ids = exists(pagesDir()) ? fs.readdirSync(pagesDir()).filter((d) => exists(path.join(pagesDir(), d, 'meta.json'))) : [];
  const info = serverInfo();
  const rows = ids
    .map((id) => {
      const m = metaOf(id);
      const a = readJson(path.join(pageDir(id), 'answers.json'));
      const status = !a ? 'waiting for the user' : a.readAt ? 'answered, read' : 'answered, NOT READ yet';
      return { id, title: m.title, status, shownAt: m.shownAt, url: info ? `${info.url}/${info.key}/p/${id}/` : null, source: m.source };
    })
    .sort((a, b) => String(b.shownAt).localeCompare(String(a.shownAt)));
  const text = rows.length ? rows.map((r) => `${r.id}  [${r.status}]  ${r.title}${r.url ? `\n    ${r.url}` : ''}`).join('\n') : 'No pages shown yet.';
  return { text: `${text}\nServer: ${info ? `running on ${info.url} (pid ${info.pid})` : 'not running'}`, json: { pages: rows, server: info } };
}

// ---------------------------------------------------------------------------------------------
// new, check, export, doctor

function pageTemplate(title) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="ghostex-page" content="v2">
<title>${escapeHtml(title)}</title>
<style>
  /* Only what your own parts need: the kit paints the page, the cards, the questions and Send. */
</style>
</head>
<body>
<gx-questions submit="Send to the agent">
  <header>
    <span class="gx-eyebrow">Area · purpose</span>
    <h1>${escapeHtml(title)}</h1>
    <p class="gx-lede">One line on what this page is for.</p>
    <div class="gx-chips"><span class="gx-chip"><b>3</b> options</span></div>
  </header>

  <gx-wide><div class="gx-options">
    <section data-question="Q1" data-choice="a">
      <span class="gx-ribbon">Recommended</span>
      <h3>A. First option</h3>
      <p>How it works, in one line.</p>
      <div class="gx-stats"><div class="gx-stat"><small>Time</small><b>2 days</b></div></div>
    </section>
    <section data-question="Q1" data-choice="b">
      <h3>B. Second option</h3>
      <p>How it works, in one line.</p>
      <div class="gx-stats"><div class="gx-stat"><small>Time</small><b>1 week</b></div></div>
    </section>
  </div></gx-wide>

  <gx-question tag="Q1" title="Which option should I build?">
    <p>Why it matters, and why A is recommended.</p>
    <gx-choice value="a" recommended>A. First option<small>One line on the trade-off.</small></gx-choice>
    <gx-choice value="b">B. Second option</gx-choice>
  </gx-question>
</gx-questions>
</body>
</html>
`;
}

function cmdNew(pos, flags) {
  const file = pos[0] || fail('usage: live-page new <file.html> --title "What the page asks or shows"');
  const title = typeof flags.title === 'string' ? flags.title : fail('give the page a title: --title "Settings: where search goes"');
  if (exists(file) && !flags.force) fail(`${file} exists (--force to overwrite)`);
  fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  fs.writeFileSync(file, pageTemplate(title));
  return { text: `Wrote ${file}. Fill it in, then: check it and show it.`, json: { ok: true, file: path.resolve(file) } };
}

function cmdCheck(pos) {
  const file = pos[0] || fail('usage: live-page check <file.html>');
  const html = readText(file);
  if (html == null) fail(`no page at ${file}`);
  const r = checkPage(html);
  const text = `${r.ok ? 'Page check passed' : 'Page check failed'}: "${r.title}" (${r.questions.length} question${r.questions.length === 1 ? '' : 's'})${r.errors.map((e) => `\n  error: ${e}`).join('')}${r.warnings.map((w) => `\n  warning: ${w}`).join('')}`;
  if (!r.ok) throw new CliError(text, 1);
  return { text, json: r };
}

function cmdExport(pos, flags) {
  const file = pos[0] || fail('usage: live-page export <file.html> [--out <file.html>]');
  const html = readText(file);
  if (html == null) fail(`no page at ${file}`);
  const check = checkPage(html);
  if (!check.ok) fail(`Page check failed:\n- ${check.errors.join('\n- ')}`);
  const id = pageIdFor(file);
  const out = typeof flags.out === 'string' ? path.resolve(flags.out) : path.resolve(file).replace(/\.html?$/i, '') + '.standalone.html';
  fs.writeFileSync(out, withKit(embedLocalImages(html), { answered: false, draft: null, draftEditedAt: null, awaitsSeen: !check.questions.length }, { exported: { page: id, title: check.title }, page: { id, title: check.title, exported: true } }));
  return { text: `Wrote ${out}. It opens in any browser with no server: its Send button shows the answers as a block to copy and paste into the agent's chat.`, json: { ok: true, out } };
}

function cmdDoctor() {
  const info = serverInfo();
  let writable = true;
  try {
    fs.mkdirSync(home(), { recursive: true });
    fs.accessSync(home(), fs.constants.W_OK);
  } catch {
    writable = false;
  }
  const ghostex = insideGhostex();
  const rows = [
    ['live-page', VERSION],
    ['node', process.version],
    ['platform', `${process.platform} ${os.release()}`],
    ['state folder', `${home()}${writable ? '' : ' (NOT writable: set LIVE_PAGE_HOME to a folder you can write)'}`],
    ['page kit', exists(path.join(SKILL_DIR, 'kit', 'ghostex-kit.html')) ? 'found' : 'MISSING: reinstall the skill'],
    ['server', info ? `running on ${info.url} (pid ${info.pid})` : 'not running (show starts it)'],
    ['inside Ghostex', ghostex ? `yes (${ghostex}): use ghostex show instead` : 'no'],
    ['terminal', process.env.TERM_PROGRAM === 'vscode' ? 'VS Code or Cursor: show prints the link for the built-in browser' : process.env.TERM_PROGRAM || 'unknown'],
  ];
  return { text: rows.map(([k, v]) => `${k.padEnd(15)} ${v}`).join('\n'), json: Object.fromEntries(rows) };
}

// ---------------------------------------------------------------------------------------------
// selftest: the whole loop with no browser and no agent (what the Windows smoke runs)

function request(info, { method = 'GET', p, body, headers = {} }) {
  return new Promise((resolve, reject) => {
    const data = body == null ? null : Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
    const req = http.request({ host: '127.0.0.1', port: info.port, method, path: p, headers: { host: `127.0.0.1:${info.port}`, ...(data ? { 'content-length': data.length } : {}), ...headers } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

async function cmdSelftest() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'live-page-selftest-'));
  const env = { ...process.env, LIVE_PAGE_HOME: path.join(tmp, 'home'), LIVE_PAGE_NO_OPEN: '1', LIVE_PAGE_IGNORE_GHOSTEX: '1' };
  for (const k of Object.keys(env)) if (/^GHOSTEX_/.test(k)) delete env[k];
  const results = [];
  const ok = (name, pass, detail = '') => {
    results.push({ name, pass: !!pass, detail });
    process.stdout.write(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail && !pass ? `: ${detail}` : ''}\n`);
  };
  const run = (args, extraEnv = {}) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', env: { ...env, ...extraEnv }, timeout: 30000, windowsHide: true });
  const page = path.join(tmp, 'pages', 'Pick a layout.html');
  try {
    let r = run(['new', page, '--title', 'Selftest: pick a layout']);
    ok('new writes a skeleton', r.status === 0 && exists(page), r.stderr);
    r = run(['check', page]);
    ok('check passes the skeleton', r.status === 0, r.stdout + r.stderr);
    const bad = path.join(tmp, 'bad.html');
    fs.writeFileSync(bad, '<!doctype html><title>Report</title><p>x \u2014 y</p>');
    r = run(['check', bad]);
    ok('check fails a page without the marker, with a generic title and an em dash', r.status === 1 && /marker|ghostex-page/.test(r.stdout + r.stderr) && /generic/.test(r.stdout + r.stderr) && /em dash/.test(r.stdout + r.stderr));
    r = run(['show', page, '--json']);
    let shown = {};
    try {
      shown = JSON.parse(r.stdout);
    } catch {
      /* reported below */
    }
    ok('show starts the server and prints the link', r.status === 0 && /^http:\/\/127\.0\.0\.1:\d+\/[0-9a-f]{32}\/p\//.test(shown.url || ''), r.stdout + r.stderr);
    const info = readJson(path.join(env.LIVE_PAGE_HOME, 'server.json'));
    const u = new URL(shown.url);
    const base = u.pathname.replace(/\/$/, '');
    let h = await request(info, { p: u.pathname });
    ok('the page is served with the kit, its state and the bridge', h.status === 200 && h.text.includes('id="ghostex-kit"') && h.text.includes('ghostex.__state(') && h.text.includes('live-page-bridge'));
    h = await request(info, { p: u.pathname.replace(/[0-9a-f]{32}/, '0'.repeat(32)) });
    ok('a wrong key is refused', h.status === 403);
    h = await request(info, { p: u.pathname, headers: { host: `evil.example:${info.port}` } });
    ok('a foreign Host header is refused (DNS rebinding)', h.status === 403);
    h = await request(info, { method: 'POST', p: `${base}/answers`, body: { answers: { x: 1 } }, headers: { origin: 'https://evil.example' } });
    ok('a post from another site is refused', h.status === 403);
    h = await request(info, { method: 'POST', p: `${base}/draft`, body: { draft: { kit: { a: 1 } }, editedAt: 5 }, headers: { origin: `http://127.0.0.1:${info.port}` } });
    const d = await request(info, { p: `${base}/draft` });
    ok('drafts are kept', h.status === 200 && JSON.parse(d.text).editedAt === 5);
    const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082', 'hex');
    h = await request(info, { method: 'POST', p: `${base}/image`, body: png, headers: { origin: `http://127.0.0.1:${info.port}` } });
    const img = JSON.parse(h.text);
    ok('a pasted image is saved', h.status === 200 && img.ok && exists(img.path));
    fs.mkdirSync(path.join(tmp, 'pages', 'img'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'pages', 'img', 'a.png'), png);
    fs.mkdirSync(path.join(tmp, 'pages', '.secret'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'pages', '.secret', 'key.json'), '{"k":1}');
    h = await request(info, { p: `${base}/img/a.png` });
    const hidden = await request(info, { p: `${base}/.secret/key.json` });
    const outside = await request(info, { p: `${base}/..%2F..%2Fhome%2Fserver.json` });
    ok('files next to the page are served, hidden ones and ones outside are not', h.status === 200 && hidden.status === 404 && outside.status === 404, `${h.status} ${hidden.status} ${outside.status}`);
    // The agent waits; the user sends; the agent gets exactly what was sent.
    const waiter = spawn(process.execPath, [SCRIPT, 'wait', shown.id, '--json'], { env, windowsHide: true });
    let out = '';
    waiter.stdout.on('data', (c) => (out += c));
    const done = new Promise((resolve) => waiter.on('close', resolve));
    await sleep(800);
    const answers = { 'Which option should I build?': 'a', 'Which option should I build? (note)': 'with a dark mode, ünïcödé ✓', 'Additional notes': `see [Image #1](${img.path})` };
    h = await request(info, { method: 'POST', p: `${base}/answers`, body: { answers }, headers: { origin: `http://127.0.0.1:${info.port}`, 'sec-fetch-site': 'same-origin' } });
    ok('Send is accepted', h.status === 200 && JSON.parse(h.text).ok);
    const code = await Promise.race([done, sleep(10000).then(() => 'timeout')]);
    let got = {};
    try {
      got = JSON.parse(out);
    } catch {
      /* reported below */
    }
    ok('wait returns the exact answers', code === 0 && JSON.stringify(got.answers) === JSON.stringify(answers), `code ${code}, ${out}`);
    h = await request(info, { method: 'POST', p: `${base}/answers`, body: { answers }, headers: { origin: `http://127.0.0.1:${info.port}` } });
    ok('a second Send is refused (409)', h.status === 409);
    h = await request(info, { p: u.pathname });
    ok('the page reopens as answered', /"answered":true/.test(h.text));
    r = run(['answers', shown.id]);
    ok('answers prints the block again', r.status === 0 && r.stdout.includes('<live-page-answers') && r.stdout.includes('ünïcödé'));
    r = run(['wait', shown.id, '--timeout', '1']);
    ok('wait on an answered page returns at once', r.status === 0);
    r = run(['show', page, '--json']);
    ok('show again starts the page unanswered', r.status === 0 && !exists(path.join(env.LIVE_PAGE_HOME, 'pages', shown.id, 'answers.json')));
    r = run(['wait', shown.id, '--timeout', '1']);
    ok('wait times out with code 2 and says how to go on', r.status === 2 && /Run the same wait again/.test(r.stderr));
    r = run(['export', page, '--out', path.join(tmp, 'standalone.html')]);
    ok('export writes a standalone page', r.status === 0 && /__gxExported=/.test(readText(path.join(tmp, 'standalone.html')) || ''));
    r = run(['show', page], { LIVE_PAGE_IGNORE_GHOSTEX: '', GHOSTEX_SESSION_ID: 'S1-test' });
    ok('show steps aside inside Ghostex (exit 3, says use ghostex show)', r.status === 3 && /ghostex show/.test(r.stderr));
    r = run(['stop']);
    ok('stop stops the server', r.status === 0);
    await sleep(500);
    r = run(['wait', shown.id, '--timeout', '2']);
    const again = readJson(path.join(env.LIVE_PAGE_HOME, 'server.json'));
    ok('wait starts the server again on the same port and key', r.status === 2 && again && again.port === info.port && again.key === info.key && pidAlive(again.pid));
    run(['stop']);
  } catch (e) {
    ok('selftest ran to the end', false, e.stack || e.message);
    run(['stop']);
  }
  const failed = results.filter((x) => !x.pass);
  await sleep(300);
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {
    /* Windows may hold a file a moment longer */
  }
  if (failed.length) throw new CliError(`${failed.length} of ${results.length} checks failed`, 1);
  return { text: `All ${results.length} checks passed (${process.platform}, node ${process.version}).`, json: { ok: true, results } };
}

// ---------------------------------------------------------------------------------------------
// The bridge: what this skill adds to Ghostex's kit in the browser.
// - A "Copy answers" button beside Send: it copies a ready-to-paste <live-page-answers> block, the
//   fallback that always works (also on an exported page and once the page was sent).
// - Retry messages that name this script instead of Ghostex.

const BRIDGE_CSS = `
.lp-copy{display:inline-flex;align-items:center;gap:6px;height:28px;box-sizing:border-box;padding:0 11px;font:inherit;font-size:13px;font-weight:500;border-radius:8px;border:1px solid var(--gx-line-strong,transparent);background:transparent;color:var(--gx-text);cursor:pointer;flex:none;white-space:nowrap}
.lp-copy:hover{background:color-mix(in srgb,var(--gx-fg) 9%,transparent)}
.gx-send .lp-copy{margin-left:auto}.gx-send .lp-copy+.gx-skip-all{margin-left:0}
#lp-copy-dialog{position:fixed;inset:0;z-index:2147483646;display:flex;align-items:center;justify-content:center;padding:24px;box-sizing:border-box;background:rgba(0,0,0,.32);-webkit-backdrop-filter:blur(6px);backdrop-filter:blur(6px)}
#lp-copy-dialog .lp-card{width:min(640px,100%);max-height:calc(100vh - 48px);box-sizing:border-box;display:flex;flex-direction:column;gap:12px;padding:20px;border-radius:16px;background:var(--gx-raised);border:1px solid var(--gx-card-border);color:var(--gx-text);font:14px/1.45 var(--font-sans);box-shadow:0 18px 60px rgba(0,0,0,.35)}
#lp-copy-dialog .lp-head{display:flex;align-items:center;justify-content:space-between;gap:12px}
#lp-copy-dialog .lp-title{font-weight:600;font-size:16px;color:var(--gx-fg)}
#lp-copy-dialog p{margin:0;color:var(--gx-muted);font-size:13px}
#lp-copy-dialog textarea{flex:1;min-height:180px;resize:vertical;box-sizing:border-box;width:100%;padding:10px 12px;border-radius:10px;border:1px solid var(--gx-line);background:var(--gx-code-bg,var(--gx-surface));color:var(--gx-text);font:12px/1.5 var(--font-mono)}
#lp-copy-dialog .lp-bar{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
#lp-copy-dialog .lp-status{flex:1;min-width:0;font-size:12.5px;color:var(--gx-muted)}
#lp-copy-dialog .lp-x{border:0;background:none;color:var(--gx-muted);font-size:20px;line-height:1;cursor:pointer;padding:2px 6px}
`;

const BRIDGE_JS = `(function(){
var lp=window.__livePage||{},g=window.ghostex;if(!g||typeof g.submit!=="function")return;
var copying=false,orig=g.submit;
function block(answers){var t=String(lp.title||document.title||"").replace(/"/g,"'");return 'Here are my answers to the Live page "'+t+'":\\n<live-page-answers page="'+(lp.id||"")+'" title="'+t+'" answered="'+new Date().toISOString()+'">\\n'+JSON.stringify(answers==null?{}:answers,null,2)+'\\n</live-page-answers>';}
function copyText(text,status){function done(){status.textContent="Copied. Paste it into your agent's chat.";}function by(ta){ta.focus();ta.select();try{if(!document.execCommand("copy"))throw 0;done();}catch(e){status.textContent="Select the text and copy it (Ctrl+C or Cmd+C).";}}
var ta=document.querySelector("#lp-copy-dialog textarea");if(navigator.clipboard&&navigator.clipboard.writeText&&window.isSecureContext)navigator.clipboard.writeText(text).then(done,function(){by(ta);});else by(ta);}
function dialog(answers){var text=block(answers),old=document.getElementById("lp-copy-dialog");if(old)old.remove();
var w=document.createElement("div");w.id="lp-copy-dialog";w.setAttribute("role","dialog");w.setAttribute("aria-modal","true");w.setAttribute("aria-label","Your answers");
w.innerHTML='<div class="lp-card"><div class="lp-head"><div class="lp-title">Your answers</div><button type="button" class="lp-x" aria-label="Close">\\u00d7</button></div><p>Paste this into your agent\\u2019s chat: it has everything the agent needs.</p><textarea readonly spellcheck="false" aria-label="Your answers, ready to paste"></textarea><div class="lp-bar"><span class="lp-status" role="status"></span><button type="button" class="gx-button gx-primary lp-again">Copy</button></div></div>';
var ta=w.querySelector("textarea"),st=w.querySelector(".lp-status");ta.value=text;
function close(){w.remove();document.removeEventListener("keydown",esc,true);}function esc(e){if(e.key==="Escape"){e.preventDefault();close();}}
w.addEventListener("click",function(e){if(e.target===w)close();});w.querySelector(".lp-x").addEventListener("click",close);w.querySelector(".lp-again").addEventListener("click",function(){copyText(text,st);});document.addEventListener("keydown",esc,true);
document.body.appendChild(w);copyText(text,st);window.__livePageCopied=text;}
g.submit=function(answers,onRetry){
  if(copying||g.exported){copying=false;dialog(answers);if(g.exported)return Promise.resolve({exported:true});var e=new Error("Copied, not sent. Paste the answers into your agent\\u2019s chat, or press Send.");e.__lpCopy=true;setTimeout(fix,0);setTimeout(fix,60);return Promise.reject(e);}
  return orig.call(g,answers,function(){if(typeof onRetry==="function")onRetry("Not sent yet: the live-page script on this computer can\\u2019t be reached. Trying again\\u2026 Your answers are kept. You can also press Copy answers and paste them into your agent\\u2019s chat.");});
};
function fix(){var s=document.querySelector(".gx-send .gx-send-status");if(s&&/^Copied, not sent/.test(s.textContent)){s.classList.remove("gx-error");}if(g.exported&&s&&/^Answers exported/.test(s.textContent))s.textContent="Copied. Paste it into your agent\\u2019s chat.";}
function mount(){var bar=document.querySelector(".gx-send");if(!bar||bar.querySelector(".lp-copy"))return!!bar;var send=bar.querySelector(".gx-send-button");if(!send)return false;
  var b=document.createElement("button");b.type="button";b.className="lp-copy";b.textContent="Copy answers";b.setAttribute("data-gx-tip","Copy your answers to paste into the agent\\u2019s chat");
  b.addEventListener("click",function(){if(g.answered){dialog(g.answers);return;}if(send.disabled){dialog({});return;}copying=true;send.click();if(copying){copying=false;}if(g.exported)setTimeout(fix,0);});
  var skip=bar.querySelector(".gx-skip-all");bar.insertBefore(b,skip||send);
  if(g.exported){var lab=send.querySelector("span");if(lab&&/export/i.test(lab.textContent))lab.textContent="Copy answers to paste";b.remove();}
  return true;}
function tryMount(n){if(mount()||n>100)return;setTimeout(function(){tryMount(n+1);},50);}
if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",function(){tryMount(0);});else tryMount(0);
})();`;

// ---------------------------------------------------------------------------------------------

const HELP = `live-page ${VERSION}: show a Live page and get the user's answers back

Usage (node live-page.mjs <command>):
  new <file.html> --title "..."    Write a page skeleton to fill in
  check <file.html>                Check a page (errors stop show; warnings are advice)
  show <file.html>                 Check, serve on 127.0.0.1 and open it; prints the link and page id
       [--no-open] [--app] [--browser] [--title "..."]
  wait [<page>] [--timeout <s>]    Block until the user sends; print the answers (exit 2 on timeout)
  answers [<page>] [--peek]        Print the answers now (exit 2 if none yet)
  list                             Pages, whether they were answered and read, and the server
  export <file.html> [--out f]     A standalone copy whose Send gives the answers to paste
  stop                             Stop the answer server (answers stay saved)
  doctor                           What this computer has: node, state folder, Ghostex, terminal
  selftest                         Run the whole loop without a browser (no agent needed)

<page> is the id show printed, the page's file, or nothing for the last page shown.
Add --json to any command for JSON output. State: ${'$'}LIVE_PAGE_HOME or ~/.live-page.`;

export async function main(argv = process.argv.slice(2)) {
  const [cmd, ...rest] = argv;
  const { pos, flags } = parseArgs(rest);
  const out = (r) => {
    if (r == null) return;
    process.stdout.write((flags.json ? JSON.stringify(r.json ?? r, null, 2) : r.text ?? JSON.stringify(r, null, 2)) + '\n');
  };
  try {
    switch (cmd) {
      case 'new':
        return out(cmdNew(pos, flags));
      case 'check':
        return out(cmdCheck(pos, flags));
      case 'show':
      case 'open':
        return out(cmdShow(pos, flags));
      case 'wait':
        return out(await cmdWait(pos, flags));
      case 'answers':
        return out(cmdAnswers(pos, flags));
      case 'list':
        return out(cmdList(pos, flags));
      case 'export':
        return out(cmdExport(pos, flags));
      case 'stop':
        return out(cmdStop(pos, flags));
      case 'doctor':
        return out(cmdDoctor(pos, flags));
      case 'selftest':
        return out(await cmdSelftest(pos, flags));
      case 'serve':
      case '__serve':
        return await runServer(flags);
      case 'version':
      case '--version':
        return out({ text: VERSION, json: { version: VERSION } });
      case undefined:
      case 'help':
      case '--help':
      case '-h':
        return out({ text: HELP, json: { help: HELP } });
      default:
        throw new CliError(`unknown command "${cmd}"\n\n${HELP}`);
    }
  } catch (e) {
    if (e instanceof CliError) {
      process.stderr.write(e.message + '\n');
      process.exitCode = e.code;
      return;
    }
    throw e;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === SCRIPT) main();
