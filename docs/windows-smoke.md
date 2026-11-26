# Windows smoke test

Exact steps to check the skill on a Windows PC, in PowerShell. About 10 minutes. Every step says
what you should see; copy the output of any step that does not match.

## 0. What you need

- Node 18 or newer: `node -v` prints `v18` or higher.
- Git: `git --version`.
- A browser (Edge is always there).

## 1. Get the repo

```powershell
cd $env:USERPROFILE
git clone https://github.com/maddada/live-page-skill
cd live-page-skill
```

## 2. The script's own checks

```powershell
npm test
```

Expect `pass 4` and `fail 0`.

```powershell
node skills\live-page\scripts\live-page.mjs selftest
```

Expect 22 `PASS` lines and `All 22 checks passed (win32, node v...)`.

```powershell
npm run check
node skills\live-page\scripts\live-page.mjs doctor
```

Expect `ok: ... files checked`, then the doctor's table with `platform win32`, `page kit found` and
`inside Ghostex no` (if it says yes, run this from a plain PowerShell window, not a Ghostex one).

## 3. A real page in the browser, with a path that has spaces

```powershell
$env:LIVE_PAGE_HOME = "$env:TEMP\lp smoke home"
New-Item -ItemType Directory -Force "$env:TEMP\lp smoke pages" | Out-Null
Copy-Item skills\live-page\example.html "$env:TEMP\lp smoke pages\Sign up flow.html"
node skills\live-page\scripts\live-page.mjs show "$env:TEMP\lp smoke pages\Sign up flow.html"
```

Expect: the page opens in your default browser (dark or light, following Windows), with three
cards side by side, each with a Pick button, and three questions under them. The command prints
`Showing "Sign-up: which flow should I build?" (page sign-up-flow-xxxxxx)`, the link and the
`wait` command.

Now open a **second** PowerShell window in the same folder and run (same `LIVE_PAGE_HOME`):

```powershell
cd $env:USERPROFILE\live-page-skill
$env:LIVE_PAGE_HOME = "$env:TEMP\lp smoke home"
node skills\live-page\scripts\live-page.mjs wait
```

It blocks. In the browser:

1. Press **Pick** on "B. Short wizard". Type `windows note` in its Note box.
2. Tick "Google sign-in" and "Magic link by email".
3. Type `Windows test` in "What should the sample project be called?".
4. Press **Copy answers**. A "Your answers" box opens and says `Copied.`. Open Notepad and paste:
   you should see `Here are my answers to the Live page ...` and a `<live-page-answers>` block with
   the same picks. Close the box.
5. Press **Send to the agent**. The button turns into "Sent" and the page says it was sent.

The second window should print, right away:

```text
The user answered "Sign-up: which flow should I build?":
<live-page-answers page="sign-up-flow-..." title="Sign-up: which flow should I build?" answered="...">
{
  "flow": "wizard",
  "flow (note)": "windows note",
  "extras": [
    "google",
    "magic"
  ],
  "name": "Windows test"
}
</live-page-answers>
```

Reload the page in the browser: it shows your answers, locked, with an "Answered" note.

## 4. Answers survive the server stopping

```powershell
node skills\live-page\scripts\live-page.mjs show "$env:TEMP\lp smoke pages\Sign up flow.html" --no-open
node skills\live-page\scripts\live-page.mjs list
```

`show` again starts the page over (unanswered). Open the printed link in the browser, pick
anything, then stop the server **before** pressing Send:

```powershell
node skills\live-page\scripts\live-page.mjs stop
```

Press **Send** in the browser. Expect a message under the buttons: `Not sent yet: the live-page
script on this computer can't be reached. Trying again...`. Now run:

```powershell
node skills\live-page\scripts\live-page.mjs wait --timeout 60
```

Within about 10 seconds the page says it was sent and `wait` prints your answers (it restarted the
server on the same link).

## 5. App window and the Ghostex check

```powershell
node skills\live-page\scripts\live-page.mjs show "$env:TEMP\lp smoke pages\Sign up flow.html" --app
```

Expect the page in an Edge (or Chrome) app window with no tabs or address bar, and the output says
`Opened it in an app window (msedge)` or `(chrome)`.

```powershell
$env:GHOSTEX_SESSION_ID = "S1-test-x"
node skills\live-page\scripts\live-page.mjs show "$env:TEMP\lp smoke pages\Sign up flow.html"
echo "exit $LASTEXITCODE"
Remove-Item Env:GHOSTEX_SESSION_ID
```

Expect a message that starts `You are inside Ghostex, which has Live pages built in` and `exit 3`.

## 6. Clean up

```powershell
node skills\live-page\scripts\live-page.mjs stop
Remove-Item -Recurse -Force "$env:TEMP\lp smoke home", "$env:TEMP\lp smoke pages"
Remove-Item Env:LIVE_PAGE_HOME
```

## 7. Optional: with an agent

In a scratch folder, install the skill for your agent and ask for a page:

```powershell
mkdir $env:TEMP\lp-agent; cd $env:TEMP\lp-agent; git init
npx skills@latest add maddada/live-page-skill -a claude-code -y   # or -a codex
claude "Use the live-page skill to ask me, on a Live page, which colour theme (Ocean, Forest, Sunset) and which features (dark mode, due dates, tags) a tiny to-do app should have. Wait for my answers, then write them to result.json."
```

Answer in the browser and press Send; the agent should write `result.json` with exactly your picks.

## What to send back

The output of steps 2 and 3 (both windows), and anything that did not match.
