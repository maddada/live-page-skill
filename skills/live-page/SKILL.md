---
name: live-page
description: "Show the user a Live page (one self-contained HTML page: a mockup, report, comparison, chart or plan, with questions, choices and a Send button) in their browser, and get their answers back. Use when the user asks for a Live page, a visual, a mockup to react to, or options side by side, or when a decision is easier to make by seeing it: write the page, run the bundled script to show it, then wait for the answers."
---

# Live pages

A Live page is one self-contained HTML file the user opens in their browser: mockups, a report, a
comparison, a chart, with questions they answer by clicking. They press **Send** and you get their
answers back, exactly as they picked and typed them.

`LP` below means `node <this skill's folder>/scripts/live-page.mjs` (the folder that holds this
SKILL.md; use its absolute path). Node 18 or newer is all it needs.

## Inside Ghostex? Use Ghostex's own Live pages

If `LP show` exits with code 3 and says you are inside Ghostex, stop using this skill: run
`ghostex visual guide pages`, write the page the same way and publish it with
`ghostex show <file.html>`. Its answers come back as your next message.

## The loop

1. **Write** the page to a file (below). Put it somewhere that is not committed, such as
   `.live-pages/<name>.html` or a temp folder. `LP new <file> --title "..."` writes a skeleton;
   `example.html` next to this file is a complete page to copy the shape of.
2. **Check** it: `LP check <file>`. Fix every error; fix the warnings too.
3. **Show** it: `LP show <file>`. It serves the page on `127.0.0.1` and opens it in the user's
   browser. It prints the link, the page id and the exact `wait` command. When it says it did not
   open the page (a VS Code or Cursor terminal, SSH), give the user the link and say where to open it.
4. **Tell the user** in one line what the page is for and that they answer it there.
5. **Wait for the answers** the way your agent supports (next section). The moment they press Send,
   `wait` prints the answers and exits.
