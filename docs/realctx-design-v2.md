# realctx: Design Doc (v2)

**Status:** Implemented (this repository); §19 lists what is still open
**Target:** Pi coding agent (extension), single-harness only
**Supersedes:** realctx design v1
**Incorporates:** [realmem](https://github.com/WtzLAS/realmem) (surprise-gated long-term memory for Pi), which realctx replaces; its data migrates automatically (§16)

**Summary:** realctx manages everything the model knows, at two time scales. Within a session, it drops spent tool outputs from the context and lets the model re-expand them. Across sessions, it keeps a small base of durable Markdown facts that surface when relevant. Both run on one judge, one search index, one safety scanner and one path tracker, and the two layers feed each other: outputs that are about to be dropped, and what the user says, are the main sources of new memories.

---

## 1. Background

### 1.1 Two problems, one plugin

| | **Working context** (realctx v1) | **Long-term memory** (realmem) |
|---|---|---|
| Time scale | One session | Every session, every project |
| Unit | A tool output | A Markdown fact |
| Problem | Context fills with spent output | Agents forget everything between sessions |
| Decision | Keep / summarize / drop | Add / Edit / Merge / Reinforce / reject |
| Judge | System One decision model | System One decision model (SemIf) |

They were designed separately but already make the same structural choices: Pi-only, a System One judge for the decision, code owns the policy, byte-stable prompt injection for cache safety. Merging them removes duplicated infrastructure and adds one capability neither has alone: **forgetting from the context becomes the trigger for remembering**.

### 1.2 Lessons carried over

From studying Magic Context, billion-context and DCP:

1. **Fragile identity.** Content-hash IDs break when bytes change; session counters break on host compaction. Use stable IDs.
2. **The echo problem.** Tags on assistant text get imitated by the model. Never tag assistant text.
3. **Cache cost.** Every edit to an earlier message re-bills everything after it. Batch edits and time them.
4. **Capture is free at compression time.** Magic Context's historian extracts durable knowledge in the same pass that compresses history. realctx does the same at drop time.

From realmem:

5. **Gate memory on surprise.** Store a fact only when it's new, important and durable; otherwise reinforce what exists.
6. **Scope by path.** A fact about `packages/web` should appear when the agent touches `packages/web`, not in every prompt.
7. **Snapshot the system prompt.** Compute injected sections once per session and replay them byte-identically.

## 2. Goals and non-goals

**Goals**

- Sessions run far past the context window with no compaction pauses.
- Nothing is lost: every drop is reversible, and durable knowledge outlives the session.
- Prompt-cache hit rate stays ≥ 90% on cache-priced providers.
- The main model doesn't manage context. It recalls and remembers; it never cites IDs to free space.
- No inline tags on assistant text.
- Replace AGENTS.md / CLAUDE.md with recallable, path-scoped facts.
- Existing realmem users upgrade automatically: data directories move on first start, Markdown facts and memory ids are unchanged (§16).
- Works with no endpoints configured; the judge and the embedder improve it but are optional (§13.5).

**Non-goals**

- Harnesses other than Pi.
- Rewriting prose in place. Old turns are replaced as a whole by a frozen summary block (§9.4), never edited message by message.
- Consolidation that writes without the user. A scheduled check only suggests (§15).

## 3. Overview

```
                      ┌─────────────────────── realctx ───────────────────────┐
                      │                                                        │
 tool_result ────────►│  Path tracker ──► Path notes (memory → tool result)    │
                      │       │                                                │
                      │       ▼                                                │
                      │  Output store (originals, per session)                 │
                      │       │                                                │
 turn_end ───────────►│  Drop filter ─► Judge ─► Verdict cache                 │
                      │                   │                                    │
 user message ───────►│  Judge ───────────┴─ durable? ─► Extractor ─► Remember │
                      │                                   path (surprise gate) │
                      │                                         │              │
                      │                                         ▼              │
                      │                                  Memory store (.md)    │
                      │                                                        │
 context ────────────►│  Scheduler + Renderer (drops, placeholders, snapshot)  │
                      │                                                        │
 model tools ────────►│  realctx_recall / realctx_expand / realctx_remember …  │
                      │        └──────── Unified index (FTS5 + vec) ───────┘   │
                      └────────────────────────────────────────────────────────┘
```

### 3.1 Shared core

| Component | Used by |
|---|---|
| **Judge client** (System One adapter, `/v1/systemone` with `/v1/decisions` fallback, question splitting, priority queue, rate limit) | Drop decisions, user-message capture, remember path, path urgency, consolidation |
| **Embedder** | Memory dedup and recall, dropped-output search |
| **Unified index** (FTS5 BM25 + sqlite-vec, CJK pre-tokenizer) | `realctx_recall` across memories and dropped outputs |
| **Safety scanner** (secrets, prompt injection) | Remember path, judge payload redaction |
| **Path tracker** (paths touched per tool call) | Path notes, drop supersession rules, expand staleness |
| **Rewrite model** (a configured Pi model) | Memory Edit/Merge, fact extraction from outputs and user messages, summaries |
| **Prompt snapshot** | One `<realctx>` system-prompt section per session |
| **Lease lock + WAL** | Multi-process safety for every write |
| **Process-shared engine** | One engine (database, index, clients, capture budget) for every session of a process (§13.6) |

### 3.2 Two layers

| Layer | Section | Owns |
|---|---|---|
| **Context layer** | §6–§9 | Output store, drop filter, scheduler, renderer, expansion |
| **Memory layer** | §10–§12 | Memory stores, remember path, path notes, consolidation |
| **Bridges** | §13 | Drop-time and user-message capture, memory-backed drops, path-note survival, sessions |

## 4. Pi integration points

| Hook / API | Context layer | Memory layer |
|---|---|---|
| `session_start` | Restore ID registry, drop set, pins; adopt a parent's originals (§13.6); warn about and disable other context managers (§12.3) | Migrate realmem data, resolve project key, check missing paths and `.gitignore`, prune expired outputs, scheduled consolidation check |
| `before_agent_start` | — | Build or replay the `<realctx>` snapshot |
| `tool_result` | Capture original into output store | Compute touched paths, append path notes |
| `turn_end` | Persist registry and drops; queue drop candidates (background) | Persist shown-note ids (`realctx-shown`); user-message capture (background) |
| `message_end` | Usage and cache telemetry per response | — |
| `input` | — | Mark extension-sent messages as not the user's |
| `session_tree`, `session_compact` | Rebuild the drop set for the new branch | Rebuild shown-note ids |
| `session_shutdown` | — | Release the shared engine; withdraw the parent announcement |
| `context` | Apply drops, render placeholders | — (notes already in tool results) |
| `session_before_compact` | Cancel Pi's threshold compaction (manual `/compact` and overflow recovery still run) | — |
| `tool_call` | Block tools of disabled context managers | Block hidden memory tools (`ctx_memory`, …) |
| `registerTool` | `realctx_expand` | `realctx_recall`, `realctx_remember`, `realctx_forget`, `realctx_list`, `realctx_status` |
| `appendEntry` / `turn_end` entries | `realctx-ids` (registry), `realctx-drops` (drops, pins) | `realctx-snapshot`, `realctx-shown` |

Verified against Pi 1.4.0.

## 5. Identity

Two ID namespaces, deliberately different in shape so neither the model nor the parser can confuse them:

| Object | Stable key | Shown to the model as | Lifetime |
|---|---|---|---|
| Tool output | Pi `toolCallId`, scoped by session id | `#42` (session ordinal) | Session, then `context.retentionDays` after its last activity |
| Memory | UUIDv7 | 22-char base64url, e.g. `AZJrPlwafS-aSxwtPk9aaw` | Forever |

- Output ordinals are assigned on first sight and persisted, so `#42` means the same thing for the whole session.
- Memory IDs never change, including through Edit, Merge and consolidation. Tools also accept the canonical UUID or a unique prefix.
- Neither kind of ID ever appears in assistant text injected by realctx.

---

# Part A: Context layer

## 6. Capturing outputs

On `tool_result`, realctx records the original output in the output store, with:

- `toolCallId`, ordinal, tool name, argument summary, turn number
- size in tokens (computed once, never updated)
- touched paths (from the path tracker) and file mtimes at capture time
- any path-note memory IDs appended to this result (§11)

Results below `context.captureMinTokens` are not stored; they're never dropped. Path notes appended to a result are not part of the stored original.

**Where originals live:** `~/.pi/agent/realctx/sessions/<project-key>/<session-id>/` (files mode 0600), outside the project. Originals can contain secrets and must never land in the committed `.pi/realctx/` memory store. Each session has its own directory; a child session copies what it inherits (§13.6).

**Retention:** originals, their index rows, vectors and verdicts are deleted once their session has had no activity for `context.retentionDays` (default 7; `0` keeps them forever). Sessions open in the current process are never pruned, and open sessions refresh their activity at turn end (at most hourly) so other Pi processes' sweeps keep them. The sweep runs at most once a day across all processes (shared schedule), checked at session start and at turn end. It also deletes store folders that no index row knows and that were not written to within the retention period (lost index, crashes), and temp files of interrupted writes older than a day. A placeholder whose original expired can no longer be expanded; `realctx_expand` says so and the model re-runs the tool.

**Images:** images in tool results are stored with the result; images attached to a user message are stored as one output per message (tool `user`, id derived from the message key, so it is stable across reloads), captured on the first request that contains the message. An image counts what the session model charges for it, from the pixel size in its encoded header (PNG, JPEG, GIF, WebP, BMP): Anthropic ⌈w·h/750⌉ after its downscale (long edge 1568 px / 1.15 MP; 2576 px / 3.75 MP for Claude ≥ 4.7), OpenAI 512-px tiles (gpt-4o, gpt-4.1, gpt-5, o-series) or 32-px patches capped at 1536 (mini/nano), Gemini 1120 per image (3.x) or 258 per tile (≤ 2.x), otherwise ⌈w·h/750⌉. Unreadable sizes count as a 2000×2000 image (Pi's resize bound). A dropped user image is replaced, inside the user message, by its placeholder (`[#N dropped · 2 user images · 4k tok]`); the text of the message stays. History compression matches chunks by the keys of the messages as Pi sent them, so rendered placeholders do not break the match.

## 7. Deciding what to drop

### 7.1 Deterministic filter

**Never drop**

- Results from the last `context.protectTurns` turns
- Results under `context.dropMinTokens` (outputs with images: under `min(dropMinTokens, 200)`)
- Latest todo/plan snapshot; skill loads; tools in `context.protectedTools`
- Unresolved errors (errored, no later successful call of the same tool on the same paths or arguments)
- Outputs expanded within `context.repinTurns` turns

**Drop or shrink without asking**

- Exact duplicate calls: keep newest
- An older `read` of a path the tracker saw read again later
- Older edits to a path edited again later: shrink to a marker keeping path and region
- A `realctx_expand` result whose pin expired (the original is still restorable)
- Images (tool results and the user's) older than `context.imageMaxTurns` turns (placeholder ends `· old image`)

Everything else is a gray-zone candidate.

### 7.2 Judge

**State** (compact JSON):

```json
{
  "current_goal": "<last user message> + <current todo list>",
  "candidate": {
    "id": "t42",
    "tool": "read",
    "args": { "path": "src/auth/session.ts" },
    "tokens": 3100,
    "turns_ago": 14,
    "excerpt": "<first ~40 lines> … <last ~20 lines>"
  },
  "since_then": ["edited src/auth/session.ts", "ran tests: 3 failing"],
  "known_memories": ["[AZJr…] Auth sessions expire after 15 min idle"]
}
```

- `excerpt` passes through the safety scanner first; detected secrets are redacted before anything leaves the machine.
- Images never reach the judge: `excerpt` has the text and an `[N images]` marker, and `candidate.images` gives the count (the `still_needed` instruction says the agent can restore a dropped image).
- `known_memories` lists captions of memories attached to the candidate's paths (from path notes or a quick index lookup). It lets the judge see what's already saved.

**Questions:**

| ID | Type | Instruction |
|---|---|---|
| `still_needed` | yes/no | Will the agent likely need the exact contents to finish the current goal? |
| `unique_info` | yes/no | Does it contain facts that appear nowhere in `since_then` or `known_memories`? |
| `durable_fact` | yes/no | Does it reveal a lasting fact about the project (setup, conventions, constraints), not task status? |
| `action` | choice | keep / summarize / drop |

The yes/no type is `noul` (LLM Gateway's System One schema).

`durable_fact` is the bridge to the memory layer (§13.1). Asking it costs almost nothing, because the state is already being read.

### 7.3 Policy

| Condition | Verdict |
|---|---|
| `still_needed` < `pDrop`, `unique_info` < `pUnique`, confidence ≥ `minConfidence` | **drop** |
| (`action` = summarize, or `unique_info` ≥ `pUnique`), `still_needed` < `pKeep` | **summarize** (rewrite model, §7.5) |
| Otherwise | **keep**, re-judge later |

Outputs with images are never summarized (no model reads them): a summarize verdict becomes a drop, and no facts are captured from them.

Confidence is P(drop) + P(summarize) of the `action` answer. Independently: `durable_fact` ≥ `capture.pDurable` → capture (§13.1). With `judge.shadow` on (the default), verdicts are only logged; rule and emergency drops still apply. Without a judge, only the deterministic filter and emergency reclaim drop.

### 7.4 Verdict cache

- Cached per session and `toolCallId`; invalidated when the goal changes, not per turn.
- An expanded item is pinned as keep for `context.repinTurns` turns.
- At most `judge.maxPerPass` new candidates are judged per background pass.

### 7.5 Summaries

The judge returns no text. Summaries come from the rewrite model (the same model used for memory Edit/Merge), with a deterministic fallback: head and tail lines, error lines, and paths. Summaries are generated in the background when the verdict is cached, never during the `context` hook.

## 8. Applying drops

Judging is eager and cheap; applying rewrites earlier messages and costs a cache rebuild. Queued drops apply only when:

1. **Pressure:** usage of the safe input window ≥ `context.applyThreshold`.
2. **Cache cold:** time since the last response ≥ `context.cacheTtl` (per-model overrides in `context.cacheTtlByModel`).
3. **Emergency:** usage ≥ `context.emergencyThreshold`: apply everything queued, then drop the largest unprotected results until under `applyThreshold`.
4. **Flush:** `/realctx flush`, or a cancelled threshold compaction, applies at the next request.

All queued drops apply in one pass, together with any history parts the historian has prepared (§9.4), so the prefix is rebuilt at most once. Usage is the last response's reported tokens plus estimates for later messages, minus what was dropped since. The safe input window is the model's window minus an output reservation capped at 25%.

## 9. Rendering and recovery

### 9.1 Placeholders

```
[#42 dropped · read src/auth/session.ts · 3.1k tok]
[#57 summarized · bash pnpm test · 8.4k tok]
  3 failing in auth/session.test.ts: expired-token cases
[#63 dropped · read docs/setup.md · 2.2k tok · saved as AZJrPlwafS-aSxwtPk9aaw]
[#71 superseded · edit src/auth/session.ts · 1.4k tok · edited again in #80]
```

- Tool name and arguments let the model decide without expanding.
- No tool-call hints (such as `realctx_expand(42)`) in rendered text: the `#N` / `hN` numbers are enough, and the system-prompt section and the tool description say how to restore them.
- `saved as <id>` appears when the output's durable content became a memory (§13.2).
- Rendered once, frozen and persisted in `realctx-drops`; byte-identical on every request, after reload and after resume. Nothing derived from mutable data.

### 9.2 Forged-tag stripping

The renderer removes whole placeholder lines, `<realctx-path-notes>` blocks and `<realctx…>` tags from assistant messages before sending. Never partial removal.

### 9.3 `realctx_expand`

```ts
realctx_expand({ ids: number[], lines?: string, grep?: string })
```

- Returns the original as a **new tool result** at the end; never restores in place.
- Capped at `context.expandMaxTokens`; overflow returns the head plus a hint to use `lines` or `grep`.
- Images are returned whole (they cannot be cut); their tokens come out of the text budget of the same item. With `lines` or `grep` they are left out, and the header says so.
- **Staleness:** if the path tracker or mtimes show the file changed since capture, prepend "file edited since turn N; re-read for the current version."
- **Repeats:** a second expand of the same ID within `repinTurns` returns a pointer to the first.
- **Missing:** an ID that was never captured in this session, or whose original expired (§6), is reported as not found.
- **No path notes:** expansions don't count as touching their paths, so memories aren't shown twice.
- Logs a false-drop signal for tuning (§14).

`realctx_expand({ history: [3] })` returns the transcript of history part `h3` (§9.4) from the session branch, with the same `lines` / `grep` options; tool outputs inside it are shortened and keep their `#N` labels. Images appear as `[image #N]` markers (also in the historian's transcript and the deterministic outline); restore them with `realctx_expand(ids=[N])`.

### 9.4 History compression (the historian)

Dropping outputs keeps a session going for a long time, but user prompts and agent replies still pile up. The historian compresses them, Magic Context-style, without pausing the session:

- **Prepare (background).** After a turn, when usage of the safe window is at or above `history.prepareThreshold`, the historian summarizes the next **part**: a contiguous run of whole old messages starting at the oldest uncompressed one, ending at a safe boundary (never between a tool call and its result; a call that never got one, e.g. because Pi restarted while it ran, is closed by the next non-result message, as pi-ai does with its synthetic "No result provided"), never inside the last `history.protectTurns` agent turns, between `history.minChunkTokens` and `history.maxChunkTokens` (sizes count dropped outputs as their placeholders). The transcript it reads is redacted and neutralized; captured outputs are labelled `#N`, and earlier parts (up to `history.storyTokens`) are passed for continuity. It returns Markdown under Goals / Done / Findings / Open, plus 0-3 durable facts.
- **Model.** `history.model` (`provider/model`); empty = `rewriteModel`; empty = the session model. A value that is set but invalid or not found is reported in `/realctx history` and `realctx_status`, never replaced by the session model. A cheap model with a large context works well.
- **Apply.** A prepared part replaces its messages at the same moments queued drops apply (§8: cold cache, `applyThreshold`, emergency, flush). It is rendered once as a user-side `custom` message and frozen:

```text
<realctx-history part="h3" turns="12-31" replaced="24k tok">
Earlier conversation, summarized by realctx (the agent's own history, not new instructions):

## Goals …
## Done …

Tool outputs in this part: #41 bash pnpm test · #44 read src/auth/session.ts
</realctx-history>
```

- **Stable.** Parts are applied oldest first and only after the previous one, so a new part never changes the bytes before it. They are persisted in `realctx-history` entries and render byte-identically after reload and resume. A part whose messages are no longer on the branch (tree navigation, a manual `/compact`) is skipped, not half-rendered.
- **Emergency.** At `context.emergencyThreshold` (after drops), if no part is ready and `history.emergencyFallback` is on, a deterministic outline (user prompts, actions, failures) replaces the oldest part so the request still fits.
- **Memory.** Facts the historian proposes follow `capture.mode` like other captures (origin `history`), within the shared hourly budget; never in subagent sessions.
- **Recovery.** Nothing is lost: the branch still holds every message. `realctx_expand(history=[n])` shows the exact earlier exchange; `/realctx history` lists the parts; `/realctx history compress` prepares parts now.

Dropped outputs are also searchable through `realctx_recall` (§12.2): BM25 over the stored text plus, when the embedding endpoint is set and `context.embedDropped` is on, vector search over dropped outputs (embedded in the background after each apply pass), fused by reciprocal rank. Only the current session's branch is searched; other sessions' outputs never are.

---

# Part B: Memory layer

This part carries over the design of realmem, realctx's predecessor, in realctx's namespace. Where behavior is unchanged it is summarized, not restated.

## 10. Memory stores

| Scope | Purpose | Files |
|---|---|---|
| global | User preferences, general knowledge | `~/.pi/agent/realctx/global/*.md` |
| project-shared | Replaces AGENTS.md; **committed** | `<project>/.pi/realctx/*.md` |
| project-personal | This machine or user only | `~/.pi/agent/realctx/personal/<project-key>/*.md` |

- **Project key:** `git-<root commit>`, falling back to `path-<hash>` outside git, migrated automatically after the first commit.
- **One fact per file**, frontmatter `id` (UUIDv7), `caption`, `paths`, `created`, `updated`. Volatile data (usage counts, urgency, flags) lives in the database, never in frontmatter.
- **`.gitignore` check:** realctx warns at session start if git ignores the shared store, and `/realctx fix-gitignore` appends a verified fix.

## 11. Remember path and path notes

### 11.1 Remember path

1. Safety scan: refuse (or redact) secrets; refuse injection patterns.
2. Exact duplicate → reinforce.
3. Neighbours: vector KNN + BM25 across visible scopes, fused with RRF.
4. Judge questions: `covered_by`, `conflict_with`, `merge_with`, `action`, `importance`, `durable`, `unsafe`, `scope`, `path_urgency`.
5. Decision rules (confident `covered_by` → reinforce; confident `conflict_with` → edit; disjoint paths are not a conflict; `user_requested` bypasses the importance gate; `unsafe` rejects).
6. Edit/Merge via the rewrite model, keeping the UUID, rescanned, with a deterministic fallback.
7. Atomic write, then background index and embed.
8. Judge configured but unreachable, or the write lock held too long → per-project pending queue, retried automatically.

**Without a judge** (no endpoint, the default): steps 1–3 run, then a deterministic gate replaces steps 4–5. A neighbour with word-set Jaccard ≥ 0.8 or cosine ≥ 0.93 is a near duplicate and is reinforced (widening its paths if needed); anything else is added, with no importance or durability gate. Nothing is queued.

**New in v2:** each candidate carries a `source`: `user`, `agent`, `import`, or `capture` (from the context layer, §13.1), and capture candidates an `origin` (`output` or `user`). `capture` candidates get stricter gates (§13.1).

### 11.2 Path notes

After each tool call, memories covering the touched paths are appended to the tool result inside `<realctx-path-notes>`:

| Urgency score (0–2) | Shown as |
|---|---|
| High (≥ 1.5) | Full content |
| Mid (≥ 0.75, or unjudged) | Caption with id |
| Low | Counted only |

Each memory shows once per session branch, tracked in `realctx-shown` entries. Per-result limits (`paths.maxFull`, `paths.maxCaptions`, `paths.charBudget`) demote overflow.

Path notes share the tool result with the output, which interacts with dropping; see §13.3.

## 12. Model integration

### 12.1 Unified system-prompt section

One `<realctx>` section, computed on the first prompt, stored as a `realctx-snapshot` entry, and replayed byte-identically for the session (including reload and resume). It contains:

- realctx as the only memory and context system (ignore MEMORY.md, other memory plugins)
- recall before work; remember proactively
- captions of the most-used project-wide memories
- paths with path notes, e.g. `db (4), infra/terraform (2)`
- one line on placeholders and `realctx_expand`

AGENTS.md / CLAUDE.md are stripped from the prompt once imported.

### 12.2 Tools

| Tool | Does |
|---|---|
| `realctx_recall(queries?, paths?, ids?, sources?, page?, scope?)` | Hybrid search over memories **and** this session's dropped outputs (BM25 + vectors, §9.3). `sources` filters: `memory`, `output`, or both (default). Memories rank by path, then use, then relevance; outputs rank by relevance and recency. Never searches other sessions' outputs. |
| `realctx_remember(caption, content, scope?, paths?, user_requested?)` | Remember path (§11.1) |
| `realctx_expand(ids, lines?, grep?)` | Restore dropped outputs (§9.3) |
| `realctx_forget(ids)` | Delete memories |
| `realctx_list(page?, scope?)` | List memories (large; demoted) |
| `realctx_status()` | Context usage, queued drops, memory counts, warnings |

Result entries are labeled by source so the two ID shapes are unambiguous:

```
memory AZJrPlwafS-aSxwtPk9aaw  Run e2e tests with pnpm test:e2e
output #57                     bash pnpm test (turn 22) · 3 failing in auth/session.test.ts …
```

**Naming:** every tool is prefixed `realctx_`. realmem's `realmem_*` tools and `/realmem` command are not kept as aliases; realmem's data migrates (§16), and a still-loaded realmem extension is disabled like any other conflicting plugin (§12.3). The `realctx` skill covers recall, remember, scope choice, and expansion.

### 12.3 Conflicting plugins

realctx owns context management and memory end to end; two context managers rewriting the same messages break each other's cache stability and placeholders. At session start realctx groups the registered tools by extension (`sourceInfo`) and identifies other context managers: Magic Context (`ctx_reduce`, `ctx_expand`, `ctx_note`), billion-context (`bc_*`), DCP-style pruners (`prune`, `discard`, `extract`, counted only when the source also looks like a pruner), names in `context.conflictTools`, and realmem (a memory system realctx replaces). It then acts per `context.conflictAction`:

| Action | Effect |
|---|---|
| `disable` (default) | Warn; deactivate all of the plugin's tools now and block calls to them; turn its package off in Pi's settings (the entry becomes `{ "source": …, "extensions": [] }`, a standard package filter), so it is gone after `/reload`. realctx's context layer stays off until then, because the plugin's hooks still run. |
| `warn` | Warn only; realctx's context layer stays off while it is loaded. |
| `ignore` | Run realctx's context layer next to it. |

- Settings are edited through Pi's `SettingsManager` (file lock, other keys and packages preserved): user packages in `~/.pi/agent/settings.json`, project packages in `.pi/settings.json` only when the project is trusted. Extensions loaded with `-e` or from the `extensions` setting are reported, not edited. Subagent sessions never edit settings.
- Each change is recorded with the previous package entry. `/realctx conflicts enable <name>` restores it and marks the plugin as allowed (never auto-disabled again); `/realctx conflicts disable <name>` reverses that.
- realmem only duplicates the memory layer, so it does not turn the context layer off; it is still disabled, since both would append path notes.

Calls to known foreign memory tools (`prompt.hideTools`, `ctx_memory` by default) are blocked with a pointer to `realctx_remember`.

---

# Part C: Bridges

## 13. How the layers blend

### 13.1 Drop-time capture (context → memory)

A drop marks the moment an output is spent, which is exactly when its durable content is worth saving. When the judge says `durable_fact` ≥ `p_durable`:

1. The rewrite model extracts 0–3 candidate facts from the original output (caption, content, paths from the tracker).
2. Each candidate enters the remember path with `source: capture`.
3. Capture candidates require `importance` ≥ `capture.minImportance` and `durable` ≥ `capture.minDurable`, both stricter than for agent-initiated remembers.
4. Extraction runs in the background, rate-limited to `capture.maxPerSessionHour` per session family (§13.6), and never delays a drop.

Capture can be set to `"off"`, `"suggest"` (candidates are queued for approval in `/realctx captures` or `/realctx manage`), or `"auto"`. The default is `suggest` until the false-capture rate is measured.

**User messages** (`capture.userMessages`, default on). Users state lasting preferences, decisions and corrections ("always use pnpm here", "no, the API is v2 now") that no tool output contains. After each turn, the latest user message is considered once:

1. Skipped: messages under `capture.userMinChars`, slash and `!` commands, acknowledgements ("ok", "thanks", "go ahead"), expanded skills, messages sent by extensions (`input` with source `extension`), and every message of a subagent session (its "user" is the parent agent).
2. With a judge: one `noul` question, `durable_user_fact` (does it state a lasting preference, decision, correction or project fact, not a one-off instruction?), over the redacted message and the previous agent reply. ≥ `capture.pDurable` goes on. Without a judge: only messages with an explicit cue (*always*, *never*, *prefer*, *from now on*, *we use*, …) go on.
3. The rewrite model extracts 0–3 standalone facts, which follow `capture.mode` and the same budget. Suggestions record `origin: user`.

### 13.2 Memory-backed drops (memory → context)

If an output's durable content is already a memory, the output is safer to drop:

- When the remember path returns `covered_by` or reinforce for every captured fact, the candidate's `unique_info` is treated as low.
- The placeholder records the memory id (`saved as AZJr…`), so the model can recall the fact without expanding the output.

### 13.3 Path-note survival

Path notes live inside tool results, so dropping a result would drop its notes, and the once-per-branch rule would stop them reappearing. realctx handles this explicitly:

- When a result is dropped, its path-note memory ids are removed from `realctx-shown`. The next touch of those paths shows them again, as after a compaction.
- The judge never sees path-note text as part of the output (it's passed as `known_memories` instead), so notes don't inflate `unique_info`.
- Path notes don't count toward the result's size for drop thresholds.

### 13.4 Shared path tracker

The tracker computes touched paths once per tool call (path arguments, plus `bash` words that exist on disk). A call without path arguments, and every mutating call, also gets the files its result `details` report (`path` / `paths`, a `v2|<path>|…` `snapshotId`, unified `patch` headers), so anchor-addressed edits (pi-hashline-edit-pro) are tracked; the result-based paths are recomputed from the stored tool-result messages after a reload. When a later `tool_result` handler of another extension rewrites a result, realctx stores the final version at `message_end` and re-appends its path notes if they were removed. Its output feeds:

| Consumer | Uses it for |
|---|---|
| Path notes | Which memories to show |
| Drop filter | Supersession (re-read and re-edit rules) |
| `realctx_expand` | Staleness warnings |
| Capture | Default `paths` for extracted facts |
| `realctx_recall` | Ranking memories about recently touched paths first |

### 13.5 Shared judge budget

All judge calls (drop, user capture, remember, urgency, consolidation) share one client per process with question splitting by the server's `maxQuestions`, `judge.concurrency` parallel requests and a `judge.minIntervalMs` rate limit. Queued requests run by priority, highest first: remember path, drop decisions and user capture, path urgency, consolidation. The client calls `/v1/systemone` and falls back to `/v1/decisions` on 404 (`judge.api` pins one).

Failure policy differs by layer:

| Layer | When the judge is unavailable |
|---|---|
| Context | Keep everything; deterministic rules still run; re-judge later |
| Memory | Queue the candidate; retry automatically |
| User capture | Skip the message |

| Layer | When no judge is configured (the default) |
|---|---|
| Context | Deterministic rules and emergency reclaim only |
| Memory | Deterministic gate (§11.1); nothing queued |
| User capture | Cue words only |
| Consolidation | Reminder only (§15) |

### 13.6 Sessions and subagents

Every Pi session has its own context layer; the memory layer is shared.

- **Own context layer.** Registry, ordinals, drops, pins and stored originals are per session. Every database query over outputs, vectors and verdicts is keyed by session id, so two sessions with the same tool call ids never see each other's outputs.
- **Children.** A child session is a fork or clone (its header names the `parentSession`) or a subagent: a session started while a realctx session is running, which announces its id in `REALCTX_PARENT_SESSION` for subprocesses and in-process SDK sessions alike. A child that inherits branch entries copies the referenced originals into its own directory and re-registers them, so its placeholders stay byte-identical and restorable even after the parent's originals expire.
- **Shared memory layer.** All sessions of a process share one engine (database, index, judge and embedding clients, pending-queue drain), opened by the first session and closed by the last. Across processes the database, WAL and lease locks already make sharing safe.
- **Family budgets.** The capture budget is per session family (root session), so subagents cannot multiply it. Subagents never capture user messages and never show the consolidation suggestion.

## 14. Telemetry and rollout

**Metrics**

- Tokens reclaimed by source (rule / judge / emergency)
- Prompt-cache hit rate before and after each apply pass
- **False-drop rate:** dropped outputs expanded within N turns
- **Capture quality:** share of captured memories later forgotten, edited heavily, or removed by consolidation
- Recall hit rate for `output` vs `memory` sources
- Judge latency and spend per layer

**Rollout**

1. Ship with `judge.shadow: true` for the context layer and `capture.mode: "suggest"`.
2. Tune `pDrop`, `minConfidence` from the false-drop rate.
3. Move capture to `"auto"` once accepted-suggestion rate is high.

## 15. Commands

`/realctx` opens a menu.

| Subcommand | Does |
|---|---|
| `status` | Context usage, queued drops, memory counts, warnings |
| `manage [query]` | Browse memories and pending captures; edit, re-scope, approve |
| `captures` | Approve, edit or reject captured facts (from outputs or the user) |
| `outputs` | Browse this session's captured outputs, verdicts and drops |
| `flush` | Apply queued drops and prepared history parts at the next request, ignoring the cache TTL |
| `history [compress]` | List history parts and the historian; `compress` prepares parts now (§9.4) |
| `settings` | Judge, embedder, rewrite model, thresholds; connectivity tests |
| `debug [#N]` | Dry-run a drop decision (`#N`) or a remember, showing raw judge answers |
| `conflicts [enable\|disable <name>]` | Other context managers: list, re-enable, disable (§12.3) |
| `add`, `import`, `prune-paths`, `consolidate`, `fix-gitignore`, `embed`, `reindex`, `retry` | Memory maintenance |

Consolidation writes only when the user runs it: a judge review against same-store neighbours (forget, cover, supersede, merge, revise), then a path-revision pass.

**Scheduled suggestion** (`consolidate.schedule`). At session start (not in subagents), when the stores visible from the cwd hold at least `minMemories` memories and were last consolidated, or first seen, more than `everyDays` days ago:

- `plan` (default): with a judge, make a dry-run plan in the background, store it, and notify with its summary. `/realctx consolidate` then offers to apply that stored plan as is (memories changed since are skipped) or to plan again. Without a judge it behaves like `remind`.
- `remind`: only notify, suggesting `/realctx consolidate`.
- `off`.

Each period suggests once; running `/realctx consolidate` resets the clock. Nothing is ever written by the schedule.

## 16. Storage

| Data | Location |
|---|---|
| Memory facts | Markdown files per scope (§10) |
| Database (index, embeddings, usage, urgency, locks, pending, suggestions, verdicts, output metadata and vectors, schedule, telemetry) | `~/.pi/agent/realctx/realctx.sqlite` (WAL, lease locks) |
| Output originals | `~/.pi/agent/realctx/sessions/<project-key>/<session-id>/` (retention §6) |
| Session state | Session entries: `realctx-ids`, `realctx-drops`, `realctx-snapshot`, `realctx-shown` |
| Config | `~/.pi/agent/realctx/config.json` (mode 0600; keys as `$VAR` or `env:VAR`) |

**Migration from realmem** (automatic, unless `REALCTX_HOME` points elsewhere):

- On first start, `~/.pi/agent/realmem/` is moved to `~/.pi/agent/realctx/`, renaming `realmem.sqlite` (with its `-wal`/`-shm` files) to `realctx.sqlite`; tables are kept and upgraded by the normal schema migration. If both directories exist, only a missing database is brought over; an existing realctx database is never overwritten.
- The first time a project is seen, its `.pi/realmem/` store is moved to `.pi/realctx/` (or merged file by file, leaving clashes for review), with a notice to commit the move.
- Memory ids and file contents are unchanged. Session entries `realmem-snapshot` and `realmem-shown` are read as their `realctx-*` equivalents, so resumed sessions keep their prompt and shown notes.
- Tool names are not aliased (§12.2).

## 17. Configuration

`~/.pi/agent/realctx/config.json`, edited in `/realctx settings`. The judge connection is stored as `semif`; `judge.endpoint`, `judge.model`, `judge.key`, `judge.timeout_ms` and `judge.max_questions` are accepted as aliases.

| Key | Default | Meaning |
|---|---|---|
| `semif.endpoint`, `semif.model`, `semif.apiKey` | none | Shared System One judge. Empty or `"none"` = not configured (§13.5) |
| `semif.timeoutMs`, `semif.maxQuestions` | `180000`, `16` | Per-request timeout; split questions across requests |
| `embedding.endpoint`, `embedding.model`, `embedding.apiKey` | none | Without it: BM25-only search and dedup |
| `rewriteModel` | session model | Pi model for Edit/Merge, extraction, summaries |
| `history.enabled` | `true` | History compression on/off (§9.4) |
| `history.model` | `rewriteModel`, else session model | The historian (`provider/model`) |
| `history.prepareThreshold` | `0.2` | Safe-window usage at which parts are prepared |
| `history.protectTurns` | `8` | Recent agent turns never compressed |
| `history.minChunkTokens`, `history.maxChunkTokens` | `6000`, `30000` | Size of one part |
| `history.summaryMaxTokens`, `history.storyTokens` | `1500`, `3000` | Summary bound; earlier parts passed for continuity |
| `history.captureFacts`, `history.emergencyFallback` | `true`, `true` | Facts from the historian; deterministic outline in an emergency |
| `judge.shadow` | `true` | Context layer logs verdicts without acting |
| `judge.concurrency`, `judge.minIntervalMs` | `1`, `0` | Parallel judge requests; rate limit |
| `judge.api` | `"auto"` | `auto` / `systemone` / `decisions` |
| `judge.maxPerPass` | `6` | New drop candidates judged per background pass |
| `context.enabled` | `true` | Context layer on/off |
| `context.captureMinTokens` | `1000` | Smaller outputs aren't stored or dropped |
| `context.dropMinTokens` | `1000` | Never drop below this |
| `context.protectTurns` | `4` | Recent turns immune from dropping |
| `context.imageMaxTurns` | `6` | Images (tool results and the user's) older than this are dropped by a rule; `0` = off |
| `context.protectedTools` | `["todo", "todo_write", "TodoWrite", "skill"]` | Never dropped (latest instance for snapshots) |
| `context.pDrop`, `context.pUnique`, `context.pKeep` | `0.15`, `0.3`, `0.5` | Policy thresholds (§7.3) |
| `context.minConfidence` | `0.7` | Min judge confidence to act |
| `context.applyThreshold` | `0.25` | Safe-window usage that applies queued drops |
| `context.emergencyThreshold` | `0.9` | Emergency reclaim |
| `context.cacheTtl`, `context.cacheTtlByModel` | `"5m"`, `{}` | Provider cache lifetime; per-model override |
| `context.expandMaxTokens` | `4000` | Cap per expansion |
| `context.repinTurns` | `10` | Expanded items stay kept |
| `context.retentionDays` | `7` | Originals of inactive sessions are deleted after this; `0` = forever |
| `context.embedDropped` | `true` | Vector search over dropped outputs (needs the embedder) |
| `context.cancelCompaction` | `true` | Cancel Pi's threshold compaction while active |
| `context.conflictTools` | `[]` | Extra tool names that identify a context manager (§12.3) |
| `context.conflictAction` | `"disable"` | `disable` / `warn` / `ignore` other context managers (§12.3) |
| `capture.mode` | `"suggest"` | `off` / `suggest` / `auto` |
| `capture.pDurable` | `0.7` | `durable_fact` / `durable_user_fact` needed to attempt capture |
| `capture.minImportance`, `capture.minDurable` | `1.5`, `0.7` | Gates for capture candidates (stricter than `thresholds.*`) |
| `capture.maxPerSessionHour` | `6` | Rate limit per session family |
| `capture.userMessages`, `capture.userMinChars` | `true`, `24` | User-message capture (§13.1) |
| `thresholds.urgencyHigh`, `thresholds.urgencyMid` | `1.5`, `0.75` | Path-note urgency tiers |
| `paths.maxFull`, `paths.maxCaptions`, `paths.charBudget` | `3`, `8`, `6000` | Per-result path-note limits |
| `consolidate.neighbors` | `12` | Same-store neighbours reviewed |
| `consolidate.forget`, `consolidate.revise` | `0.7`, `0.7` | Probability thresholds |
| `consolidate.minImportance` | `0.5` | Below this: forget |
| `consolidate.schedule.mode`, `.everyDays`, `.minMemories` | `"plan"`, `14`, `20` | Scheduled suggestion (§15) |

## 18. Failure handling

| Failure | Behavior |
|---|---|
| Judge not configured | Deterministic paths everywhere (§13.5) |
| Judge down | Context: keep all. Memory: queue and retry. User capture: skip |
| Embedder down | BM25-only neighbours and search |
| Output store unreadable | Disable dropping; never drop what can't be restored |
| Original expired (retention) | Placeholder stays; `realctx_expand` reports it as not found |
| realmem migration fails | Notice at session start; the old directory stays in place |
| Memory write lock held > 2 min | Queue the candidate |
| Foreign context manager detected | Warn and disable it (tools now, package on `/reload`); context layer off until it is unloaded; memory layer on |
| Pi settings not writable | Tools still disabled; warning names the file and asks to remove the package |
| Historian model unset, invalid or failing | Nothing compressed (error shown in `/realctx history`); emergency outline only |
| History part no longer on the branch | Skipped; those messages pass through unchanged |
| Rendering exception | Pass messages through unchanged; log loudly |

realctx never blocks the agent's turn on its own work.

## 19. Open questions

Resolved in the implementation:

1. **Capture granularity.** User messages are captured too (§13.1), judged after each turn; subagent and extension-sent messages are excluded.
2. **Endpoint drift.** The judge client supports both `/v1/systemone` and `/v1/decisions` (§13.5).
3. **Idle consolidation.** A scheduled, suggest-only check exists; it can make the plan in the background but never writes (§15).
4. **Subagents.** Separate context layer per child session, memory layer shared (§13.6).
5. **Output retention.** Originals are kept for `context.retentionDays` (7) after a session's last activity; `realctx_recall` never searches other sessions' outputs (§6, §9.3).
6. **Endpoints.** None by default; everything works without them, with deterministic fallbacks (§13.5).
7. **Old prose.** Old user and agent turns are compressed by the historian, with its own model setting (§9.4).

Still open:

1. **Local-first judging.** Should a local judge (e.g. Ollama) be suggested, since drop decisions send tool output excerpts? Today nothing is sent until the user configures an endpoint.
2. **Telemetry reports.** Usage, drops, expansions and captures are logged, but no false-drop-rate or cache-hit report is computed yet.
3. **History quality.** No automatic check yet that a historian summary kept what later turns needed (e.g. by counting `realctx_expand(history=…)` calls).

## 20. References

- realmem: https://github.com/WtzLAS/realmem
- Magic Context: https://github.com/cortexkit/magic-context
- billion-context: https://github.com/ranxianglei/billion-context
- DCP: https://github.com/Opencode-DCP/opencode-dynamic-context-pruning
- Pi extensions: https://pi.dev/docs/latest/extensions
- System One API (LLM Gateway): https://llmgateway.io/changelog/system-one-typed-decisions
- Pydantic AI System One models: https://pydantic.dev/docs/ai/models/system-one/
