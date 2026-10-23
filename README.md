# realctx

Working context and long-term memory for [Pi](https://pi.dev), at two time scales
(design: [`docs/realctx-design-v2.md`](docs/realctx-design-v2.md)):

- **Context layer** (within a session): spent tool outputs are dropped from the context
  behind byte-stable placeholders and restored on demand with `realctx_expand`. Sessions run
  far past the context window without compaction pauses, and nothing is lost.
- **Memory layer** (across sessions): small surprise-gated Markdown facts replace AGENTS.md / CLAUDE.md and other memory
  systems. The agent recalls them when needed; path-scoped facts appear when their paths
  are touched.

The two layers share one System One judge, one search index, one safety scanner and one
path tracker, and they feed each other: an output that is about to be dropped is the main
source of new memories (drop-time capture).

## Context layer

On every `tool_result` the original output is stored outside the project
(`~/.pi/agent/realctx/sessions/<project-key>/<session>/`, mode 0600) with a stable
session ordinal (`#42`), its tool and arguments, its size, the touched paths and their
mtimes. Outputs under `context.captureMinTokens` are not stored and never dropped.
Originals of sessions without activity for `context.retentionDays` (default 7; 0 = keep
forever) are deleted, with their index rows and vectors; sessions open in this process are
never pruned. After that their placeholders can no longer be expanded (re-run the tool).

**Sessions**: every session has its own context layer: its own registry, drops, pins
and stored originals. A child session (`/fork`, `/clone`, or a subagent started while a
realctx session runs, announced through `REALCTX_PARENT_SESSION`) copies the originals
it inherits into its own store, so parent and child never share or prune each other's
files. The memory layer is shared by every session of a process: one engine, database,
index, judge budget and capture budget per session family. Subagents do not capture
their "user" messages, which are the parent agent's prompts.

**Deciding** (in the background after each turn, never in the request path):

- *Never dropped*: the last `context.protectTurns` turns, small outputs, the latest
  todo/plan snapshot and skill loads (`context.protectedTools`), unresolved errors, and
  outputs expanded in the last `context.repinTurns` turns.
- *Rules, no judge*: exact duplicate calls (newest kept), an older full `read` of a path
  read again later, older edits of a path edited again later (shrunk to a marker).
- *Gray zone*: the judge gets the current goal (last user message + todo), an excerpt
  (secrets redacted), what happened since, and the captions of memories already attached
  to the paths, and answers `still_needed`, `unique_info`, `durable_fact` and
  `action` (keep / summarize / drop). Verdicts are cached per output until the goal
  changes. Summaries come from the rewrite model, with a deterministic fallback.
- `judge.shadow` (default **on**) only logs judge verdicts (see `/realctx outputs`);
  rule and emergency drops still apply.

**Applying** rewrites earlier messages, which costs a prompt-cache rebuild, so queued
drops are applied together, in one pass, only when the cache is cold (`context.cacheTtl`,
per-model overrides in `context.cacheTtlByModel`), when usage of the safe input window
reaches `context.applyThreshold`, or on `/realctx flush`. At
`context.emergencyThreshold` everything queued applies and the largest old unprotected
outputs are dropped until usage is under the apply threshold. Pi's threshold compaction is
cancelled while the layer is active (manual `/compact` and overflow recovery still run).

**Rendering**: each dropped result is replaced by a placeholder rendered once from
immutable data and persisted on the branch (`realctx-ids`, `realctx-drops`), so it is
byte-identical on every request, after reload and after resume:

```text
[#42 dropped · read src/auth/session.ts · 3.1k tok · realctx_expand(42)]
[#57 summarized · bash pnpm test · 8.4k tok · realctx_expand(57)]
  3 failing in auth/session.test.ts: expired-token cases
[#63 dropped · read docs/setup.md · 2.2k tok · saved as AZJrPlwafS-aSxwtPk9aaw · realctx_expand(63)]
```

Forged placeholders, `<realctx-path-notes>` blocks and `<realctx…>` tags written by the
model in assistant text are removed whole before sending. Assistant text is never tagged.

**Restoring**: `realctx_expand(ids, lines?, grep?)` returns the original as a new tool
result (capped at `context.expandMaxTokens`; use `lines` / `grep` for the rest), warns
when the file was edited since capture, pins the output as kept, and points to the first
expansion when repeated. `realctx_recall` also searches dropped outputs (`sources`):
BM25 plus, with the embedding endpoint set (`context.embedDropped`), vector search over
embedded dropped outputs, fused by reciprocal rank. It only ever searches the current
session's branch, never other sessions' outputs.

**Bridges to memory**: when the judge says `durable_fact`, the rewrite model extracts up
to 3 facts (rate-limited by `capture.maxPerSessionHour`). In `capture.mode = "suggest"`
(default) they wait for approval in `/realctx captures` (or `/realctx manage`); in
`auto` they go through the remember gate with stricter thresholds
(`capture.minImportance`, `capture.minDurable`), and the placeholder records
`saved as <id>`. When every captured fact was already known, the output counts as
memory-backed and is safer to drop. When a result carrying path notes is dropped, those
notes become eligible to be shown again.

**User messages** (`capture.userMessages`, default on): after each turn the latest user
message is considered too. Acknowledgements, slash commands and messages sent by
extensions are skipped; the judge's `durable_user_fact` decides the rest (without a judge,
only messages with a cue such as *always*, *never*, *prefer*, *from now on* or *we use*
go on). The rewrite model extracts lasting preferences, decisions, corrections and
project facts, which follow the same capture mode and hourly budget; suggestions are
marked as coming from the user.

