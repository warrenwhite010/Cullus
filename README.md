# Cullus 🤖

A local AI assistant that runs entirely on your machine. `cullus` starts a web
server, opens a dashboard in your browser, and drives **local Ollama models** with
access to your filesystem, your Obsidian vault, GitHub, a running [Unity Editor](#unity),
and the web — all over MCP.

*Cullus* is Latin for a windlass: a hoisting device. The tools do the lifting; the model
decides where to pull.

Despite the name, the interface is a browser dashboard rather than a terminal REPL —
the CLI is how you launch it.

Everything is local: no API keys required, no data leaves the machine except the
web searches you explicitly trigger. Work can also run [on a schedule](#scheduled-jobs)
without the browser open.

---

## Quickstart

From nothing to a running dashboard. Copy the whole block:

```bash
# 1. Ollama — the models run here
brew install ollama
ollama serve &                 # leave this running
ollama pull qwen3.5:9b         # ~6 GB, one time

# 2. Cullus
git clone <this repo> && cd Cullus
npm install                    # installs AND builds
npm start
```

The dashboard opens at <http://localhost:3000>.

If Ollama is already running with a model pulled, it is just the last three lines.

| Prerequisite | |
|---|---|
| **Node.js** | 18+ (uses global `fetch`). Developed on v26. |
| **Ollama** | Running locally, with at least one model pulled. |
| **macOS** | Only for the native Finder folder picker. Everything else is cross-platform. |

Cullus is tuned for small local models (roughly 4B–9B). See
[Working with small models](#working-with-small-models). Nothing else needs configuring to
start — no API keys, no config file to write. See [First run](#first-run) for the three
optional steps that make it useful.

---

## Install

Three commands, if you skipped the block above:

```bash
git clone <this repo> && cd Cullus
npm install
npm start
```

`npm install` **builds automatically** — a `prepare` script compiles TypeScript and copies
the dashboard once dependencies are in place, so there is no separate build step to forget.
`npm start` rebuilds and runs, which is why it works even if something is stale.

Optional, once per machine, for an `cullus` command that works from any directory:

```bash
npm link
assistant
```

| Command | What it does |
|---|---|
| `npm install` | Install dependencies **and build**. |
| `npm start` | Build, then run. Use this if anything seems off. |
| `npm run serve` | Run the existing build without recompiling. Fastest restart. |
| `npm run build` | Compile only. Refuses to run if a prerequisite is missing. |
| `npm link` | Create the global `cullus` command. |

Neither `node_modules/` nor `dist/` is committed — `npm install` produces both, so a clone
stays small and a rebuild never churns generated files into git.

<details>
<summary>When the automatic build is skipped</summary>

`scripts/prepare.mjs` skips quietly, rather than failing the install, when building is
impossible or pointless: no `src/`, no `tsconfig.json`, or no TypeScript (a `--omit=dev`
install). It prints the reason. A build that fails in a normal clone is **not** skipped —
that is a real error and `npm install` reports it, so run `npm run build` to see it alone.
</details>

### First run

The dashboard works immediately with no configuration — but three steps make it useful, in this
order:

1. **Pick a model** in the sidebar dropdown. Everything is tuned for roughly 4B–9B; a 14B model
   works but each turn costs minutes. See [Working with small models](#working-with-small-models).
2. **Grant a directory** in Settings → 📂 Directories. Nothing on disk is readable until you do.
   The filesystem server is [read-only by default](#read-only-by-default).
3. **Point it at your vault** in Settings → 🔌 Connections, if you use Obsidian. There is
   deliberately no default vault path.

Then type a question. Two keys do most of the work in the input box:

| Key | What it does |
|---|---|
| `/` | Every command, filtered as you type. `↑ ↓` to browse, `Tab` to complete. |
| `@` | Find a file and insert its path. Searches your granted directories only. |

Two commands worth knowing on day one:

| | |
|---|---|
| `/doctor` | Checks everything and names a fix for anything failing. Start here if something is off. |
| `/effort low\|medium\|high` | Trades depth for speed. `low` for lookups, `high` for multi-step work. |
| `/fidelity blockout\|playable\|production` | How much polish to build to. `blockout` for a fast demo, `production` when it has to ship. |

If a turn feels slow, open **Settings → ⚡ Performance** — it shows what your next turn will cost
before it runs. See [Performance](#performance).

### If `npm run build` prints a page of tsc flags

That means `tsc` found no `tsconfig.json` in the working directory: it prints its help
banner and **exits 0**, so the rest of the chain runs, `dist/public` is deleted, the copy
fails, and no `dist/index.js` is produced. The next thing you see is
`command not found: assistant`, which looks unrelated.

Both are now caught. `npm run build` runs `scripts/preflight.mjs` first and fails with a
named reason:

```
❌ Cannot build Cullus:

 • tsconfig.json is missing from /path/to/Cullus.
   Without it, tsc prints its help text, exits 0, and no dist/ is built.
   Fix: re-clone the repository — this file is tracked in git and must be present.
```

It checks the working directory, `tsconfig.json`, `src/index.ts`, `src/public/index.html`,
that TypeScript is installed, and that Node is 18+. `tsc` is invoked as
`tsc -p tsconfig.json`, so a missing config is an error rather than a help banner, and
`scripts/postbuild.mjs` then verifies `dist/index.js` and `dist/public/index.html` exist
before reporting success — and tells you whether `cullus` is linked on this machine.

### `requirements.txt`

The dependency manifest you edit and commit. One `package@range` per line with a
comment explaining why it's needed; `--dev` marks a devDependency.
`npm run deps` parses it and shells out to `npm install`, so `package.json`
follows from it.

npm itself does not read `requirements.txt` — add packages there, run
`npm run deps`, and `package.json` updates.

`undici` is listed there for one specific reason: it provides a *scoped* TLS agent
for the Obsidian plugin's self-signed localhost certificate, so the alternative
(`NODE_TLS_REJECT_UNAUTHORIZED=0`, which disables verification process-wide) is
never needed.

### Flags

| Flag | Effect |
|---|---|
| `-p, --port <n>` | Port for this run only. Does not change the saved default. |
| `-m, --model <tag>` | Model for this run only. Does not change the saved default. |
| `--no-open` | Start the server without launching a browser. |

Both `--port` and `--model` are deliberately **not** persisted — a one-off flag
should not silently redefine your default.

---

## Configuration

A missing or half-filled `~/.cullus/config.json` is **not** an error. On first run the file is
created with defaults; on later runs every field is checked by type, anything wrong is replaced with
its default and **named** in one warning, and startup continues:

```
⚠️  ~/.cullus/config.json: using defaults for vaultPath (not a usable path),
    fanout.workers (not a number). Everything else was kept, and saving from the
    dashboard will rewrite the file correctly.
```

Fill the gaps in from **Settings → Connections** and the file is rewritten correctly — tokens go to
the Keychain, never into the JSON. Before this, a single wrong-typed value (a numeric `vaultPath`,
say) killed the whole boot with `input.trim is not a function`, naming neither the field nor the
file.

Persistent settings live in `~/.cullus/config.json`, so behaviour is identical
from any working directory:

```json
{
  "vaultPath": "/Users/you/Documents/MyVault",
  "defaultModel": "qwen3.5:9b",
  "allowedPaths": ["/Users/you/code"],
  "port": 3000,
  "mcpReadOnly": { "filesystem": true, "obsidian-live": true, "github": true },
  "fanout": { "enabled": true, "workers": 4, "plannerModel": "qwen3.5:9b" },
  "customServers": { "sqlite": { "transport": "stdio", "command": "npx", "args": ["-y", "mcp-server-sqlite"] } },
  "fixCommands": { "/Users/you/code/api": { "build": "make", "verify": "make test" } },
  "activeSessionId": "mt09juxp-k2ch",
  "connections": { "obsidian": { "baseUrl": "https://127.0.0.1:27124" } },
  "maxContextTokens": 200000,
  "exitWhenLastClientDisconnects": true,
  "exitGraceSeconds": 10,
  "performance": {
    "toolBudget": 28,
    "maxHistoryMessages": 40,
    "maxToolResultChars": 8000,
    "stepRetries": 2,
    "firstTokenTimeoutMs": 600000,
    "stepIdleTimeoutMs": 120000,
    "stepTotalTimeoutMs": 900000,
    "toolTimeoutMs": 120000
  }
}
```

Everything under `performance` is editable from **Settings → Performance** while the app is
running — see [Performance](#performance). Each value is range-checked independently, so one
bad number costs you that dial rather than the whole block.

Environment variables override the file:

| Variable | Purpose |
|---|---|
| `OBSIDIAN_VAULT_PATH` | Vault location |
| `ASSISTANT_MODEL` | Default model tag |
| `ASSISTANT_PORT` | Web UI port |
| `OLLAMA_HOST` | Ollama URL (default `http://localhost:11434`) |
| `OBSIDIAN_API_URL` | Live-plugin MCP endpoint (default `https://127.0.0.1:27124/mcp/`) |
| `BRAVE_SEARCH_API_KEY` / `TAVILY_API_KEY` | Upgrade web search off scraping |
| `ETSY_MCP_SERVER_PATH` | Path to a locally built Etsy MCP server. Overrides the value saved in Settings → Connections. |
| `ETSY_API_KEY`, `ETSY_SHARED_SECRET` / `ETSY_CLIENT_SECRET` | Etsy credentials. Also settable in Settings → Connections → Etsy. |
| `ASSISTANT_STEP_TIMEOUT_MS` | Silence allowed *after* output starts (default `120000`) |
| `ASSISTANT_STEP_FIRST_TOKEN_TIMEOUT_MS` | Time allowed to read the prompt before the first token (default `600000`) |
| `ASSISTANT_STEP_TOTAL_TIMEOUT_MS` | Hard ceiling on one inference step (default `900000`, `0` disables) |
| `ASSISTANT_TOOL_TIMEOUT_MS` | Wall-clock cap on a single tool call (default `120000`). `ask_user` is exempt — see below |
| `ASSISTANT_APPROVAL_TIMEOUT_MS` | How long manual mode waits for Approve/Deny (default `300000`) |
| `ASSISTANT_INQUIRY_TIMEOUT_MS` | How long `ask_user` waits for you (default `600000`); a timeout reads as "no answer", never as an error |
| `ASSISTANT_WEB_TIMEOUT_MS` | Search / page-fetch timeout (default `20000`) |
| `ASSISTANT_MAX_PAGE_CHARS` | Max characters kept per fetched page (default `12000`) |
| `OBSIDIAN_API_KEY` | Token for the live Obsidian plugin. Prefer storing it in the Keychain via Settings → Connections — see [API tokens](#api-tokens). |
| `GITHUB_PERSONAL_ACCESS_TOKEN` / `GITHUB_TOKEN` / `GH_TOKEN` | GitHub token; any of the three is accepted |
| `GITHUB_MCP_COMMAND` | Override the GitHub MCP server command |

The four timeout variables above **override** the matching Settings → Performance dials. The
pane says so explicitly when one is set, because a control that silently does nothing is worse
than no control.

Secrets are **never** written to `config.json` — it has no token fields at all.
See [API tokens](#api-tokens).

There is no `.env` support — the project does not load dotenv. Export variables
in your shell.

There is deliberately **no default vault path**. Vault tools stay disabled, with
an actionable message, until you set one.

---

## Slash commands

Type `/` in the dashboard for a filterable menu — `↑`/`↓` to browse, `Tab` to
complete, `Esc` to close.

### Repair
| Command | Description |
|---|---|
| `/fix <symptom>` | Repair a project until build **and** verify pass, or revert everything |
| `/fix <symptom> --target <path>` | Repair a granted project instead of Cullus itself |
| `/fix <symptom> --rounds <1-30>` | How many attempts to allow (default 3) |
| `/fix runs` | Recent repairs, their outcome and their revert ids |
| `/fix revert [id]` | Restore every file a run modified (defaults to the last run) |
| `/fix targets` | Repairable projects, with the build/verify commands detected for each |
| `/fix set <path> --build "<cmd>" --verify "<cmd>"` | Override detection for one project |
| Rounds | 1–30 per run, via `--rounds` |
| `/settings` | Open Settings → Connections |

### Upgrade
| Command | Description |
|---|---|
| `/upgrade` | Fast-forward to the latest `origin/main`, rebuild, relaunch |
| `/upgrade --check` | Show the pending commits and change nothing |
| `/upgrade runs` | Recorded upgrades, their outcome and their revert ids |
| `/upgrade revert [id]` | Go back to the version an upgrade replaced (defaults to the last one) |

`/upgrade` replaces the app while the app is running, so it is deliberately
cautious. It **refuses** when the working tree is dirty, when history has
diverged from the upstream branch, or when the install is not a git checkout —
each with the specific reason and what to do about it.

Before anything is written it takes two independent ways back: a `git stash
create` checkpoint, and a copy of every tracked file into
`~/.cullus/upgrades/<id>/snapshot/`, outside the tree being replaced. It then
exits and hands off to a detached script, because `npm run build` deletes and
rewrites `dist/` — the directory the running process was loaded from.

If the merge, the install, the build or the post-build smoke check fails, that
script **rolls back automatically**: reset to the previous commit, restore the
snapshot, rebuild, and report what went wrong. See `src/core/upgrade.ts`.

### Diagnostics
| Command | Description |
|---|---|
| `/doctor` | 15-point health check; every failure names its fix |
| `/status` | Ollama, vault and MCP state in one view |
| `/tools` | Every tool the model can currently call |
| `/newtool` | Add a tool — `/newtool <name> \| <what it does> \| <command>`. See [Recipes](#recipes). |
| `/mcp` | Connection state and mode of each MCP server |
| `/tokens` | Session token usage breakdown |
| `/cron` | Scheduled jobs — `list`, `add`, `monitor`, `runs`. See [Scheduled jobs](#scheduled-jobs). |

### Research
| Command | Description |
|---|---|
| `/deep-research <topic>` | Six-stage pipeline → cited report |
| `/search <query>` | One-off web search, then read the top results |

### Behaviour
| Command | Description |
|---|---|
| `/effort low\|medium\|high` | Thinking depth, generation cap and tool-step budget (6 / 15 / 30 steps) |
| `/fidelity blockout\|playable\|production` | How much polish to build to (default: `playable`). Orthogonal to `/effort` |
| `/plan` | Plan-first mode: withholds every mutating tool |
| `/goal <text>` | Standing goal checked before the model stops |
| `/adhd` | Action-first, numbered output with no filler |
| `/debug` | Stream every inference step to a sidebar panel |
| `/skills [name]` | List or load reusable prompt macros |
| `/verify <thing>` | Prove a change works end-to-end |
| `/run` | Launch this project's app and confirm it starts |

### Setup
| Command | Description |
|---|---|
| `/models`, `/model <tag>` | List or switch the active model |
| `/vault [set <path>\|clear\|browse]` | Show or set the vault |
| `/paths [add\|remove <path>]` | Directories the model may access |
| `/browse` | Native Finder picker to grant a directory |

### Session
| Command | Description |
|---|---|
| `/clear` | Clear the transcript on screen only |
| `/reset` | Start a new chat; the previous one stays in the sidebar. Aborts a running turn and clears the checklist |
| `/pipeline` | Toggle fan-out; `/pipeline workers <1-8>`, `/pipeline mode fanout\|roles` |
| `/exit` | Shut down the server |
| `/help` | List every command |

Session switches (`/effort`, `/fidelity`, `/plan`, `/goal`, `/adhd`, `/debug`) are **not**
persisted — waking up tomorrow in plan mode with yesterday's goal would be worse
than retyping. Active switches show as chips beside the title so they can't be
silently on.

---

## MCP servers

| Server | Scope | Transport | Read-only mode |
|---|---|---|---|
| `filesystem` | Directories you grant via `/paths` | stdio | **Yes** (client-enforced) |
| `obsidian-live` | The vault Obsidian currently has **open** | HTTPS + bearer token | **Yes** (client-enforced) |
| `github` | Repos, issues and pull requests | stdio | **Yes** (client-enforced) |
| `unity` | The running Unity Editor: scenes, GameObjects, prefabs, scripts | stdio | No — see [Unity](#unity) |
| `etsy` | Optional; set it up in Settings → Connections → Etsy | stdio | No |
| `oanda-trading` | Your OANDA account: analysis always, orders only when unlocked | stdio | **Yes** — locked by default |

`oanda-trading` ships with this repo (`src/mcp/oanda/`) rather than being an
external package. Set it up in Settings → Connections → OANDA; see
[src/mcp/oanda/README.md](src/mcp/oanda/README.md) for the tool list, the safety
model and how it drives the OandaVisualBot app.

### Session recovery

The plugin issues an `mcp-session-id` at connect. When that session goes away — Obsidian restarts,
the plugin reloads, it expires — the server answers `{"error": "Session not found"}` with HTTP 404.
Every vault call then failed until `cullus` was restarted, which from the chat side looked like
the vault being unreadable; models would confabulate explanations ("the folder cannot be located")
rather than report a transport failure.

`callTool` now detects a dead session (by 404 or by message) and re-registers that server, then
retries the call once. Reconnection rebuilds the tool routes, so the client is re-resolved rather
than reused. It is logged in Activity as `session expired · reconnecting and retrying the call once`.

Proven by `node scripts/verify-obsidian-session.mjs`, which terminates the live session behind the
client and requires the next call to succeed anyway.

`obsidian-live` is the **only** route to the vault. An earlier `obsidian` server
read the vault's files straight off disk (mcpvault), which needed no token and no
running app — so it also bypassed the plugin entirely and appeared "connected" even
when nothing was authenticated. It was removed.

Every server with a read-only mode gets **🔒 Read-only / ✏️ Read-write** buttons in
Settings → MCP Servers. All default to read-only.

### The two ways to reach a note

| | `filesystem` | `obsidian-live` (plugin) |
|---|---|---|
| Sees | bytes in directories | the **running app** |
| Obsidian must be open | no | **yes** |
| Which vault | any granted path | whatever Obsidian has open |
| Authenticated | n/a (local process) | **yes** — bearer token over HTTPS |
| Frontmatter as data | no | **yes** |
| Tag rollups, wiki-links | no | **yes** |
| **Active note** | no | **yes** |
| **Obsidian's own link index / backlinks** | no | **yes** |
| **Run Obsidian commands** | no | **yes** |
| Plugin-computed content (e.g. Dataview) | no | **yes** |
| Read code, images, non-vault files | **yes** | no |

`obsidian-live` understands things `filesystem` structurally cannot: frontmatter
parsed as data, `parent/child` tag rollups, `[[Note]]` resolved through Obsidian's
own link index, document maps of heading structure, and patching one heading in
place instead of line-based replacement on prose. It also covers what only exists
while the app is running — the active note, backlinks resolved by Obsidian itself,
and the command palette.

Rule of thumb: `filesystem` for code, `obsidian-live` for notes. If Obsidian is not
running, there is no vault access — that is deliberate.

### Setting up `obsidian-live`

1. In Obsidian, install and enable the **Local REST API with MCP** community
   plugin (Adam Coddington). v5+ includes the MCP server; earlier versions are
   REST-only and won't work here.
2. Copy the API key from **Obsidian → Settings → Local REST API with MCP**.
3. Paste it into **Settings → Connections → Obsidian Vault → Connect**. The server
   reconnects immediately — no restart. If the Claude Code CLI already has this token
   in `~/.claude.json`, it is discovered automatically and the field shows
   "🤖 Claude CLI".

The plugin serves HTTPS on `127.0.0.1:27124` with a self-signed certificate. That
exception is applied through a dedicated undici agent used **only** by this
transport, so nothing else in the process becomes willing to accept a bad
certificate, and it is refused outright for any non-loopback host.

### Tool name collisions

Several servers offer `list_directory` (and `move_file` in read-write mode). Rather
than dropping one, the lower-priority server's version is exposed under a prefixed
alias so both stay callable:

```
list_directory                 → filesystem    → [FILE] .gitignore [DIR] dist …
obsidian-live_list_directory   → obsidian-live → {"dirs":["01_Inbox",…],"files":[…]}
```

Ownership is decided by declared priority (`filesystem` 10, `obsidian-live` 15,
`etsy` 30 — lower wins), **not** connection order, so the outcome is
identical regardless of how the app booted. If a higher-priority server connects
late, the incumbent is demoted to its alias rather than the newcomer being dropped.

---

## Unity

Two halves, and they need opposite things from the Editor:

- **The MCP bridge** drives a **running** Editor — creating GameObjects, writing and
  attaching scripts, building prefabs, saving scenes. There is no custom Unity code for
  this: the Unity CLI ships its own MCP server, so it is a server definition rather than a
  set of hand-written tools.
- **`unity_symbol` and `unity_compile`** are local tools that work with the Editor
  **closed**, and answer what the bridge cannot: *does this C# compile, and which `using`
  is it missing?*

### `unity_commands`: the catalogue, because 149 will not fit in 28

The bridge exposes **149** Editor commands. The per-turn tool budget is **28**. Those two
numbers mean the model structurally cannot see most of what Unity can do, and what it does
see is a slice chosen by a keyword ranker. Asked to *"create a cube"*, a small model
reported that no such tool existed while `create_gameobject` sat connected, one call away.

`unity_commands` is one cheap tool that lists and searches the other 149, built from the
same `unity command --json` data the MCP server is serving — so it cannot drift from what
the Editor actually offers.

```jsonc
// unity_commands { }                            -> all 149, grouped by category
// unity_commands { "query": "create a cube" }   -> create_gameobject, ranked first
// unity_commands { "query": "create_gameobject" } -> its full argument list
```

Two rules make it work rather than just exist:

- It is **pinned against the budget** on any Unity question. Everything else in the ranking
  can be cut and recovered from; cutting the one tool that names what was cut cannot.
- Commands outside `unityToolTags` are listed and marked `hidden`, with the config key that
  hides them. A capability you have switched off should read as switched off, not as absent.

Filler words under three characters are dropped from the search. With them in, *"create a
cube"* matched 147 of 149 commands — nearly every command name contains an `a`.

### A connected server with no tools

A server's tool list is read **once, at connect**. `unity mcp` connects happily with no
Editor running and advertises zero tools, so starting Cullus before opening the project
leaves a server that reports "connected" all session while offering nothing — the symptom is
`/tools` showing two Unity entries (the local pair) and 149 missing.

The tools popup now names that state explicitly, under **connected, no tools**, with a
**Reconnect** button that re-spawns the server and re-reads its list. Reconnecting rebuilds
from the server definition rather than the cached spawn config, so Unity's tag map is re-read
too.

### `unity_symbol`: which namespace, offline

This exists because of one measured run. Given
`Assets/Scripts/StormSky.cs(71,37): error CS0103: The name 'RenderQueue' does not exist in
the current context`, a five-worker fan-out spent **23 minutes**: `web_search` failed on
every call, workers hand-fetched DuckDuckGo, Mojeek and Ecosia through `fetch_url`, and
four of the five independently read the same file. The answer was one line —
`using UnityEngine.Rendering;`.

None of that was a model failure. The assistant had **no way to answer a Unity question
except guessing or searching the web**, so that is what it did.

`unity_symbol` resolves a bare type name to its namespace from the XML documentation files
Unity ships beside every managed assembly. They carry fully-qualified type ids in plain
text, which makes a namespace lookup a text search rather than an ECMA-335 metadata parse:

```xml
<member name="T:UnityEngine.Rendering.RenderQueue">
```

```jsonc
// unity_symbol { "name": "RenderQueue" }
{
  "symbol": "RenderQueue",
  "editorVersion": "6000.3.12f1",
  "matches": [{
    "fullName": "UnityEngine.Rendering.RenderQueue",
    "assemblies": ["UnityEngine.CoreModule", "UnityEngine"],
    "usingDirective": "using UnityEngine.Rendering;"
  }]
}
```

No Editor, no network, ~3,800 types indexed once per editor version and cached. It takes
the **quoted** identifier out of a pasted error, because C# writes *The name
`'RenderQueue'` does not exist in the current context* — reading the last identifier
instead answers confidently about a type called `context`.

Unity ships an umbrella `UnityEngine.dll` that forwards to the module DLLs, so every type
is listed at least twice. Those are grouped into one match with both assemblies named:
reporting "2 types share this name, pick one" is a fabricated ambiguity, and a small model
handed one goes to the web to break a tie that does not exist.

### `unity_compile`: the only real verification

Runs the Editor in batch mode and parses `file(line,col): error CS####` back out of the
log. Unity prints each diagnostic three or four times across compiler output, console and
summary, so identical ones are collapsed — a model handed the same error four times treats
it as four problems.

```jsonc
// unity_compile { "projectPath": "~/TronGame" }
{ "compiled": false, "errorCount": 1, "errors": [
    { "file": "Assets/Scripts/StormSky.cs", "line": 71, "column": 37,
      "code": "CS0103", "message": "The name 'RenderQueue' does not exist…" } ] }
```

Three things refuse it, each with its reason:

| Refusal | Why |
|---|---|
| Directory not granted | Batch mode writes `Library/` and `Temp/`, so it uses the same `/paths` consent gate as `/fix` |
| `Temp/UnityLockfile` exists | The Editor has the project open and batch mode cannot take the lock — **close Unity first** |
| Editor version not installed | Reports the version the project asks for rather than compiling with a guess |

`CULLUS_UNITY_EDITOR` points at a binary in a non-standard location;
`CULLUS_UNITY_EDITOR_DIR` at an alternative Hub directory.

`/fix` recognises a Unity project by `ProjectSettings/ProjectVersion.txt`, and checks that
**before** `package.json` — Unity projects routinely carry a `package.json` for tooling,
and `npm run build` would otherwise be detected as the way to prove a C# fix. Its build
command stays deliberately null: `/fix` runs one per round, a batch compile takes minutes
and holds an exclusive lock, so `unity_compile` is the once-at-the-end route instead.

### How it connects

Cullus never talks to the Editor. It spawns `unity mcp` as a subprocess and speaks MCP
over stdin/stdout to *that*:

```
Cullus  ──spawn, stdio JSON-RPC──▶  unity mcp
                                        │ reads
                                        ▼
                    <project>/Library/Pipeline/.unity-pipeline-port
                                        │ host, port, bearer token
                                        ▼
unity mcp  ──HTTP──▶  127.0.0.1:7800  ← the Editor
```

The port is **not fixed** — 7800 is a default and the descriptor file is the source of
truth. The Editor's HTTP server is authenticated: hitting it directly returns
`{"error": "Unauthorized"}`. The token lives in that file, which means anything able to
read the project's `Library/` can drive the Editor. Local-only, but worth knowing on a
shared machine.

### What has to be true

Four things, and **missing any one produces the same symptom**: the server connects,
exposes zero tools, and the model reports it has no Unity tools. That is
indistinguishable from a broken install, which is why `/doctor` checks each link
separately.

| # | Requirement | Fix |
|---|---|---|
| 1 | Unity CLI installed | `brew install unity-cli` (the Hub also installs it) |
| 2 | Editor running with the project open | Open it |
| 3 | `com.unity.pipeline` in that project | `unity pipeline install --project-path <path>` |
| 4 | The package actually **resolved** | Click into the Editor window so Unity imports it |

Step 4 is the one that catches people: the package can sit in `manifest.json` while
absent from `Library/PackageCache`, and no server ever starts. Steps 3 and 4 are
**per project**, not per machine.

One command answers all four:

```bash
unity pipeline list
```

```
Project    PID    Running  Pipeline  Version       Server Port  Server Reachable
TronGame   63125  true     true      0.6.0-exp.1   7800         true
```

`Server Reachable: true` means Cullus will work. Or just run `/doctor`, which reports
the same chain and names the failing step.

> If it reports unreachable while the Editor looks healthy, check
> `lsof -nP -iTCP:7800`. A server bound to `[::1]` only is a known bug — the CLI probes
> IPv4 and reports a healthy server as unreachable.

### Tag filtering: why not all 149 tools

A connected Editor offers **149 commands**, and their schemas cost **~25,000 tokens on
every turn** — more than ten times every other server combined. Enabling Unity unfiltered
makes Cullus worse at everything else *and* worse at Unity, because picking one right
answer out of 149 similarly-named options is harder than a small model manages.

Unity's commands carry tags, so `unityToolTags` in `~/.cullus/config.json` narrows them:

```jsonc
"unityToolTags": ["gameobjects", "scripts", "scenes", "prefabs", "assets"]
```

That default is the authoring set — make a thing, script it, place it in a scene, save it
as a prefab, manage the asset. **55 tools, ~8,200 tokens** instead of 149 and ~25,000.

The 18 available tags:

```
settings  baking     gameobjects  animation  scripts  assets
build     scenes     prefabs      editor     packages tests
materials capture    navigation   authoring  batch    observability
```

Add `baking` for lightmaps and navmesh, `settings` for physics and quality, `tests` for
the test runner. An **empty array means no filter** — all 149, and the token cost with it.

The filter fails open in both directions on purpose: no tags configured means everything,
and a command with no tag data is exposed rather than hidden. Hiding on missing data would
turn one stale cache into a Unity server that looks connected and offers nothing.

### What it does well, and what it does not

Good at: scene assembly, MonoBehaviour scripts, prefabs, components, batch object
creation. There are no `terrain`, `skybox`, `collider` or `camera` commands, but
`add_component` takes **any type name** and `eval` runs arbitrary C# through Roslyn, so
the ceiling is C# rather than the command list.

It cannot judge a result. It will place 200 cubes in whatever pattern you specify;
deciding the pattern is level design. Ask for one concrete mechanical step per turn —
*"create a script called ShieldPickup with an OnTriggerEnter that disables the collider,
then attach it to a new GameObject named Shield at 0,1,0"* — rather than a milestone.

### Known rough edges

- **Keep the CLI current.** Before `1.0.0-beta.8`, `unity mcp` advertised numeric and
  array parameters as strings, so the model sent `"2, 0.5, 0"` where Unity wanted
  `[[2, 0.5, 0]]` and lost a full inference round recovering. `unity upgrade`
  (renamed `unity self-update` *in* beta.8 — on older builds only the old name exists).
- **Small models misreport their own tools** — though less often than it looked. `qwen3.8`
  created objects correctly every time and then claimed `save_scene` was unavailable, three
  runs running. Two harness bugs were doing much of that work: the budget's tiebreak was
  registration order, so `save_scene` really was cut from the list, and a call to anything
  outside the list came back as *"no tool named … exists"* — which was not true. Both are
  fixed (see [Tool relevance filtering](#tool-relevance-filtering)). Residual cases remain, so
  `/tools` is still the way to settle it.
- **Several Editors open** means `unity mcp` picks one. `/doctor` warns; pin it with
  `--project-path`.

---

## API tokens

Managed from **Settings → Connections** (and listed under Settings → MCP Servers):
`OBSIDIAN_API_KEY`, `GITHUB_TOKEN`, `BRAVE_SEARCH_API_KEY`, `TAVILY_API_KEY`.

### Recommended: export them in `~/.zshrc`

Environment variables are checked **first**, before every other source, so a token exported in
your shell profile always wins:

```bash
# ~/.zshrc
export OBSIDIAN_API_KEY="..."
export GITHUB_PERSONAL_ACCESS_TOKEN="ghp_..."
export BRAVE_SEARCH_API_KEY="..."
export TAVILY_API_KEY="..."
```

Then `source ~/.zshrc` (or open a new terminal) and start `cullus` **from that shell** — a
process only sees the environment of the shell that launched it, so a server already running
will not pick up a change until you restart it.

This is the recommended setup: the tokens live in one file you already back up and already know
how to edit, nothing is stored by the app, and the same export works for any other tool that
wants the same credential.

Settings → Connections shows `from your shell` for these and **refuses to overwrite them** — a
Keychain entry you cannot see would otherwise sit there being silently ignored.

Three of these accept aliases, so an existing export is likely to just work:

| Token | Accepted variable names |
|---|---|
| GitHub | `GITHUB_PERSONAL_ACCESS_TOKEN`, `GITHUB_TOKEN`, `GH_TOKEN` |
| Obsidian | `OBSIDIAN_API_KEY` |
| Brave / Tavily | `BRAVE_SEARCH_API_KEY`, `TAVILY_API_KEY` |

### Full resolution order

Most to least preferred. The first source with a non-empty value wins:

| # | Source | Notes |
|---|---|---|
| 1 | **Environment variable** | Nothing at rest. Wins over everything; the UI shows "from your shell" and refuses to overwrite it. |
| 2 | **macOS Keychain** | Where Settings stores it. Encrypted at rest, unlocked by your login keychain. |
| 3 | `~/.cullus/secrets.json` | Non-macOS fallback. Created with mode `0600` **at write time**, not chmod'd afterwards — no window where it is world-readable. Warns once when used. |
| 4 | **Claude CLI MCP config** | Last resort. If you have already configured the same server for the Claude CLI, its token is reused rather than asking you for it twice. |

Settings → Connections names which of the four a token came from, so "I set it and it is still
not working" is answerable without guessing.

Tokens are **never** written to `config.json`, and the value is write-only across
the HTTP boundary: it can be set and deleted, but no endpoint returns it. Reads
give presence, backend, and a masked preview.

```json
{"key":"TAVILY_API_KEY","present":true,"source":"keychain","preview":"••••••••••••6789"}
```

Enough to confirm which token you pasted, useless if intercepted.

`debugLog` also runs every trace through `redactSecrets()` before it reaches the
browser. Nothing should be routing a token through there — but a debug panel would
be an ugly way to discover otherwise.

---

## The composer

**↑ / ↓ recall what you sent**, exactly as a shell does. Walking past the newest entry hands back
the half-typed line you started with rather than an empty box. History persists across reloads
(200 entries, immediate repeats collapsed), and the slash and file menus keep the arrows while
either is open — `↑` there still means "previous item".

Slash commands filter as you type; `@` opens a file picker.

### Autonomy modes and Stop

The composer shows the current mode and cycles with **shift+tab**.

| Mode | What it does |
|---|---|
| `▶▶ auto mode on` | Tools run without asking. Read-only servers still refuse writes. |
| `▶▶ manual mode` | **Every** tool call waits for Approve / Deny in the transcript. |
| `▶▶ accept edits on` | Tools run without asking **and** read-only guards are lifted for this session. |
| `▶▶ plan mode on` | Mutating tools are withheld entirely; the model produces a plan. |

Accept-edits is session-scoped and never persisted — the read-only default exists so that
tomorrow's session cannot inherit today's "yes to everything".

A denial in manual mode is information, not an error: the model is told it was refused and asked to
find another way. If nothing is listening (a headless run, the terminal REPL) calls are approved
rather than deadlocking, and an unanswered prompt denies after five minutes.

### Being away from the keyboard is not a fault

`ask_user` is how the model asks *you* something without ending its turn, and it gets ten
minutes — after which the answer is "no answer" and the model is told to pick a sensible
default and carry on.

That was the design, and it was unreachable. Every tool dispatch is wrapped in the 120s tool
timeout, which always won first, so a question to a human was capped at two minutes and then
**failed** — and a failed tool call counts toward the three strikes that disable tools for the
rest of the turn. Not being at your desk was scored as the model malfunctioning. Approvals
were always exempt by virtue of running outside that wrapper; `ask_user` was the odd one out
purely because it is implemented as a tool.

### Stop

**■ Stop** replaces Send while a turn runs, and Esc does the same. It aborts server-side through a
per-socket `AbortController` that the tool loop races against the current generation, so it lands
**mid-step** — measured: pressed at 5.0s, turn ended at 5.0s with `Cancelled during step 1`. It
covers chat, pipeline and fan-out runs. Self-repair keeps its own Stop.

Stop is the **only** thing that stops a turn. A disconnect is not a stop — see
[Long turns and dropped sockets](#long-turns-and-dropped-sockets).

### Long turns and dropped sockets

A run keeps going until you stop it or it finishes. Closing the tab, refreshing, or letting
the laptop sleep does not end it.

That took two fixes, because the old behaviour lost work three times in a single session with
*"Lost connection to the assistant server. Is `assistant` still running?"* — while the server
was working perfectly.

**The socket budget was shorter than a step.** engine.io's defaults give the browser 45
seconds to hear from the server (25s ping interval + 20s ping timeout). Every model-side
budget is far larger — 120s idle, 600s first-token, 900s total — so the model was never the
thing timing out. A local model routinely spends one to three minutes inside a single step,
and the client's ping timer is a plain `setTimeout` that Chrome and Safari throttle hard in a
backgrounded tab. Tab away mid-step, come back to a dead connection. `pingTimeout` is now
120s, and `connectionStateRecovery` restores the same socket and replays missed packets across
a short drop, so a blip no longer even looks like one.

**A disconnect used to cancel the turn.** The server called `cancelTurn` on the socket's
`disconnect`, which made the run's lifetime the socket's lifetime — and since the run's
identity *was* the socket id, there was no way to re-attach even in principle. Turns are now
keyed on the session, and a disconnect only releases pending questions (nobody is on the other
end to answer them). The turn is still bounded by `stepTotalTimeoutMs` and the step budget,
and [auto-exit](#exit-when-the-last-window-closes) defers while it runs — a guard that had
been dead code, because `cancelTurn` emptied the map it checked before it ever fired.

Two smaller things fell out of the same area:

- **Approvals no longer break after a reconnect.** The approval and inquiry handlers are
  process-global singletons registered per connection, and on a reconnect the ordering is:
  new socket registers, *then* the old socket's `disconnect` clears the handler — nulling the
  live one. After a single reconnect `ask_user` returned "nothing is listening for questions
  in this run" and **every vault write auto-approved**, because an absent approval surface is
  treated as consent. Only the owning socket may clear now.
- **The UI stops crying wolf.** The disconnect handler ignored the reason, so a recoverable
  blip printed the same alarm as a dead server, with no "reconnected" message to follow it.
  The warning is now deferred and cancelled if the socket comes back.

Nothing new had to be built to survive a refresh: `saveTurn` already writes after **every**
tool step, so the session file is at most one step stale and is already the run store.

---

## Read-only by default

**Every server that can write starts read-only**, including `filesystem`. Writing
is opt-in per server via ✏️ Read-write in Settings → MCP Servers, which confirms first and
names exactly what it is granting.

In each case the mutating tools are not merely discouraged — they are **absent from
the tool list the model receives**. A tool the model cannot see is one it cannot try
to route around. Neither `filesystem` nor `obsidian-live` has a read-only flag of
its own, so read-only is enforced here: mutating tools are withheld from the schema
*and* refused at dispatch as a backstop, in case a model calls a name it remembers
from earlier in the conversation.

This is why [the unlock](#narrowing-is-a-hint-not-a-wall) keys on what the server layer
advertised rather than on what is routable. A read-only server's write tools are removed
*before* the relevance filter runs, so they are not "withheld for brevity" and naming one does
not bring it back.

### Vault safety

The vault defaults to **read-only**. In that mode the plugin's write tools
(note create/update/delete/patch, frontmatter and tag mutation) are not merely
discouraged — they are absent from the tool list the model receives.

Read-only constrains **the model only**. You can always edit in Obsidian, and the
next read reflects it immediately since every read goes to the running app.

To let the model write, click **✏️ Read-write** beside `obsidian-live` in Settings → MCP Servers
(it confirms first, then reconnects the server).

### Why the guard is centralised

A vault usually sits *inside* a granted filesystem path — e.g. the vault is under
`~` and you granted `~`. Withholding `obsidian-live`'s write tools only governs
*that* server, so `filesystem`'s `write_file` could still write straight into the
vault. That was verified, not theorised.

The guard therefore lives in `mcpManager.callTool()`, the single chokepoint every
MCP tool call passes through. Any mutating tool whose arguments resolve to a path
inside the vault is refused while read-only is on, whichever server offers it.
`write_file`, `edit_file`, `create_directory`, `move_file` and shell redirection
into the vault are all blocked; writes outside the vault are unaffected.

> **Grant narrowly.** Granting all of `~` lets the model write anywhere in your
> home folder, including any *other* vault, which gets no vault protection.

---

## Self-repair: `/fix`

`/fix` runs a bounded repair loop over Cullus itself or any project you have
granted with `/paths`. It keeps a change only when the project's own build and verify
commands pass; otherwise every file it touched is restored.

The design constraint is model size. A 2B model cannot hold a whole debugging method
in one prompt, cannot be trusted to rewrite a file, and will declare victory without
running anything. So the harness holds the judgment and the model answers three narrow
questions with JSON contracts:

| Phase | Who decides | What happens |
|---|---|---|
| Baseline | code | Run build + verify, capture the real output |
| Locate | code greps, model ranks | Grep the symptom's identifiers; model picks ≤3 files |
| Probe | model proposes, code vets | ONE read-only command from an allowlist, to settle the diagnosis |
| Plan | model | `{file, startLine, endLine, replace}` for an edit, or `{file, create:true, replace}` for a new file |
| Apply | code | Line range applied as given; a `find` must occur exactly once; a create is refused if the file exists |
| Verify | code | Rebuild, re-verify, feed compiler output back **verbatim** |
| Sweep | code | Grep for identifiers the diff removed — stale comments and docs included |
| Decide | code | Green → keep. Same failure twice → stop and revert. Rounds spent → revert |

Rounds are settable from 1 to 30. The ceiling is not the safety mechanism — these are:

- **Repeated failure**: two rounds with an identical failure signature stops the run.
- **Nothing applied**: two rounds in a row where every edit was refused stops the run, instead of
  burning the budget on the same refusal. (A real 4-round run spent three rounds on
  "find does not appear".)
- **Build-breaking rounds are rolled back immediately**: an edit that introduces a compile error
  the baseline did not have is undone before the next round, because a file that no longer parses
  invalidates every excerpt the model was shown. That single failure mode wasted three rounds
  before this existed.

### It can write new files

`/fix` was only ever able to modify what already existed, so any task needing a new module was
structurally impossible rather than merely hard. An edit may now be `{"file": "...",
"create": true, "replace": "<entire contents>"}`, under the same containment rules as any other
write: inside the target root, never `.git/`, `node_modules/`, `dist/`, `.venv/`, the secrets file
or the vault, and refused outright if the file already exists (edit it instead).

Revert stays honest about it. A created file has no pristine copy to restore, so the run records
what it created and revert **deletes** those files, pruning directories it brought into being —
`rmdir` refuses a non-empty directory, so a pre-existing folder with other files in it is never at
risk. "The tree is as you left it" still means exactly that.

Verified with a project that fails because an imported module doesn't exist: the loop created
`src/greeter.js` with a correct `greet(name)`, and the build went green in one round. A second run
against the now-fixed project refused to create the file again ("already exists — edit it instead")
and stopped after two rounds that applied nothing, rather than spending the budget on the same
refusal.

### Why edits are line-anchored

`find`/`replace` is where small models actually fail. On a 560-line file, three of four rounds were
refused with "find does not appear" or "find appears 2 times". The plan phase now shows a
160-line **numbered** excerpt and asks for `startLine`/`endLine`, which is a target a small model
can hit; `find` still works when it prefers that. Verified: a bug 63 lines into a 68-line file,
fixed in one round.

### Give it something to prove the fix with

If `verify` shows `(none)`, the panel says so — because "fixed" then means only "it compiles", which
cannot catch a runtime bug. Set one from the dashboard or the REPL:

```
/fix set --verify "node scripts/verify-obsidian-session.mjs"
/fix set /path/to/project --build "make" --verify "make test"
```

Overrides **merge** with detection, so setting only `verify` keeps the detected build command.
`scripts/verify-obsidian-session.mjs` is an example worth reading: it reproduces a real failure on
demand (terminating the Obsidian MCP session behind the client) so a repair can be proven rather
than assumed.

"Is it fixed?" is measured, never asserted: a model claiming success while the build
fails does not get the last word.

### Not just npm

Build and verify commands are detected from what is on disk, and can be overridden per
project with `/fix set`:

| Marker | build | verify |
|---|---|---|
| `package.json` with a build script | `npm run build` | `npm test` |
| `pyproject.toml` (uv / poetry aware) | `python -m compileall -q .` | `python -m pytest -q` |
| `requirements.txt` | `python -m compileall -q .` | `pytest -q` when `tests/` exists |
| `Cargo.toml` | `cargo build` | `cargo test` |
| `go.mod` | `go build ./...` | `go test ./...` |
| `Makefile` | `make` | `make test` when the target exists |
| `tsconfig.json` alone | `npx tsc --noEmit` | — |

A project with neither is refused rather than "repaired" with nothing to prove it.

### Safety

- Edits are confined to the target root. `.git/`, `node_modules/`, `dist/`, `.venv/`
  and the secrets file are never editable.
- Non-self targets must already be granted via `/paths`. That grant **is** the consent
  gate — there is no second permission to keep in sync.
- The vault is refused outright: `/fix` repairs code, not notes.
- Every touched file is copied to `~/.cullus/fix-backups/<runId>/` before its first
  mutation, so revert is a file copy that works offline and in non-git projects.
- Git history is untouched: no commits, no branches, no stash push. A `git stash create`
  hash is recorded in the report as a second way back.
- Probe commands are allowlisted, checked for chaining and redirection outside quotes,
  and inline `node -e` / `python -c` snippets are rejected if they write files or spawn
  processes.

### Model assignment

With the multi-agent pipeline **off**, the active model runs every phase. With it **on**,
the triage model handles locate and sweep, the engineer model handles probe and plan.
Across a 2b–14b spread that keeps the cheap phases cheap.

---

## Parallel workers

Under **Enable Multi-Agent Pipeline** there are two shapes, and a dial:

- **Split tasks across N workers** (default) — a planner splits your goal into independent
  subtasks, N workers run them concurrently **on one model**, and a reducer merges the results,
  naming which subtask each finding came from and which ones failed.
- **Different model per role** — the original triage → engineer → manager sequence.

### Why the dial is worker count, not model count

Measured on this machine (52 GB, no `OLLAMA_*` overrides):

| Setup | Resident memory | Throughput |
|---|---|---|
| `qwen3.5:2b` × 4 concurrent | **2.83 GB** — one copy of the weights | 1.64× vs serial |
| `qwen3.5:2b` × 8 concurrent | **2.83 GB** | 1.75× — the curve is flat |
| `qwen3.5:2b` + `qwen3.5:4b` loaded | **7.06 GB** — additive | — |

Ollama shares one copy of a model's weights across concurrent requests, so raising workers costs
almost nothing; every *distinct* model costs its full size. Hence one model splits and executes,
and a second model is worth loading only for the planner. The sidebar shows the estimate for the
models you actually picked before you run anything.

### What the speedup really is

It depends on the work, so every run reports its own measured overlap rather than a marketing
number — `sum of subtask times ÷ wall clock`:

| Subtask shape | Measured overlap at 4 workers |
|---|---|
| Tool-using (read four files) | **2.87×** |
| Generation-heavy, no tools | **1.2–2.0×** |
| Tiny prompts, 24-token answers | 1.64× |

Tool-heavy subtasks overlap best: while one worker waits on I/O another is decoding. If your
overlap is under 1.3× the run says so and points at `OLLAMA_NUM_PARALLEL`, which caps how many
requests Ollama serves at once regardless of how many workers you ask for.

### What workers can do, and what they cannot touch

Workers run the **real** tool loop — filesystem, `obsidian-live`, GitHub, shell — under the same
read-only modes as chat, with a 16-step budget each (the reducer gets 6). Nothing is tool-free:
withholding tools was the wrong fix for a reducer that called one instead of answering — disabling
thinking for internal turns was. What makes that safe concurrently is
isolation: an isolated turn gets its own message array and writes **nothing** to your chat, its
history, or your token counters. Two things are deliberately withheld from workers:

- `plan_tasks` / `complete_task`, because the run owns the checklist. (A worker calling
  `plan_tasks` wiped the fan-out's own subtask list — found on the first live run.)
- Thinking mode, because a reasoning model narrates "Thinking Process: 1. Analyse the request…"
  straight into the answer.

A worker that fails or loops until its step cap does not sink the run: it is reported as failed,
the others still deliver, and the final answer states what is missing. Small models do reach for
the shell on questions that need no tools — when that happens you will see it named as a failed
subtask rather than silently missing.

### Some goals are not splittable

A single compiler diagnostic is the clearest case, and it now skips the fan-out entirely and
runs as one task. Measured on
`Assets/Scripts/StormSky.cs(71,37): error CS0103: The name 'RenderQueue' does not exist…`:
the planner produced five subtasks, four of which independently read the same file and
grepped for the same symbol, and the run took 23 minutes to reach a one-line answer that
needed no tool call at all.

There is nothing to parallelise. A diagnostic names one file, one line and one symbol —
the work is a lookup, and every worker does the same lookup. The gate wants **one** distinct
`file(line,col)` plus an error code (`CS0103`, `TS2304`, `E0499`, `error:`), so two genuine
errors still fan out and the same error pasted twice does not.

Such a run is labelled with the goal's own first line. It used to be labelled `The whole
goal` — a placeholder that reached the checklist and prefixed every tool row in the activity
log (`The whole goal · path=Assets/Scripts/StormSky.cs`), where it told the reader nothing,
and appeared twice per line because the title was emitted as both the label and the summary.

### Cancelled is not failed

A stopped run used to report `0/5 subtask(s) in 0.0s — 1.00× faster than one at a time` and
**"Every subtask failed"**, which reads as five errors to debug rather than one Stop press.
Subtasks that never started are now counted separately, the summary says *"Stopped before
any subtask ran"*, and it names the actual cause: the `AbortSignal` was already aborted when
the map phase began. The speedup figure is suppressed for those runs — every unstarted
subtask returns in 0 ms, which drags the ratio to 1.00× and makes a cancellation look like a
performance problem.

Two smaller things in the same area: fan-out progress goes to the **originating socket**
rather than being broadcast to every tab (two runs, or one run and one stale tab, used to
interleave in a single Activity feed — which is how one run reported "splitting the goal for
4 worker(s)" and then "across 3 worker(s)", impossible within a run since both lines print
the same variable), and duplicate subtask titles are disambiguated before the checklist sees
them, because `startTask`/`setTaskStatus` key on the title and two identical ones marked each
other done.

---

## Activity

Everything the assistant does appears in one list in the sidebar, filterable by kind:

| Kind | What lands there |
|---|---|
| 🔧 tool | every MCP or local tool call, with its arguments and result |
| 💭 thinking | a reasoning model's chain of thought, one entry per step |
| ▶ command | every command `/fix` runs — build, verify, probe — with exit code and output |
| ✎ edit | files created, changed, refused, or reverted |
| 🩹 fix | each `/fix` phase, per round |
| ⚙ worker | parallel fan-out subtasks |
| 🔌 server | MCP servers connecting, failing (with the real reason), being removed |
| ◆ turn | turns starting, finishing, or being stopped |

This replaced "Executed Tool Calls", which showed only tool calls — so builds, applied edits,
`/fix` phases, workers and dropped servers were invisible unless you were watching the terminal.
Detail is collapsed behind a `detail` toggle per row, secrets are redacted on the way out, and the
buffer is a 400-entry ring in memory that a page reload replays from `/api/activity`.

### 💭 Thinking

Reasoning models return their chain of thought in a separate `message.thinking` field.
That was already being accumulated during streaming and then **discarded** unless the model
produced no answer at all — so the one thing explaining *why* a step called the tool it
called was the one thing never shown. It now lands in the log like everything else, on its
own kind so it can be filtered out when it is noise, and with a 12,000-character detail
budget rather than the usual 4,000 (a chain of thought at `high` routinely runs past it).

Nothing extra is generated for this, so it costs no tokens — but it only *appears* where
thinking is on:

| | Thinking captured? |
|---|---|
| `/effort low`, `/effort medium` | No — `think` is off |
| `/effort high` | **Yes**, one entry per step |
| Parallel workers and the reducer | No — thinking is off for every isolated turn, deliberately |

An empty Thinking panel says which of those applies rather than "nothing of that kind yet",
because waiting at `medium` for something that will never arrive is the obvious trap.

### Tool calls also render inline

The sidebar is the durable log of *everything*; the transcript shows what **this answer** did, in
order, at full column width:

```
▸ read_file              /Users/…/cloud-org-policies/notes.md         3.0 KB
▸ execute_shell_command  unity editors --json                          failed
```

Collapsed by default — a turn can make twenty calls and the answer is what you came for — and
expanding shows arguments and result. Errors get a red border and read `failed` in place of a size.

Both views wrap. A `<pre>` defaults to `white-space: pre`, so a 4,000-character tool result used
to be one enormous line scrolling sideways in a 300px sidebar; JSON that arrives pre-serialised is
re-indented so there are newlines to wrap at.

---

## The work checklist

Multi-step work shows as a live checklist in the sidebar — active item in bold, pending
items as boxes, finished ones ticked, with elapsed time and tokens for the turn.

Two producers write to it. The `/fix` loop drives it from its phases, and the model drives
it during chat turns through two deliberately tiny tools:

- `plan_tasks` — write the list of steps, once, before starting.
- `complete_task` — tick one off and start the next.

Small models routinely announce a five-step plan and lose it after step two. Making the
plan a real object means a dropped step is visible instead of silent.

### It is never blank while a turn runs

Every chat turn seeds the list with one line taken from your request, and the model's own plan
replaces it wholesale the moment it calls `plan_tasks`. A one-line plan is still a plan worth
seeing.

Before this the list was cleared at the start of a turn and left empty until `plan_tasks`
arrived — which on a small model is most turns, and was *every* turn while multi-tool messages
were being silently dropped. The panel read "Nothing in progress" through work that was very
much in progress. The placeholder is closed out when the turn ends, but only if it is still the
whole list: once the model has planned, the statuses on that list are the model's to set.

The panel also re-reads `/api/tasks` on every reconnect rather than only on page load. The list
is server-side state and the browser only mirrors it, so a refresh mid-run used to leave the
panel showing whatever it held when the page loaded — usually nothing — while the run carried
on without it.

---

## Vault memory

The assistant's memory lives in your Obsidian vault, at four paths you set in
**Settings → 📓 Vault memory** (relative to the vault root; blank switches a feature off):

| Path | What it does |
|---|---|
| **Context** | A note or folder injected into **every** turn as standing instructions. Edit it in Obsidian and the next message picks it up. |
| **Notes** | Where notes the assistant writes are filed by default. |
| **Skills** | Skill notes. One here **overrides** the built-in of the same name — writing `verify.md` replaces the shipped `/verify`. |
| **Recipes** | Notes with a `command:` line become callable tools. |

Reads prefer the `obsidian-live` tools, because they reflect whichever vault Obsidian actually has
open, and fall back to reading the configured folder from disk — so context still loads with Obsidian
closed. Writes always go through the filesystem, one code path, gated by the approval prompt below.

Context is capped at 6 000 characters and **says when it truncated**, because a model holding half a
rule is worse than one that knows it is missing something.

### When it can write

| Mode | Anywhere in your vault |
|---|---|
| `auto` | asks you first, then writes |
| `manual` | asks you first, then writes |
| `plan` | cannot write — mutating tools are withheld |
| `accept edits` | writes without asking |

This replaced a blanket read-only default. The 🔒 toggle on `obsidian-live` is still the hard lock:
set it and vault writes are refused outright, with no prompt.

The gate is one predicate (`requiresApproval` in `src/core/approval.ts`) so a call is asked about
exactly once, and it judges by **two** routes:

- **By tool name** — `note_write` computes its own path from a title, so there is nothing in its
  arguments to inspect. Judging it by what it is, not what it was passed, is what makes the prompt
  reliable; an earlier version scanned arguments only and wrote a note with no prompt at all.
- **By argument** — a `write_file` aimed at a path inside the vault takes the same route, because the
  vault normally sits inside a granted directory and would otherwise be an unguarded back door.

### Recipes

A recipe is a shell command you keep re-typing, saved as a note. Any note in the recipes folder
becomes a tool the assistant can call by name, so "rebuild it" runs *your* command rather than one
the model improvised. Settings → 📓 Vault memory lists the ones it found and why any were ignored.

```markdown
---
description: rebuild Cullus from source
command: npm run build
---
Anything below the frontmatter is for you, not the runner.
```

That note becomes the tool `recipe_rebuild`. The point is the safety property: **the model chooses
which recipe to run, never what the command is.** There is no argument interpolation at all — that
would put model-generated text into a shell string, which is the thing this design exists to avoid.
Notes without a `command:` line, or containing a refused command like `rm -rf /`, are reported in
Activity rather than skipped in silence.

`/newtool` writes the note for you, so adding functionality does not mean remembering the
frontmatter keys or which folder they go in:

```
/newtool rebuild | rebuild the assistant from source | npm run build
```

The tool is registered immediately — callable from your next message, no restart. The name is
slugified (`recipe_rebuild`), the description is quoted so a colon in it cannot break the YAML,
and a name that already exists is refused rather than overwriting the note. Edit the note to
change the tool; delete it to remove the tool.

### Editing JSON and other structured files

Small models answer in chat formatting even when the destination is a file, so an edit to a
`.json` arrives wrapped in a ```` ```json ```` fence and the fence lands in the file. The next
turn reads it back, sees corruption, and tries to repair a file that was fine before it started.

Two guards run at the single tool-call chokepoint, `mcpManager.callTool`:

- **A fence wrapping the whole value is stripped**, but only for extensions where it can never be
  real content — `.json`, `.ts`, `.py`, `.yaml` and friends. A `.md` note may legitimately *be*
  one code block, and an unknown extension is left alone: guessing wrong corrupts a file just as
  surely as the fence did. A value that merely *contains* a fence is never touched.
- **Whole-file JSON writes are parsed first.** Malformed content is refused, the file is left
  untouched, and the parser's own message goes back to the model along with an instruction to
  resend raw JSON. Discovering the problem here is far more actionable than discovering it on the
  next read.

Both are reported in Activity, so a silently cleaned-up write is still visible.

### What stays out of the vault

Chat transcripts (noisy JSON that would churn your sync), `config.json` (a sync conflict would become
a broken config) and every token (Keychain only).

---

## Chats

Conversations are stored per chat in `~/.cullus/sessions/`, listed newest-first in the
sidebar, and switching one rehydrates the server-side message array — so continuing an old
chat actually continues it. Titles come from the first message. `/reset` now starts a new
chat rather than deleting the current one; nothing is destroyed unless you delete it.

### `/reset` stops the work it is resetting

Reset **aborts any turn in flight** and clears the checklist before starting the new chat.

It used to clear the history array and nothing else, while a turn ran on against it — and
because a running turn holds a reference to the *old* array while `saveTurn` writes that array
into whatever session is now active, the next auto-continue round found the fresh session
populated with the entire pre-reset transcript and carried straight on with the abandoned
work. Reset looked clean and then undid itself one round later.

Two related things worth knowing:

- **`/continue off` now takes effect mid-run.** The auto-continue loop snapshotted its settings
  once before starting and consulted that frozen copy each round, so turning it off did not
  stop a loop already going — only the next one.
- **The old "scratchpad all cleared" message was false.** Nothing cleared the orchestrator
  scratchpad; the string was left over from an earlier design.

---

## Settings → Connections

Model choice lives in the composer, beside the prompt. Everything connectable lives in
Settings (⚙️, or `/settings`) as a `Connector | Type | Status` table with a Connect form
per connector:

| Connector | Type | Needs |
|---|---|---|
| Obsidian Vault | Database | HTTPS address + API token |
| GitHub | Web | Personal access token (or a discovered MCP command) |
| Brave Search | Web | API token |
| Tavily | Web | API token |
| Etsy | Web | `ETSY_MCP_SERVER_PATH` |
| Filesystem | Local | Granted directories |

The table is generated from `core/connectors.ts`; adding a connector there makes a working
row appear. Saving a token reconnects its server immediately — Connect means connected, not
"connected after a restart".

### Adding your own MCP servers

**+ Add** on either Connections or MCP Servers opens one form with three ways in:

1. **Manual** — name, transport, then command/args/env (stdio) or URL/token (http), plus a
   read-only toggle.
2. **Paste JSON** — the `{"mcpServers": {…}}` block from a server's README, verbatim. Multiple
   servers in one blob are all added, each reported separately.
3. **Import from Claude CLI** — anything in `~/.claude.json` not registered here yet, with its
   command and URL already filled in.

All three go through one validator, so the refusals are specific: a name that clashes with a
built-in, a stdio entry with no command, an unparseable URL, or a self-signed exception requested
for a non-loopback host (allowed for localhost only, matching what the transport enforces).

User servers behave exactly like built-ins — same read-only toggle, same tool-name aliasing, same
connection state — and are the only ones with a **Remove** button. Tokens go to the Keychain as
`MCP_<NAME>_TOKEN`, never into `config.json`.

The GitHub server command is resolved in order: `GITHUB_MCP_COMMAND`, a configured command,
whatever GitHub MCP server the Claude CLI is already using (this is how a corporate wrapper
gets picked up), then `npx -y @modelcontextprotocol/server-github`.

---

## Web search and deep research

`web_search` and `fetch_url` are available to the model at all times. The backend
is chosen by which key is present:

| Backend | Requires | Notes |
|---|---|---|
| DuckDuckGo | nothing | Default. HTML scraping — best-effort. |
| Brave | `BRAVE_SEARCH_API_KEY` | Stable API |
| Tavily | `TAVILY_API_KEY` | Stable API, built for LLMs |

DuckDuckGo fingerprints clients and serves a bot-challenge page to plain requests,
so a full browser header set, a three-endpoint fallback chain and a backoff retry
are required — not cosmetic. It still fails occasionally, and says so explicitly
rather than returning silent zero results.

`fetch_url` refuses `localhost`, `127.x`, `10.x`, `192.168.x`, `172.16–31.x`,
`.local` and non-HTTP schemes, so a web tool can't become an internal network
scanner.

### `fetch_url` also refuses search engines

Not for safety — for the loop it prevents. When `web_search` fails, which it does on
the keyless path because DuckDuckGo serves a bot challenge, models reliably try to do
the search by hand. Observed in one run: after `web_search` failed, workers fetched
`html.duckduckgo.com/html/?q=…`, then `mojeek.com/search?q=…`, then
`ecosia.org/search?q=…` — each returning about a kilobyte of challenge page, three tool
steps and several minutes spent learning nothing.

It cannot work. It is the identical request `web_search` already made and lost. So a
search **results** page is refused with an explanation that points at local sources
instead, and `web_search`'s own failure message now says the same thing rather than
leaving the model to rediscover it three times a turn.

Only results pages: the guard needs a search-engine host **and** a live query
(`?q=`, `?query=`, `/search`, `/html`, `/lite`). `docs.unity3d.com`, forum threads and
`duckduckgo.com/privacy` all still fetch normally.

**Without a key this is the difference that matters.** A failed search now costs one
step and an honest "search is unavailable" instead of four steps and a fabricated
answer — and for Unity questions specifically, `unity_symbol` answers offline what the
search was reaching for.

### `/deep-research`

Orchestrated in **code**, not by asking the model to plan its own research — a 9B
model cannot reliably sequence a multi-stage investigation via tool calls.

```
1. Decompose   topic → distinct sub-questions
2. Search      one search per sub-question, pooled, deduped, capped per host
3. Read        fetch the best unique sources
4. Extract     pull claims from each, tied to its URL
5. Verify      adversarially challenge each claim; default is REJECT
6. Synthesize  cited report from surviving claims only
```

Breadth follows `/effort`: ~3 sources at `low`, ~5 at `medium`, ~8 at `high`.
Every stage streams progress, because on local models this takes minutes and a
silent UI is indistinguishable from a hang.

Unsupported claims are excluded and counted, so a thin report is visibly thin
rather than confidently wrong.

---

## Working with small models

Small models fail in predictable, recoverable ways. Each is caught, described back
to the model as a correction, and retried rather than thrown at you:

- **Malformed tool arguments** — JSON-as-a-string, bare scalars for single-property
  schemas, `{"args": {...}}` double-wrapping, `null` — are coerced.
- **Undeclared arguments are refused**, with the list of what the tool does accept. Passing
  them through was worse than an error: the server ignored the key it did not know and
  answered normally, so `console({command: "recompile_status"})` — where `console` takes
  only `tail`/`level`/`since` — returned the whole log buffer and the model reasoned on
  from "I issued a command". Skipped for tools that declare no properties.
- **Hallucinated tool names** get the real tool list back, with a did-you-mean.
- **Every tool call in a message runs.** Only the first used to be dispatched and the rest
  were dropped in silence, which is the worst shape a failure can take: the transcript
  reads like success. One real turn paired `plan_tasks` with a lookup, lost the plan, and
  the model — seeing an empty checklist immediately after planning — concluded the
  checklist was broken and stopped using it. A later turn paired `complete_task` with a
  file edit and lost the edit.
- **Identical repeated calls** are blocked with the previous result and an
  instruction to change approach — for calls that *write*. A read may be repeated, because
  the second read of a changing thing is the point: polling is how you wait for a compile.
  Reads are only blocked after three identical calls **back-to-back**, and any intervening
  call resets the run. There is a `wait` tool (default 5s, capped 60s) so a poll loop can
  actually wait rather than shelling out to `sleep`.
- **Reasoning-only responses** (empty `content`, full `thinking`) fall back to the
  reasoning instead of showing nothing.
- **Models without tool support** are retried once without tools, and the
  degradation is reported.
- **Step budget** is capped per `/effort`, with a warning to the model before it
  runs out so it commits to an answer.

`ollama pull` hints, memory errors and connection failures surface as one-line
messages with the exact fixing command, never a stack trace.

> **Note on thinking models.** Research stages set `think: false` deliberately.
> qwen3.5 otherwise spends the entire `num_predict` budget inside
> `message.thinking` and returns empty `content` — measured at 3,900 characters of
> reasoning and zero output. Disabling it made research both correct and ~2× faster.

---

## Performance

**Settings → Performance.** Eight dials covering how much the model has to read before it can
answer, and how long it is given. They apply to your next message — nothing restarts.

Above the form is a live measurement of the *current* session, because on their own these
numbers mean nothing:

```
34,082          ~136s                             41 / 126                71
prompt tokens   spent reading, before the         messages sent /         tools
next turn       first word                        in session              connected
```

The reason to care: prompt reading is **not streamed**. It is dead time before the first word,
and on a local model it runs at roughly **250 tokens/second**. Measured here on `qwen3:14b`:
20k prompt tokens took 72s to reach the first chunk, 29k took ~117s.

| Dial | Default | What it does |
|---|---|---|
| History sent | 40 messages | How much of the conversation is replayed. `0` sends everything. |
| Tool result cap | 8,000 chars | Truncates any one tool result, keeping both ends. `0` for no cap. |
| Step retries | 2 | Extra attempts before the turn gives up. |
| Tool budget | 28 tools | Most tools sent in one turn. |
| First-token timeout | 600s | Time to read the prompt before producing anything. |
| Idle timeout | 120s | Silence allowed once output has started. |
| Total step timeout | 900s | Hard ceiling on one step. `0` removes it. |
| Tool timeout | 120s | Wall-clock cap on one tool call. Tools that wait on **you** are exempt. |

### Why the prompt gets long: replayed history

The transcript is replayed each turn, and tool results dominate it. A real session here:

| | chars | ~tokens | prompt eval |
|---|---|---|---|
| Unbounded (124 messages) | 208,540 | 65,168 | ~265s |
| + history trim (40) | 112,198 | 35,061 | ~143s |
| + tool result cap (8k) | 57,274 | 17,898 | **~73s** |

**79% of that session was stale tool output** — 164,044 characters across 41 results, one
`read_text_file` alone accounting for 54,038. A tool result is re-sent on every later step *and*
every later turn, so one oversized read is a tax on the whole session.

Two rules keep the trimming honest:

- Your transcript is **never** shortened. This only trims what goes over the wire; the sidebar
  and the session file keep everything.
- A cut never orphans a `tool` message from the assistant message that called it — the cut point
  moves forward to the next clean boundary. The model is also told how many messages were
  omitted, so it asks rather than silently contradicting itself.

The tool cap applies **at ingest**, so results already saved in an older session stay as they
are. Start a new chat to clear them.

### Truncation keeps both ends, and the rest stays readable

The cap used to keep the head and discard everything after it. That cost a real session an
hour. A 5.8 KB source file was read to diagnose a compiler error on line 100; the serialised
result cleared 8,000 characters and **line 100 was in the discarded part**. The model
diagnosed a different, real, error from the half it could see — three times, because every
re-read truncated identically. The advice attached to the cut did not help either: *"narrow
the call"* is vague and *"raise the limit in Settings"* is a human action the model cannot
take mid-turn.

Three things changed:

- **A quarter of the budget is reserved for the tail.** Late content — the end of a file, the
  last rows of a query, the summary line — is where the answer usually is when the call was
  made because something is wrong.
- **The full text is kept and addressable.** A truncated result carries a `resultId`, and
  `read_tool_result` reads any window of it; follow `nextOffset` until it is null to read the
  whole thing. Memory-only, the last 24 results — a within-turn affordance, not a cache.
- **It is valid JSON.** The old marker was appended *after* `JSON.stringify`, so a truncated
  result was malformed and a model parsing it got a syntax error rather than a truncation
  notice. It is now a real object with `truncated`, `totalChars`, `head` and `tail` fields.

`read_tool_result` is never filtered out of a turn's tool list, because the thing that makes
it necessary — a result too big for the transcript — is exactly the thing that fills the tool
list up. Offering an id the model then cannot read would be worse than offering none.

### Streaming, and why timeouts used to fire on healthy turns

Inference is streamed, and the timeout measures **silence**, not elapsed time. A model producing
tokens is working and is left alone; one that has genuinely wedged is still killed.

The old behaviour was a flat 120s wall-clock cap on a non-streaming call, and that budget was
structurally smaller than the work: a 38,774-token prompt cannot finish reading in 120s at 250
tokens/second. Every such turn died at step 1 reporting *"Small models can stall on long
prompts"* — while the model was behaving perfectly normally.

Silence is split in two because Ollama sends nothing during prompt eval:

- **Before the first token** the model is reading. Generous by default (600s).
- **After it**, silence means wedged. Tight by default (120s).

One subtlety worth knowing if you touch this code: `ollama.chat()` does not resolve when the
request is sent — it resolves when the first response headers arrive, which Ollama withholds
until prompt eval is done. A watchdog started after that `await` cannot see the phase it exists
to guard. (Symptom while this was being built: an 8s ceiling reporting failure at 57s.) The
connect is raced separately, and a request that lands after we have given up on it is aborted so
a discarded generation does not keep occupying the GPU.

### Persistence: a failed step retries, the turn survives

A failed inference step used to throw straight to you, discarding every tool call already made.
Small local models fail transiently often enough that this was the most common way a turn died.

Each retry **degrades the request** rather than repeating the gamble that just failed:

| Attempt | Change |
|---|---|
| 1 | As-is — covers a dropped connection or a busy Ollama |
| 2 | History trimmed to half the configured limit |
| 3 | History trimmed to 6 messages |

With a short backoff between attempts, because an Ollama still unloading the previous model
needs a moment and hammering it makes that worse.

Some failures are configuration, not luck, and are **never** retried — retrying them only burns
your time to reach the same error: a cancel (your Stop is a decision, not a fault), a model that
is not pulled, out-of-memory, and a model that rejects tool payloads (that has its own recovery —
the step is redone without tools). When retries are exhausted the error says so, so an error
after three silent attempts does not look like an instant failure.

### Live progress

Each action prints a dim one-line update in the chat as it happens, CLI-style:

```
▸ Step 1 · gemma4:latest · 16,863 prompt tokens, 27 tools
⚙ vault_list path=Drive/_tasks/
✓ vault_list returned 276 chars in 104ms
▸ Step 2 · gemma4:latest · 16,955 prompt tokens, 27 tools
```

Arguments are named, not just the tool: `vault_read` tells you nothing while you wait,
`vault_read Drive/_tasks/ai-security` tells you it is doing the right thing. Retries and
degradations appear here too, in amber.

They are kept after the answer arrives rather than cleared — *"which tools did it actually call,
and what took four minutes"* is a question you ask once the reply is in front of you. The
[Activity](#activity) sidebar remains the durable log; this is the live feed.

---

## Exit when the last window closes

Closing the last dashboard window stops the server. The dashboard is the only interface, so a
server with nobody attached is usually a forgotten process holding a port.

A socket cannot tell a closed tab from a reload, so three things stop this being a footgun:

1. **A grace period** (default 10s), cancelled the moment anything reconnects.
2. **Work in flight defers the exit** rather than being killed by it — a browser closed
   mid-answer still lets the tool calls and the save finish. (This only started working once
   a disconnect stopped cancelling the turn: `cancelTurn` emptied the very map this check
   consults, so the guard could never fire. See
   [Long turns and dropped sockets](#long-turns-and-dropped-sockets).)
3. **It only arms after a client has connected at least once**, so `assistant --no-open` does not
   exit before you have had a chance to open the page.

Turn it off, or change the grace period, in **Settings → Performance → When you close the
browser**. `/exit` still shuts down immediately from the dashboard.

**Scheduled jobs override this.** If any job is enabled, closing the browser leaves the
server up — otherwise a job scheduled for 3am would never fire. The log says so when it
happens.

---

## Scheduled jobs

Run a prompt on a schedule: check a balance every 15 minutes, summarise a channel each
weekday morning, watch a build. Managed from the **Scheduled** panel in the sidebar, or
`/cron` in the terminal.

```bash
/cron                                              # list jobs, with next run time
/cron add "morning brief" "0 8 * * 1-5" "Summarise my unread mail"
/cron monitor "oanda" "*/15 * * * *" "curl -s …/balance" "Report the change"
/cron runs <id>                                    # last 20 runs
```

The panel offers plain-English presets (every 15 minutes, hourly, weekday mornings) and
reveals the raw five-field expression for cases the presets do not cover, so you never
have to remember cron syntax to schedule something ordinary.

### Monitor jobs: the reason this is cheap

An ordinary job wakes the model on every tick. A **monitor** job runs a shell command
first, hashes its output, and only wakes the model when that output **changed** —
then injects a diff of what changed into the prompt:

```
MONITOR CHANGE DETECTED
- balance: 100
+ balance: 250
```

A 15-minute monitor on something that changes twice a day costs two model calls instead
of ninety-six. Nothing crashes if this breaks — you just quietly start burning a model
call every tick — so `scripts/verify-cron-monitor.mjs` asserts it, including the subtle
case: **a failing source is an error, not a change**, and it leaves the stored hash
untouched. Otherwise one flaky `curl` would make the next healthy tick look like a change
and cost a spurious run.

### Guards

- **Lifecycle guard** — a monitor script that restarts or kills Cullus is rejected. A job
  that takes down its own scheduler is a loop you cannot break from inside.
- **Atomic writes** — the job store is written via a temp file and rename, so a crash
  mid-write cannot leave `jobs.json` truncated.
- **Jobs live in `~/.cullus/cron/`** with their run history, and survive restarts.

---

## Token accounting

### Tool relevance filtering

With the GitHub server connected the model is handed 58 tools, **37 of them GitHub-named**. Asked
*"give me a quick summary of what's in my Obsidian Vault"*, `gemma4` called nothing and answered
"My tools are designed to interact with GitHub repositories" — while `vault_list`, `vault_read` and
`search_query` were all in the payload. Naming the capabilities in the system prompt was not enough:
the majority family wins.

So each turn now sends the tools that match what was asked, keyed on the recent conversation, not
just the current message:

| Question | Tools sent | Withheld |
|---|---|---|
| "summary of my Obsidian Vault" | 14 (3 vault) | filesystem, github |
| "open pull requests in … on github" | 37 (19 github) | filesystem, obsidian-live |
| "read package.json and tell me the version" | 13 (7 filesystem) | obsidian-live, github |
| "what is the capital of France" | 5 (shell, checklist, web) | all three servers |

Rules that keep this honest:

- Local tools, web tools, the shell and the checklist are **never** filtered.
- A local tool may declare a **subject area** so it ranks with the server it complements.
  `unity_symbol` is the case that needed it: local tools have no server, so they land in
  the lowest-confidence band and are the first thing the budget cuts — meaning that with an
  Editor connected, 55 MCP tools outranked the one tool that answers a Unity compiler error
  offline. It now ranks alongside them on a Unity question, and is still withheld from an
  unrelated one. The `unity` keyword pattern also matches `CS####`, `.cs` and `Assets/`,
  because a pasted compiler error names none of the words a person would use.
- A server is only dropped when it can be positively judged irrelevant; no keyword match anywhere
  means the full list is sent.
- Whatever is withheld is **named in the system prompt**, so a filtered capability is reported as
  something to ask for rather than "I cannot do that".
- **A withheld tool still dispatches if the model names it.** See below.

Verified end-to-end: the same vault question now calls `vault_list` and returns a real summary.

Keyword matching alone does not *bound* the list — one relevant server with 40 tools still sends
40 — so the **tool budget** (default 28, in Settings → Performance) is enforced after filtering.
When it bites, the least-certain tools go first: `execute_shell_command`, `plan_tasks`,
`complete_task`, `ask_user`, `read_tool_result` and `wait` are never dropped, then tools from
servers judged relevant, then tools from servers we could not judge either way.

Within a band, tools are ordered by **how directly the question names them** — the tool's own
name scores double, its description single and capped, so a verbose description cannot outrank a
direct name match. Unity forced this: it contributes 55 equally-ranked tools against a budget of
28, and the tiebreak used to be registration order, so the survivors were whichever happened to
register first. Asked to *"create a cube and save the scene"*, the model got `create_gameobjects`
and reported that no save tool existed — `save_scene` was connected and cut by ordering alone.

Registration order remains the **final** tiebreak, so the same question still sends the same
tools: a list that reshuffles between turns makes failures impossible to reproduce.

Anything the budget cuts is named in the system prompt exactly like a keyword-filtered server.

### Narrowing is a hint, not a wall

Two things made the narrowing worse than the problem it solves.

**The dispatcher used to contradict the prompt.** A call to a tool outside the turn's list came
back as `No tool named "recompile" exists` — a statement the dispatcher could itself disprove,
since `callTool` routes by name across every connected server and would have run it. Meanwhile
the system prompt said the opposite: *"connected but left out… do NOT claim the capability is
unavailable."* A model handed both spends its steps deciding which is true. One real session
burned ten of them on it, while an Editor sat there with a stale assembly and `recompile`
one call away.

A tool the model names is now **unlocked and dispatched**, and stays in the list for the rest
of the turn. Two limits keep that from becoming a hole:

- Only tools the server layer actually **advertised** can be unlocked. That list is where
  read-only mode and Unity's tag filter have already had their say, so this reverses *our*
  brevity trim and nothing else. Routing by name alone would have reached `write_file` in
  read-only mode.
- Tools withheld **on purpose** — `plan_tasks` inside a worker, every mutating tool in plan
  mode — are not unlockable. The point of those filters is that the model does not get to opt
  out of them.

**The list used to be frozen by your opening sentence.** Ranking ran on the user's messages
only, so nothing the model learned mid-turn could widen it. When `attach_script` failed with
*"run `recompile`, poll `recompile_status`, then retry"*, the ranker could not read that
sentence — the two tools the model had just been instructed to call stayed out of its list on
every subsequent step. The last three tool results now feed the ranking corpus too, capped at
400 characters each, because errors are where tools name other tools and that is the
highest-signal text in a turn.

### The context window is now actually requested

Ollama defaults `num_ctx` to **4096 regardless of what the model supports**. Because nothing here
set it, every long turn was being silently truncated while the usage bar cheerfully showed "3% of
262,144". Turns now ask for a window sized to the conversation:

- Estimated prompt tokens × 1.35, plus generation headroom, plus a reserve for tool output,
  rounded up into buckets (8k → 16k → 32k → 64k → 128k → 200k → 262k).
- The window **grows mid-turn** if tool results outrun the initial bucket — a vault listing plus a
  summary hit 8,199 tokens against an 8,192 window chosen from the one-line question that started
  it. Growth only, never shrink, so the model is not reloaded repeatedly.
- Capped by `maxContextTokens` in `~/.cullus/config.json`, default **200,000**.
- Buckets rather than an exact figure because changing `num_ctx` makes Ollama reload the model —
  jittering it per turn would thrash.

Sizing rather than always asking for the maximum, because `num_ctx` drives KV-cache allocation.
Measured on `qwen3.5:2b`: 8k → 2.47 GB resident, 64k → 3.53 GB, 200k → 5.23 GB. With parallel
workers that cost is per slot.

Verified: a 12,107-token prompt with a marker at the very start was answered correctly from the
marker — under the old 4096 default that text was gone.


Real counts from Ollama's `prompt_eval_count` / `eval_count`, summed across every
step of a turn — not a `length / 4` estimate.

The dashboard shows per-message in/out split and step count, a session running
total, and a context-window meter that turns amber at 75% and red at 90%. Context
size is read from the model itself.

---

## Project layout

```
src/
  index.ts                  CLI entry (shebang), boot sequence, orchestrator socket
  orchestrator.ts           Schema-validated 3-agent engine (Ajv)
  core/
    config.ts               ~/.cullus/config.json, vault read-only guard
    server.ts               Express + Socket.IO, REST endpoints, socket handlers
    provider.ts             Inference loop, token accounting, small-model repair
    ollama.ts               Model discovery, health, context length
    mcpManager.ts           MCP lifecycle, stdio + HTTP transports, tool routing,
                            aliasing, read-only and vault write guards
    mcpServers.ts           Declarative server registry + read-only modes
                            (filesystem, obsidian-live, github, unity, etsy, oanda),
                            plus Unity's tag filter
    cron.ts                 Schedule parsing, monitor evaluation, lifecycle guard
    cronStore.ts            Job store in ~/.cullus/cron/ (atomic writes)
    cronRunner.ts           Tick loop, run history
    logger.ts               JSONL logs, rotation, secret redaction
    lifecycle.ts            Ordered shutdown on SIGTERM/SIGINT
    migrate.ts              ~/.assistant → ~/.cullus, copy-not-move
    connectors.ts           Declarative connector list behind Settings → Connections
    agentPool.ts            Parallel fan-out: plan → bounded map → reduce
    fixLoop.ts              The /fix state machine: baseline → locate → probe → plan
                            → apply → verify → sweep → decide
    patch.ts                Exact-string edit primitive, backups, revert
    projectTarget.ts        Target resolution + per-language build/verify detection
    sessions.ts             Chat sessions in ~/.cullus/sessions/
    tasks.ts                The live work checklist
    tools.ts                Local tools (shell, cwd, uptime, checklist, ask_user,
                            read_tool_result, wait)
    toolResults.ts          Full text of results too large for the transcript, so a
                            truncated one can still be read to the end
    activity.ts             The one activity stream: tools, thinking, commands, edits,
                            workers, servers, turns — 400-entry ring, redacted
    unityTools.ts           unity_symbol (offline namespace lookup from the editor's
                            XML docs) + unity_compile (batchmode, consent-gated)
                            + unity_commands (the 149-command Editor catalogue)
    webTools.ts             web_search + fetch_url, backends, SSRF guards, and the
                            refusal of hand-rolled search-engine queries
    deepResearch.ts         Six-stage research pipeline
    secrets.ts              Keychain / 0600-file token store + redaction
    session.ts              /effort /fidelity /goal /plan /adhd /debug state, autonomy modes
    vaultStore.ts           Vault reads/writes, context loading, path resolution
    recipes.ts              Shell recipes defined as vault notes
    approval.ts             Manual-mode per-tool approval, with timeout and no-handler default
    inquiry.ts              ask_user: the model's blocking question, with a soft timeout
                            that reads as "no answer" rather than a failure
    skills.ts               Prompt macros in ~/.cullus/skills/
    doctor.ts               Health checks
    pipeline.ts             Simple 3-stage pipeline
    commands.ts             Terminal REPL commands
  ui/                       banner.ts, repl.ts (terminal REPL)
  public/index.html         Dashboard markup + core script
  public/js/                settings.js, models.js, sessions.js, checklist.js, fix.js,
                            pipeline.js (worker dial), addServer.js (+ Add form),
                            modes.js (shift+tab modes, Stop, approvals),
                            vault.js (vault memory pane), cron.js (Scheduled panel),
                            tools.js (tool popup), doctor.js (health report),
                            performance.js (prompt-size and timeout dials)
  public/css/               tokens.css (design tokens), components.css
  websocket/                PipelineQueueManager
```

Skills are markdown files in `~/.cullus/skills/` with a `description:`
frontmatter field. `verify.md`, `run.md`, `fix.md` and `doctor.md` are seeded on
first run and are yours to edit; drop in a new `.md` to add one. `fix.md` holds the
repair method in prose, so you can tune how the loop reasons without touching code.

---

## Troubleshooting

**`Port 3000 is already in use`**
The error names the fix: `lsof -ti:3000 | xargs kill`, or `assistant --port 3001`.

**Dashboard is missing new features**
Run `npm run build`. The build removes `dist/public` before copying — without
that, `cp -R` nests into `dist/public/public/` and the server keeps serving a stale
file.

**`Client does not support MCP Roots`**
Informational. The filesystem server is taking its allowed directories from
command-line arguments instead of a live roots handshake. The sandbox is correct;
changing paths respawns the subprocess.

**`obsidian-live` won't start**
`/doctor` names the reason. Usually no token stored — copy it from Obsidian →
Settings → Local REST API with MCP. Otherwise check Obsidian is running and the
plugin is enabled: `curl -sk https://127.0.0.1:27124/` should return
`"status": "OK"`. A 401 from the MCP endpoint means the token is wrong.

**The model can't write files any more**
`filesystem` now defaults to read-only. Click ✏️ Read-write beside it in the
sidebar. This changed when the toggle was added; read tools were never affected.

**`Step 1 … produced nothing in 600s`**
The prompt is too long for the model to finish reading. Open **Settings → Performance** and look
at the diagnostics: if it says tens of thousands of prompt tokens, lower **History sent** or
**Tool result cap**, or start a new chat. Raising the first-token timeout treats the symptom.

**Turns take minutes on a one-line question**
Almost always replayed history rather than the question. Settings → Performance shows what the
next turn will cost and how much the current settings are already saving. A session that has
read large files carries them forever — a new chat is the fastest fix.

**The server keeps exiting after I close a tab**
That is [the auto-exit](#exit-when-the-last-window-closes). Turn it off in Settings →
Performance, or raise the grace period if you routinely close and reopen.

**The server does *not* exit when I close the window**
Something is still attached. `curl localhost:3000/api/clients` reports the live count; another
browser window or a background tab pointed at the dashboard will hold it open, and the auto-exit
keeps re-checking rather than firing.

**Model ignores a purpose-built tool and reaches for the shell**
Common below ~9B. Name the tool in your prompt, or raise `/effort`.

**Search returns nothing**
Keyless DuckDuckGo scraping hit a challenge page. Wait a minute, or set
`BRAVE_SEARCH_API_KEY` / `TAVILY_API_KEY`.

**Unity is connected but has no tools**
Expected until an Editor is running on a project with `com.unity.pipeline` installed **and
resolved**. `/doctor` names which of the four steps is missing; see [Unity](#unity).

**The model says a Unity tool does not exist**
Check before believing it — `/tools` shows what is actually loaded. Two harness causes are
fixed: the tool budget's tiebreak was registration order (so a tool really was being cut), and
calling anything outside the turn's list returned *"no tool named … exists"* even when it was
connected and routable. A named tool is now dispatched and unlocked for the rest of the turn.

**"Lost connection to the assistant server" during a long turn**
Fixed, in two places — see [Long turns and dropped sockets](#long-turns-and-dropped-sockets).
The browser's liveness budget was 45s against steps that take minutes, and a disconnect used
to cancel the turn. If you still see it, the server really has stopped: check the terminal it
was launched from.

**The model diagnosed the wrong error in a file it had just read**
Probably truncation. Tool results are capped (default 8,000 characters, Settings →
Performance) and used to keep only the head, so anything late in a file was invisible. The cap
now keeps both ends and the rest is readable via `read_tool_result`. If a file is genuinely
large, raise the cap or ask for a line range.

**The session counter reads 0 over a full transcript**
Fixed — it was a turn that hit its step cap recording its messages and none of its tokens, plus a
restart that restored the transcript without its counters. If you see it again, that is a
regression `scripts/verify-session-usage.mjs` should have caught.

When in doubt, run `/doctor` — it checks Node, npx, Ollama, models, config, state
directory, vault, vault mode, every MCP server, the Unity chain, the tool registry,
granted paths and session settings, and names a fix for anything failing.

---

## Tests

```bash
npm test          # the nine suites below
npm run check     # typecheck + build + test + audit
```

Each suite exists because something failed silently once. None of them mock the thing under test.

| Suite | What it proves |
|---|---|
| `verify-web-guard` | SSRF guards re-check redirects at **every hop**, not just the first URL |
| `verify-cron-monitor` | Monitor mode suppresses unchanged output, and a failing source is an error rather than a change |
| `verify-logging` | Secrets are redacted **before** the first write, logs rotate, a circular payload does not throw |
| `verify-path-guards` | Edits stay inside the project; vault writes are identified, including vault-relative traversal |
| `verify-migration` | `~/.assistant` → `~/.cullus` copies rather than moves, and never overwrites newer state |
| `verify-session-usage` | A stored session with messages never claims zero turns, across a step cap and a restart |
| `verify-unity-tools` | `RenderQueue` resolves to `UnityEngine.Rendering` from the **installed** editor; a single diagnostic stays out of the fan-out while two do not; `unity_symbol` survives a 28-tool budget against 70 competing tools on a raw compiler error, and is withheld from a vault question; the five search-engine URLs one run actually fetched are refused while four real doc URLs are not; a repeated Unity diagnostic is collapsed; `unity_commands` is pinned against the budget on a Unity task and withheld otherwise, finds `create_gameobject` from "create a cube", and returns that command's arguments by name |
| `verify-turn-resilience` | Every tool call in a message runs (a plan paired with a lookup survives); a tool the budget cut is still dispatched, while a name no server routes and a tool withheld by policy are both still refused; the checklist is never blank mid-turn; `/reset` stops the turn it is resetting; the socket's liveness budget outlasts a slow step |
| `verify-tool-fidelity` | A truncated result is valid JSON, keeps its **tail**, and is readable to the end through `read_tool_result`; an undeclared argument is refused rather than passed through; a no-argument status tool can be polled but not spun on; a tool named in an error message becomes reachable |

The last two script a fake model over the real turn loop rather than asserting on source, so
they fail if the behaviour regresses even when the code still looks right.

`verify-unity-tools` asserts against the real Unity install rather than a fixture, so its
symbol checks **skip** (and say so) on a machine that has never had Unity on it. Everything
else in it is pure and always runs.

`verify-obsidian-session.mjs` needs a running Obsidian, so it sits in `npm run test:local`.