6. **Act on them.** Say back what they picked in one line ("Building B with Google sign-in and
   magic links"), then do it.

Answers are saved to a file the moment the user presses Send and kept until you read them, so
nothing is lost if you were not waiting: `LP answers [<page>]` prints them later, `LP list` shows
every page and whether its answers were read. If the user pastes a `<live-page-answers>` block into
the chat (the page's **Copy answers** button makes one), read it exactly like `wait`'s output.

To change a page after showing it, edit the file and `LP show` it again: the same link shows the new
version, unanswered. Showing a page again after it was answered starts it over (the old answers are
kept in its folder).

## Waiting, per agent

`LP wait <page>` blocks until the user sends, prints the answers and exits 0. With
`--timeout <seconds>` it exits 2 when the time is up, and you run the same command again: the page
stays open and nothing is lost.

| Agent | How to wait |
| --- | --- |
| Claude Code | Run `LP wait <page>` as a **background** command (Bash with `run_in_background: true`), tell the user the page is open, and end your turn or keep working. You are woken when it exits; read its output. |
| Codex | Run `LP wait <page> --timeout 1800` in the turn and let it block (give the command a long timeout; if it comes back with exit 2, run it again). In a sandbox, `show` and `wait` need to run outside it (they start a local server): ask for that permission. |
| Cursor CLI | Run `LP wait <page> --timeout 600` in the turn; repeat on exit 2. |
| OpenCode | Run `LP wait <page> --timeout 110` (its shell tool stops commands after about 2 minutes) and repeat on exit 2 until the answers arrive. |
| Copilot CLI | Run `LP wait <page> --timeout 600` in the turn; repeat on exit 2. |
| Pi | Run `LP wait <page> --timeout 600` in the turn; repeat on exit 2. |
| Any other | Wait in the turn with a timeout shorter than your shell tool's limit, and repeat on exit 2. If you cannot block at all, end your turn and run `LP answers <page>` when the user says they sent it. |

## Writing the page

Start from this skeleton and keep its `<meta name="ghostex-page" content="v2">` (the kit keys on it,
and the same file then also works as a Live page in Ghostex):

```html
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="ghostex-page" content="v2">
<title>Settings: one page or tabs</title>
<style>
  /* Only what your own parts need: the kit paints the page, the cards, the questions and Send. */
</style>
</head>
<body>
<gx-questions submit="Send to the agent">
  <header>
    <span class="gx-eyebrow">Settings · layout</span>
    <h1>Settings: one page or tabs</h1>
    <p class="gx-lede">Two layouts for the settings page; pick one, then the header.</p>
    <div class="gx-chips"><span class="gx-chip"><b>38</b> settings</span></div>
  </header>

  <gx-wide><div class="gx-options">
    <section data-question="Q1" data-choice="tabs">
      <span class="gx-ribbon">Recommended</span>
      <h3>A. Tabs</h3><!-- a small but real picture of A -->
    </section>
    <section data-question="Q1" data-choice="one page">
      <h3>B. One long page</h3><!-- a small but real picture of B -->
    </section>
  </div></gx-wide>
  <gx-question tag="Q1" title="Which layout should I build?">
    <p>Why it matters, and why A is recommended.</p>
    <gx-choice value="tabs" recommended>A. Tabs<small>One page per area.</small></gx-choice>
    <gx-choice value="one page">B. One long page<small>Everything in one scroll.</small></gx-choice>
  </gx-question>
</gx-questions>
</body>
</html>
```

The page is served with Ghostex's page kit (MIT, bundled in `kit/`): its theme (dark and light, with
a switch), glass cards, the question kit, Pick buttons and Send. You write only the markup.

### Questions

- The whole page goes in one `<gx-questions submit="Send to the agent">`. A page that asks nothing
  uses `<gx-page>` instead; the kit ends it with a reply box and an Archive button, and you get
  `{"seen": true, "reply": "..."}`. Most pages should ask something: end a report with
  "What next?" and concrete choices, so the decision comes back to you.
- `<gx-question title="...">`: the title is the answer's key, so make each one unique, and make it
  a real question ("Which layout should I build?"), never "Q1" or "see above". `name="..."` gives
  a short key instead. `tag="Q1"` is an optional label. A `<p>` inside explains it.
- `<gx-choice value="tabs" recommended>A. Tabs<small>one line of detail</small></gx-choice>`:
  `value` is what you receive. Mark what you recommend with `recommended`, where it sits (never move
  it to the top). `picked` opens a choice already picked.
- `multiple` on the question for pick any; `type="text"` for a text box; `type="menus"` with named
  `<select>`s for a few small menus (the answer is `{"<menu name>": "<value>"}`).
- **One question per dimension.** Variants that differ in look and layout and extras are three
  questions, not one list. Use `multiple` unless the choices truly exclude each other.
- **Tie every variant to its choice** with `data-question` (the question's tag, name or title) and
  `data-choice` (the choice's value) on the element that wraps its title and picture: the kit puts a
  Pick button on it. List the choices in the same order as the variants above them.
- **Each question sits right under what it asks about**: a mockup, its question, the next mockup,
  its question. Never all the pictures first and all the questions at the end.
- **A list you ask about carries its picks on its rows**: `<gx-pick value="id">` (Markdown inside,
  starting with a heading) or `data-pick="id"` on any row, inside an element with
  `data-question="Q2"`; the question under them has no `<gx-choice>` lines. Never list items and
  then repeat them as choices.
- Don't write your own form, Send button, "Other" choice, note boxes or "Anything else?" box: the
  kit adds Other and a note to every choice question, an "Anything else?" box, Skip all, Send and
  Copy answers.

What comes back is keyed by each question's name or title:

```json
{
  "Which layout should I build?": "tabs",
  "Which layout should I build? (note)": "keep search at the top",
  "Which extras go in?": ["google", "Other / none of these"],
  "Which extras go in? (note)": "Linux too",
  "Additional notes": "anything typed in Anything else?, with [Image #1](/path/to/pasted.png)"
}
```

A question left blank arrives as `"skipped"`. A row's note on a pick list arrives as
`"<key> · <value> (note)"`. Pasted images arrive as a path you can open.

### Layout

- Everything sits in one 720px column. `<gx-wide>` (up to 1120px) only for something wider: a
  whole-window mockup or variants side by side.
- Side by side only in rows that wrap: `<div class="gx-options">` (2 to 4 options),
  `<div class="gx-grid">` (cards), `<div class="gx-stats">` (numbers). Never a bare
  `grid-template-columns: 1fr 1fr` or fixed widths in a row; it must read at 360px on a phone.
- A mockup keeps its real size: give it a fixed width and put it in a `<div class="gx-frame">`,
  which scrolls sideways on a narrow window. Notes go above or below it, never beside it.
- Text in grid or flex children gets `min-width: 0` and wraps; long paths and URLs get
  `overflow-wrap: anywhere`. Pills, chips and ids get `white-space: nowrap`.

### Look

- **A strong top**: a short `.gx-eyebrow` (area · purpose), an `<h1>` that says what is being
  decided, a one-line `.gx-lede`, a row of `.gx-chip` facts (`<span class="gx-chip"><b>38</b> files</span>`).
- **Compare side by side**: each option a tied card with a title (`A. Name`), one line on how it
  works, a small but real picture (a mini UI, a chart, a before and after) and two or three
  `.gx-stat` numbers (`<div class="gx-stat"><small>Time</small><b>28m</b></div>`), all on the same
  scale. `<span class="gx-ribbon">Recommended</span>` on the recommended one.
- **Not too long**: header, options and question fit roughly one screen. Several short pages beat
  one long one.
- Use the kit's parts instead of your own: `<div class="gx-callout" data-tone="warn|good|bad">`,
  `<div class="gx-card">`, `<figure class="gx-figure">` with a `<figcaption>`, `<gx-tabs>` with
  `<section data-tab="Before">` children, `<button class="gx-button gx-primary">`. Tables, lists,
  `<code>` and `<pre>` are styled already.
- **No page chrome**: no colours, backgrounds, fonts, padding or max-width on `html`, `body` or
  `:root`, no wrapper of your own, no dark mode switch (the kit has one).
- **Colours from the theme tokens**, so both themes work: `--gx-fg` (titles), `--gx-text`,
  `--gx-muted`, `--gx-line`, `--gx-line-strong`, `--gx-surface` (soft fills in a card),
  `--gx-raised` (controls), `--gx-card` and `--gx-card-border` (glass), `--gx-pick` (a highlight),
  `--gx-accent`, `--gx-warn`, `--gx-good`, `--gx-bad`, `--gx-code-bg`, `--chart-1` to `--chart-6`,
  `--font-sans`, `--font-mono`. Never an opaque slab behind your content.
- **A mockup of a real app looks like that app**: opaque fills in the app's own colours (a dark set,
  and a light set under `[data-gx-theme=light]`), its real sizes, fonts and radii, real icons (never
  letter avatars), one accent colour at most, and only words the app shows.
- Plain words; no em dashes (`LP check` refuses them).

### Files and limits

- One self-contained file. Libraries from an https CDN load; prefer inline SVG and CSS.
- Local images: by a path relative to the HTML file (`<img src="img/shot.png">`), served from its
  folder, or by absolute path (embedded when shown).
- Your own scripts may call `ghostex.submit(answers)` to send any JSON (a ranking, a spot on a
  mockup) and `ghostex.saveDraft(value)` / `ghostex.draft` to keep state while the user works.
- Answers are one set per page: once sent the page is locked and shows them.

## Other commands

- `LP export <file> [--out <file>]`: a standalone copy that opens with no server (to send to
  someone); its Send button gives the answers as a block to paste back to you.
- `LP list`, `LP stop` (stops the server; answers stay saved), `LP doctor` (what this computer has),
  `LP selftest` (the whole loop with no browser).
- `LP show <file> --app` opens it in an app window (Chrome, Edge or Brave) instead of a tab;
  `--no-open` only prints the link; `--browser` opens the system browser even in VS Code or Cursor.
- State lives in `~/.live-page` (`LIVE_PAGE_HOME` moves it): the server's port and key, and per page
  its snapshot, draft, answers and pasted images.

## Safety

The server listens on `127.0.0.1` only, on a random port, and every link carries a random key; it
refuses other hosts and posts from other sites, and serves only the shown page and the files next to
it. Show only pages you wrote: a page's answers speak to you in the user's name.