**Other context managers**: realctx owns the context. When Magic Context,
billion-context, a DCP-style pruner or realmem is loaded in the same Pi (detected by its
tools and source; extend with `context.conflictTools`), realctx warns and disables it
(`context.conflictAction = "disable"`, the default):

- its tools are deactivated and every call to them is blocked, at once;
- its package entry in Pi's settings (`~/.pi/agent/settings.json`, or the trusted
  project's `.pi/settings.json`) becomes `{ "source": …, "extensions": [] }`, so it no
  longer loads after `/reload` or the next start. Other keys and packages are untouched;
  extensions loaded with `-e` or from the `extensions` setting are only reported;
- until it is unloaded its hooks still run, so realctx's context layer stays off for that
  session (the memory layer works); after `/reload` both are clean.

`/realctx conflicts` lists what was found and disabled, `/realctx conflicts enable <name>`
restores the original package entry and stops disabling it, `/realctx conflicts disable
<name>` turns it off again. `conflictAction = "warn"` only warns (realctx's context layer
stays off), `"ignore"` runs realctx next to it. Subagent sessions never change settings.

## Scopes and storage

| Scope | Purpose | Files |
|---|---|---|
| global | every project and session (user preferences, general knowledge) | `~/.pi/agent/realctx/global/*.md` |
| project-shared | replaces AGENTS.md: setup, architecture, conventions, release; **commit it** | `<project>/.pi/realctx/*.md` |
| project-personal | this machine or user only (local paths, workarounds) | `~/.pi/agent/realctx/personal/<project-key>/*.md` |

The project key is `git-<root commit>`, so it stays stable across clones, worktrees and
moves. Outside git, or in a repository without commits, it falls back to
`path-<hash of root>`. After the first commit, personal memories are moved to the git
key automatically. Each personal store has a `project.json` naming its project.

Each fact is one file:

```markdown
---
id: 01926b3e-5c1a-7d2f-9a4b-1c2d3e4f5a6b   # UUIDv7, never changes
caption: Run e2e tests with pnpm test:e2e
paths:                                     # project scopes only, relative to the root
  - packages/web
created: 2026-09-27T12:00:00.000Z
updated: 2026-09-27T12:00:00.000Z
---

`pnpm test:e2e` needs Docker running; it starts Postgres via docker compose.
```

The frontmatter never holds volatile or local data (usage counts, importance, conflicts).
All of that lives in `~/.pi/agent/realctx/realctx.sqlite`:

- **usage** counters: `used_count` (Reinforce + recall hits; recall and lists sort by
  it) and `path_inject_count` (times shown automatically on a path touch; never used
  for sorting).
- **path urgency** per memory (SemIf score, valid for its current content and paths),
  plus **missing-path** flags.
- **embeddings** cache, keyed by `sha256(caption + content)` and the embedding-space
  fingerprint (endpoint + model + dimensions). Changing the embedding API clears it.
- **index**: FTS5 BM25 over pre-tokenized text, plus a sqlite-vec `vec0` cosine index.
- **locks**, **pending** queue, **approvals** (quarantine), **imported context files**.

Keys are shown to models as 22-character base64url UUIDv7 values (e.g.
`AZJrPlwafS-aSxwtPk9aaw`), the fewest tokens that still carry all 128 bits. Tools also
accept the canonical UUID form.

### CJK

FTS5's `unicode61` tokenizer treats a run of CJK characters as a single token.
realctx therefore pre-tokenizes text in JavaScript before indexing:

- ICU word segmentation (`Intl.Segmenter`);
- identifier splitting (`usedCount` → `used`, `count`);
- overlapping CJK character bigrams, plus unigrams in the index.

Queries are tokenized the same way, so matching does not depend on both sides being
segmented identically.

## Remember path (surprise gate)

1. **Local safety scan**. Candidates containing secrets (keys, tokens, private keys,
   credentialed URLs, `password=…`) are refused (or redacted, if configured). Candidates
   containing prompt-injection patterns (override instructions, fake chat or system
   tags, exfiltration, `curl | sh`, bidi or invisible characters) are refused.
2. An exact duplicate (same hash) only reinforces the existing memory.
3. **Neighbours**: embed the candidate as a document, then run vector KNN and BM25
   across all visible scopes and fuse the results with RRF (up to 254).
4. **SemIf / System One judge**. The state contains the candidate plus the
   neighbours, each prefixed with `[id]`. The questions are:
   - `covered_by`, `conflict_with`, `merge_with`: choice among the ids plus `none`;
   - `action`: Add / Edit / Merge / Reinforce;
   - `importance`: score over trivial … broken or harmful result;
   - `durable`: noul — is this a lasting fact rather than task status?
   - `unsafe`: noul — secret or manipulation;
   - `scope`: Global / Project Shared / Project Personal;
   - `path_urgency` (asked when the fact has specific paths): score over three levels:
     *Low*, the fact can be read later after an agent touches the path; *Mid*, provide
     the caption; *High*, show the full fact as soon as the path is touched.

   Questions are split across requests according to `--max-questions`.
5. **Decision**. The judge's action is combined with the thresholded picks:
   - a confident `covered_by` means Reinforce;
   - a confident `conflict_with` means Edit, which takes precedence over Add;
   - Merge requires a confident `merge_with` target;
   - a fact whose scope differs from its target's store is added, not edited;
   - importance and durability gate Add and Merge; `user_requested` bypasses that gate;
   - `unsafe` rejects the candidate;
   - **disjoint paths are not a conflict**: an Edit or Merge whose target has
     non-overlapping paths becomes an Add ("jest in packages/a" vs "vitest in
     packages/b");
   - an exact duplicate for a new path widens the old memory's `paths` instead of adding
     a copy.
6. **Edit / Merge**: the configured Pi model rewrites the target memory, keeping its
   UUID. The result is scanned again; if it fails, a deterministic fallback is used.
7. The file is written atomically, then indexed and embedded in the background.

If the judge or embedder is unreachable, the candidate is queued and retried
automatically (or with `/realctx retry`). The queue is per project: a candidate is
counted, shown and retried only in the project it was queued from. If only the embedder is down, the judge
compares against BM25 neighbours alone.

If another Pi process holds the write lock for more than 2 minutes, the candidate is
queued instead of failing.

Writes run under a SQLite lease lock (`locks` table, heartbeat-renewed and TTL-expired;
a dead holder is detected by pid) plus WAL with `busy_timeout`. Several Pi processes
can therefore share the stores safely.

## Sharing project memories through git

Project-shared memories live in `.pi/realctx/` and are shared by committing them. If git
ignores that directory, shared memories are silently never committed. This is common
when `.pi/` is in `.gitignore`. realctx therefore runs `git check-ignore` on the store:

- **At session start**, a warning names the rule that ignores it (file, line, pattern)
  and gives the fix.
- **`realctx_status`** repeats the warning, and a remember into the shared store notes
  that the memory will not be committed.
- **`/realctx fix-gitignore`** re-checks, asks for confirmation, and appends the fix.
  Fixes are verified in a scratch copy of the repository's ignore rules before they are
  suggested:

  | Ignored by | Fix |
  |---|---|
  | `.pi/*`, `*.md`, `.pi/**` | `!/.pi/realctx/` and `!/.pi/realctx/**` in `.gitignore` |
  | `.pi/` or `.pi` (the whole directory) | `!/.pi/`, `/.pi/*`, `!/.pi/realctx/`, `!/.pi/realctx/**` in `.gitignore`. Git cannot re-include a file inside an ignored directory, so `.pi` is re-included and everything else in it stays ignored |
  | a nested `.pi/.gitignore` | the negation is added to that file |
  | `.git/info/exclude` or the global excludes file | the negation goes into the committed `.gitignore` |

  Check it yourself with `git check-ignore -v --no-index .pi/realctx/x.md`: no output
  means the store is shared.

## Path scopes and path notes

`paths` in the frontmatter can hold files (`package.json`), directories (`db`) or globs
(`**/migrations/*.sql`, `packages/*/package.json`). When `paths` is not given it
defaults to the root of the store. Nothing is inferred.

| Store | Paths are relative to | Default |
|---|---|---|
| project shared / personal | the project root | `.` (whole project) |
| global | the user directory: `~/…`; absolute paths elsewhere | `~` (everywhere) |

The agent passes paths relative to its cwd, as `~/…`, or as absolute paths, and realctx
stores them in the store's frame. A path outside the project makes the fact global.
Moving a memory between stores (manage page) re-expresses its paths.

- **Shown on touch.** After every tool call, realctx works out which paths it
  touched: path arguments of any tool, and words of `bash` commands that exist on disk.
  Memories whose scope covers those paths are appended to the end of the tool result,
  inside `<realctx-path-notes>`, most specific scope first, then most used. The path
  urgency decides how much is shown:

  | Urgency (score 0–2) | Shown as |
  |---|---|
  | High (≥ 1.5) | full content |
  | Mid (≥ 0.75, or not judged yet) | caption with id |
  | Low | only counted: "N more memories are attached…" |

  Per-result limits (`maxFull`, `maxCaptions`, `charBudget`) demote overflow to
  captions, then to the count. Every memory is shown **once per session branch**. The
  shown ids are stored in `realctx-shown` session entries at each turn end, so reload,
  resume and tree navigation behave correctly. After a compaction, notes shown before
  the first kept entry may be shown again, because the summary no longer contains them.
  Only the path itself, or a location under it, triggers a note. Touching a parent
  directory (e.g. `ls src` for a note on `src/db`) does not. The system prompt is never
  touched.
- **Urgency** is judged when the memory is remembered. For hand-written or edited
  memories it is judged in the background by SemIf, and it is re-judged whenever the
  content or paths change.
  `/realctx manage` shows it per memory (score, tier under the current thresholds,
  per-level probabilities, confidence, source; ● full · ◐ caption · ○ count · ? unjudged
  in the list); `/realctx debug` shows what the judge gave a candidate (`p` sets its paths).
- **Recall ranks, never filters, by path**: memories covering the given or recently
  touched paths come first, project-wide ones next, those about other areas last.
- **Missing paths.** At session start, scopes that no longer exist are flagged (✗ in
  `/realctx manage`), with a suggested new location taken from `git log` renames
  (press `f` to apply it).
- **Counters.** `used_count` (recall and reinforce) drives sorting. `path_inject_count`
  records automatic displays and never affects ranking.

## Model integration

- **System prompt**: a `<realctx>` section. It declares realctx as the only memory
  system (ignore MEMORY.md, Claude memory, surmem, and Magic Context's
  `ctx_memory` / `<project-memory>`), tells the model to recall before any work and to
  remember proactively, lists the captions of the most-used project-wide memories, and
  lists the paths that have path notes (for example `db (4), infra/terraform (2)`).
  Path-scoped memories are left out of the caption list, since they appear when their
  paths are touched. The section is computed on the first prompt and stored in the
  session (`realctx-snapshot`), so it stays byte-identical for the whole session,
  including after reload or resume. This preserves the prompt cache.
- **Context files**: AGENTS.md / CLAUDE.md are stripped from the prompt once imported
  (`/realctx import`), because realctx replaces them.
- **Hidden tools**: other memory tools (`ctx_memory` by default) are deactivated, and
  any call to them is blocked with a message pointing to realctx.
- **Import**: `/realctx import` marks context files as imported only when the agent
  actually stored facts from them.
- **Tools**:
  - `realctx_recall(queries?, paths?, ids?, sources?, page?, scope?)`: hybrid search over
    memories and (with `sources` containing `output`, the default) this session's
    dropped outputs. Results are
    ordered by path (memories about the given or recently touched paths first,
    project-wide next, other areas last), then by used_count, then by relevance, and are
    paginated. `paths` alone lists the memories attached to those paths; `ids` reads
    memories that were shown as captions.
  - `realctx_remember(caption, content, scope?, paths?, user_requested?)`: `paths` takes
    files, directories or globs.
  - `realctx_expand(ids, lines?, grep?)`: restore dropped outputs (see above).
  - `realctx_status()`: context usage, queued and applied drops, stores, index, queue.
  - `realctx_list(page?, scope?)`: sorted by path, then used; demoted, since its output
    is large.
  - `realctx_forget(ids)`: delete memories by id (or unique prefix).
- **Skill**: `realctx` covers when and how to recall, remember, pick a scope, correct
  memories and restore dropped outputs.

## Commands

`/realctx` opens a menu, or run a subcommand directly:

| Subcommand | Does |
|---|---|
| `status` | context usage, queued drops, memory counts, warnings |
| `outputs` | this session's captured outputs: state (protected, rule, queued, dropped), judge verdicts |
| `flush` | apply queued drops at the next request, ignoring the cache TTL |
| `captures` | approve, edit or reject facts captured from dropped outputs |
| `debug #N` | dry-run the drop decision for output `#N`: judge state, raw answers, verdict |
| `manage [query]` | browse all memories (filter or semantic search); view content and metadata, including path urgency; edit, re-scope, move, delete, approve quarantined ones |
| `settings` | Edit/Merge model, embedding and SemIf endpoints, keys and models (picked from the server's `/v1/models`), thresholds, limits; built-in connectivity tests |
| `debug` | dry-run the full remember path and show the embedding, neighbours (cos / BM25 / RRF), raw SemIf answers and probabilities, the decision trace, the path urgency (tier, per-level probabilities, what the write would store; `p` sets candidate paths) and the rewrite diff; `w` writes it for real |
| `add` | remember a fact yourself |
| `import` | the agent splits AGENTS.md / CLAUDE.md into facts |
| `prune-paths` | drop paths that no longer exist from memories (after a confirm listing the changes); a memory whose paths are all gone is deleted |
| `consolidate [global] [shared] [personal] [--no-paths]` | shrink and clean the memory base (see below); fully automatic, writes the result and reports what changed |
| `fix-gitignore` | check whether `.pi/realctx` is ignored by git and append the verified fix |
| `conflicts [enable\|disable <name>]` | other context managers next to realctx: list, re-enable or disable them |
| `embed`, `reindex`, `retry` | maintenance |

API keys may be given as `$VAR` or `env:VAR` so they are not stored in `config.json`
(which is mode 0600).

### Consolidation

`/realctx consolidate` makes the memory base smaller and cleaner in two passes and writes
the result straight away, with no review or confirmation (`esc` cancels while it runs;
nothing is written before both passes finish). It then reports every change it made:

1. **SemIf review.** Every memory is reviewed, least used first, against its most
   similar memories in the **same store** (`consolidate.neighbors`, default 12), so facts
   never move between scopes. Questions: `covered_by`, `conflict_with`, `merge_with`
   (ids plus `none`), `forget` (obsolete, transient, speculative or trivial),
   `importance` and `revise` (unclear or verbose). The decision, in this order:
   - P(forget) ≥ `consolidate.forget` (0.7), or importance < `consolidate.minImportance`
     (0.5; 0 disables it) → **forget**;
   - a confident `covered_by` → the memory is dropped into its neighbour (**covered**);
   - a confident `conflict_with` → **supersede**: the Edit/Merge model rewrites the older
     memory with the newer one's facts, and the pair becomes one memory;
   - a confident `merge_with` → **merge** through the Edit/Merge model;
   - P(revise) ≥ `consolidate.revise` (0.7) → the Edit/Merge model rewrites it alone
     (same information, clearer and shorter).

   The surviving memory keeps its id, gets the union of both path scopes and the folded
   memory's `used_count`. Rewrites pass the same safety scan as Edit/Merge.
2. **Path revision** (project memories; `consolidate.paths`, or `--no-paths` to skip).
   The Edit/Merge model summarises the repository from its file tree (`git ls-files`, or
   a bounded walk outside git; collapsed to `consolidate.treeLines` lines) and the README.
   The summary is cached in the database per tree. Then, in batches, it gets the summary,
   the tree and each memory with its current paths (missing ones are marked) and answers
   `{"<id>": ["path", ...]}`: drop paths that are gone or unrelated, add files or
   directories the fact applies to, `["."]` for project-wide facts. Paths that do not
   exist in the tree or leave the project are discarded.

A memory that was edited while consolidation ran is left alone (reported as
skipped), and a folded memory is only deleted when the memory that absorbed it was
written.

**Schedule** (`consolidate.schedule`, suggest only, never writes): at session start, when
the stores visible from the cwd hold at least `minMemories` (20) memories and were not
consolidated for `everyDays` (14), realctx suggests a consolidation. In mode `plan`
(default, with a judge) it first makes a dry-run plan in the background and reports its
summary; `/realctx consolidate` then offers to apply that plan as is, or to plan again.
In mode `remind` (or without a judge) it only suggests running the command. Running
`/realctx consolidate` resets the clock; subagent sessions never suggest.

## Install

```bash
cd ~/Projects/realctx && npm install
pi install ~/Projects/realctx        # or add the path to "packages" in ~/.pi/agent/settings.json
```

realctx ships with no endpoints, API keys or model names: both endpoints default to none
(empty, or `"none"` in `config.json`), and realctx works without them. Open
`/realctx settings` to set:

- the **judge (SemIf) endpoint** and key. Without it, `realctx_remember` uses a
  deterministic gate (the safety scan, then a near duplicate by text overlap or
  embedding similarity is reinforced and anything else is added, with no
  importance/durability gate), the context layer drops by rules only (re-reads, re-edits,
  duplicates, emergency), user-message capture needs an explicit cue, and scheduled
  consolidation only reminds;
- the **embedding endpoint** and key. Without it, recall, deduplication and the search
  over dropped outputs use keyword (BM25) search only;
- the **SemIf model** and **embedding model**: the picker fetches the server's
  `/v1/models` list for you to choose from (or type a name). Left at `(auto)`, realctx
  uses the server's only model; if the server lists several, calls fail until you pick one.

Keys may be written as `$VAR` or `env:VAR` so they stay out of `config.json`. The design
doc's `judge.endpoint` / `judge.model` / `judge.key` / `judge.timeout_ms` /
`judge.max_questions` keys are accepted as aliases of the SemIf connection. Then run
`/realctx import` in each project that has an AGENTS.md or CLAUDE.md.

The context layer starts in shadow mode (`judge.shadow`) with capture in `suggest` mode.
Watch `/realctx outputs` and `/realctx status` for a while, then turn shadow off in
`/realctx settings` (rule-based drops of re-read, re-edited and duplicate outputs apply
from the start).

### Upgrading from realmem

realctx replaces realmem. If realmem is still in your Pi packages, realctx disables it
(see *Other context managers*; `/reload` once to unload it). On first start realctx moves `~/.pi/agent/realmem/` to
`~/.pi/agent/realctx/` (database renamed, tables kept; an existing realctx database is
never overwritten), and the first time it sees a project it moves `.pi/realmem/` to
`.pi/realctx/`, or merges it file by file (commit the move). Memory ids and file
contents are unchanged, and resumed sessions read their `realmem-*` entries as the
`realctx-*` ones. The tools are now `realctx_*`; there are no `realmem_*` aliases.

## Development

```bash
npm test          # unit + engine (mock embedding/SemIf servers, multi-process lock) + extension harness
npx tsc --noEmit
REALCTX_HOME=$(mktemp -d) pi -e ./extensions/realctx/index.ts   # isolated data dir
```

## License

[MIT](LICENSE)
