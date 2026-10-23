# realctx: Design Doc (v2, with realmem)

**Status:** Draft
**Target:** Pi coding agent (extension), single-harness only
**Supersedes:** realctx design v1
**Incorporates:** [realmem](https://github.com/WtzLAS/realmem) (surprise-gated long-term memory for Pi)

**Summary:** realctx manages everything the model knows, at two time scales. Within a session, it drops spent tool outputs from the context and lets the model re-expand them. Across sessions, it keeps a small base of durable Markdown facts (realmem) that surface when relevant. Both run on one judge, one search index, one safety scanner and one path tracker, and the two layers feed each other: outputs that are about to be dropped are the main source of new memories.

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
- Existing realmem users upgrade with no data migration of their Markdown facts.

**Non-goals**

- Harnesses other than Pi.
- Summarizing or dropping user and assistant prose in v2 (tool outputs only).
- Automatic consolidation without the user starting it (see §15).

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
                      │                   └─ durable? ─► Extractor ─► Remember │
                      │                                   path (surprise gate) │
                      │                                         │              │
                      │                                         ▼              │
                      │                                  Memory store (.md)    │
                      │                                                        │
 context ────────────►│  Scheduler + Renderer (drops, placeholders, snapshot)  │
                      │                                                        │
 model tools ────────►│  real_recall / real_expand / real_remember / …         │
                      │        └──────── Unified index (FTS5 + vec) ───────┘   │
                      └────────────────────────────────────────────────────────┘
```

### 3.1 Shared core

| Component | Used by |
|---|---|
| **Judge client** (System One adapter, batching, question splitting, rate limit) | Drop decisions, remember path, path urgency, consolidation |
| **Embedder** | Memory dedup and recall, dropped-output search |
| **Unified index** (FTS5 BM25 + sqlite-vec, CJK pre-tokenizer) | `real_recall` across memories and dropped outputs |
| **Safety scanner** (secrets, prompt injection) | Remember path, judge payload redaction |
| **Path tracker** (paths touched per tool call) | Path notes, drop supersession rules, expand staleness |
| **Rewrite model** (a configured Pi model) | Memory Edit/Merge, fact extraction from outputs, summaries |
| **Prompt snapshot** | One `<realctx>` system-prompt section per session |
| **Lease lock + WAL** | Multi-process safety for every write |

### 3.2 Two layers

| Layer | Section | Owns |
|---|---|---|
| **Context layer** | §6–§9 | Output store, drop filter, scheduler, renderer, expansion |
| **Memory layer** | §10–§12 | Memory stores, remember path, path notes, consolidation |
| **Bridges** | §13 | Drop-time capture, memory-backed drops, path-note survival |

## 4. Pi integration points

| Hook / API | Context layer | Memory layer |
|---|---|---|
| `session_start` | Restore ID registry, drop set, verdicts | Resolve project key, check missing paths, check `.gitignore` |
| `before_agent_start` | — | Build or replay the `<realctx>` snapshot |
| `tool_result` | Capture original into output store | Compute touched paths, append path notes |
| `turn_end` | Queue drop candidates (background) | Persist shown-note ids (`realctx-shown`) |
| `context` | Apply drops, render placeholders | — (notes already in tool results) |
| `session_before_compact` | Cancel Pi compaction | — |
| `tool_call` | — | Block hidden memory tools (`ctx_memory`, …) |
| `registerTool` | `real_expand` | `real_recall`, `real_remember`, `real_forget`, `real_list`, `real_status` |
| `appendEntry` | ID registry, drop set | `realctx-snapshot`, `realctx-shown` |

> Verify event payloads and the `registerTool` signature against the installed Pi version.

## 5. Identity

Two ID namespaces, deliberately different in shape so neither the model nor the parser can confuse them:

| Object | Stable key | Shown to the model as | Lifetime |
|---|---|---|---|
| Tool output | Pi `toolCallId` | `#42` (session ordinal) | Session |
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

Results below `context.capture_min_tokens` are not stored; they're never dropped.

**Where originals live:** `~/.pi/agent/realctx/sessions/<project-key>/`, outside the project. Originals can contain secrets and must never land in the committed `.pi/realctx/` memory store.

## 7. Deciding what to drop

### 7.1 Deterministic filter

**Never drop**

- Results from the last `context.protect_turns` turns
- Results under `context.drop_min_tokens`
- Latest todo/plan snapshot; skill loads; tools in `context.protected_tools`
- Unresolved errors (errored, no later successful retry)

**Drop or shrink without asking**

- Exact duplicate calls: keep newest
- An older `read` of a path the tracker saw read again later
- Older edits to a path edited again later: shrink to a marker keeping path and region

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
- `known_memories` lists captions of memories attached to the candidate's paths (from path notes or a quick index lookup). It lets the judge see what's already saved.

**Questions:**

| ID | Type | Instruction |
|---|---|---|
| `still_needed` | yes/no | Will the agent likely need the exact contents to finish the current goal? |
| `unique_info` | yes/no | Does it contain facts that appear nowhere in `since_then` or `known_memories`? |
| `durable_fact` | yes/no | Does it reveal a lasting fact about the project (setup, conventions, constraints), not task status? |
| `action` | choice | keep / summarize / drop |

> The yes/no type is `noul` in LLM Gateway's and realmem's usage; confirm against your provider's schema.

`durable_fact` is the bridge to the memory layer (§13.1). Asking it costs almost nothing, because the state is already being read.

### 7.3 Policy

| Condition | Verdict |
|---|---|
| `still_needed` < `p_drop`, `unique_info` < `p_unique`, confidence ≥ `min_confidence` | **drop** |
| `action` = summarize, or `unique_info` ≥ `p_unique` | **summarize** (rewrite model, §7.5) |
| Otherwise | **keep**, re-judge later |

Independently: `durable_fact` ≥ `p_durable` → queue for capture (§13.1).

### 7.4 Verdict cache

- Cached per `toolCallId`; invalidated when the goal changes, not per turn.
- An expanded item is pinned as keep for `context.repin_turns` turns.

### 7.5 Summaries

The judge returns no text. Summaries come from the rewrite model (the same model realmem uses for Edit/Merge), with a deterministic fallback: head and tail lines, error lines, and paths. Summaries are generated in the background when the verdict is cached, never during the `context` hook.

## 8. Applying drops

Judging is eager and cheap; applying rewrites earlier messages and costs a cache rebuild. Queued drops apply only when:

1. **Pressure:** usage of the safe input window ≥ `context.apply_threshold`.
2. **Cache cold:** time since the last response ≥ `context.cache_ttl`.
3. **Emergency:** usage ≥ `context.emergency_threshold`: apply everything queued, then drop the largest unprotected results by age until under `apply_threshold`.

All queued drops apply in one pass. The safe input window is the model's window minus an output reservation capped at 25%.

## 9. Rendering and recovery

### 9.1 Placeholders

```
[#42 dropped · read src/auth/session.ts · 3.1k tok · real_expand(42)]
[#57 summarized · bash pnpm test · 8.4k tok · real_expand(57)]
  3 failing in auth/session.test.ts: expired-token cases
[#63 dropped · read docs/setup.md · 2.2k tok · saved as AZJrPlwafS-aSxwtPk9aaw]
```

- Tool name and arguments let the model decide without expanding.
- `saved as <id>` appears when the output's durable content became a memory (§13.2).
- Rendered once, byte-stable. Nothing derived from mutable data.

### 9.2 Forged-tag stripping

The renderer removes whole placeholder, header and `<realctx-path-notes>` patterns from assistant messages before sending. Never partial removal.

### 9.3 `real_expand`

```ts
real_expand({ ids: number[], lines?: string, grep?: string })
```

- Returns the original as a **new tool result** at the end; never restores in place.
- Capped at `context.expand_max_tokens`; overflow returns the head plus a hint to use `lines` or `grep`.
- **Staleness:** if the path tracker or mtimes show the file changed since capture, prepend "file edited since turn N; re-read for the current version."
- **Repeats:** a second expand of the same ID within `repin_turns` returns a pointer to the first.
- **No path notes:** expansions don't count as touching their paths, so memories aren't shown twice.
- Logs a false-drop signal for tuning (§14).

Dropped outputs are also searchable through `real_recall` (§12).

---

# Part B: Memory layer

This part keeps realmem's design, renamed into realctx's namespace. Where behavior is unchanged it is summarized, not restated.

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

### 11.1 Remember path (unchanged from realmem)

1. Safety scan: refuse (or redact) secrets; refuse injection patterns.
2. Exact duplicate → reinforce.
3. Neighbours: vector KNN + BM25 across visible scopes, fused with RRF.
4. Judge questions: `covered_by`, `conflict_with`, `merge_with`, `action`, `importance`, `durable`, `unsafe`, `scope`, `path_urgency`.
5. Decision rules (confident `covered_by` → reinforce; confident `conflict_with` → edit; disjoint paths are not a conflict; `user_requested` bypasses the importance gate; `unsafe` rejects).
6. Edit/Merge via the rewrite model, keeping the UUID, rescanned, with a deterministic fallback.
7. Atomic write, then background index and embed.
8. Judge or embedder down → per-project pending queue, retried automatically.

**New in v2:** each candidate carries a `source`: `user`, `agent`, `import`, or `capture` (from the context layer, §13.1). `capture` candidates get stricter gates (§13.1).

### 11.2 Path notes (unchanged from realmem, renamed)

After each tool call, memories covering the touched paths are appended to the tool result inside `<realctx-path-notes>`:

| Urgency score (0–2) | Shown as |
|---|---|
| High (≥ 1.5) | Full content |
| Mid (≥ 0.75, or unjudged) | Caption with id |
| Low | Counted only |

Each memory shows once per session branch, tracked in `realctx-shown` entries. Per-result limits (`max_full`, `max_captions`, `char_budget`) demote overflow.

Path notes share the tool result with the output, which interacts with dropping; see §13.3.

## 12. Model integration

### 12.1 Unified system-prompt section

One `<realctx>` section, computed on the first prompt, stored as a `realctx-snapshot` entry, and replayed byte-identically for the session (including reload and resume). It contains:

- realctx as the only memory and context system (ignore MEMORY.md, other memory plugins)
- recall before work; remember proactively
- captions of the most-used project-wide memories
- paths with path notes, e.g. `db (4), infra/terraform (2)`
- one line on placeholders and `real_expand`

AGENTS.md / CLAUDE.md are stripped from the prompt once imported.

### 12.2 Tools

| Tool | Does |
|---|---|
| `real_recall(queries?, paths?, ids?, sources?, page?, scope?)` | Hybrid search over memories **and** this session's dropped outputs. `sources` filters: `memory`, `output`, or both (default). Memories rank by path, then use, then relevance; outputs rank by relevance and recency. |
| `real_remember(caption, content, scope?, paths?, user_requested?)` | Remember path (§11.1) |
| `real_expand(ids, lines?, grep?)` | Restore dropped outputs (§9.3) |
| `real_forget(ids)` | Delete memories |
| `real_list(page?, scope?)` | List memories (large; demoted) |
| `real_status()` | Context usage, queued drops, memory counts, warnings |

Result entries are labeled by source so the two ID shapes are unambiguous:

```
memory AZJrPlwafS-aSxwtPk9aaw  Run e2e tests with pnpm test:e2e
output #57                     bash pnpm test (turn 22) · 3 failing in auth/session.test.ts …
```

**Compatibility:** `realmem_*` tool names stay registered as aliases for one release. The `realmem` skill becomes the `realctx` skill, covering recall, remember, scope choice, and expansion.

### 12.3 Conflicting plugins

realctx owns context management and memory end to end. At session start it detects other context managers (Magic Context, billion-context-pi, DCP-style pruners) and other memory systems, and refuses to run its context layer while they're active, with a message naming them. Calls to known foreign memory tools (`ctx_memory` by default) are blocked with a pointer to `real_remember`.

---

# Part C: Bridges

## 13. How the layers blend

### 13.1 Drop-time capture (context → memory)

A drop marks the moment an output is spent, which is exactly when its durable content is worth saving. When the judge says `durable_fact` ≥ `p_durable`:

1. The rewrite model extracts 0–3 candidate facts from the original output (caption, content, paths from the tracker).
2. Each candidate enters the remember path with `source: capture`.
3. Capture candidates require `importance` ≥ `capture.min_importance` and `durable` ≥ `capture.min_durable`, both stricter than for agent-initiated remembers.
4. Extraction runs in the background, rate-limited to `capture.max_per_session_hour`, and never delays a drop.

Capture can be set to `"off"`, `"suggest"` (candidates are queued for approval in `/realctx manage`, reusing realmem's quarantine), or `"auto"`. The default is `suggest` until the false-capture rate is measured.

### 13.2 Memory-backed drops (memory → context)

If an output's durable content is already a memory, the output is safer to drop:

- When the remember path returns `covered_by` or reinforce for every captured fact, the candidate's `unique_info` is treated as low.
- The placeholder records the memory id (`saved as AZJr…`), so the model can recall the fact without expanding the output.

### 13.3 Path-note survival

Path notes live inside tool results, so dropping a result would drop its notes, and realmem's once-per-branch rule would stop them reappearing. realctx handles this explicitly:

- When a result is dropped, its path-note memory ids are removed from `realctx-shown`. The next touch of those paths shows them again. This mirrors realmem's existing behavior after compaction.
- The judge never sees path-note text as part of the output (it's passed as `known_memories` instead), so notes don't inflate `unique_info`.
- Path notes don't count toward the result's size for drop thresholds.

### 13.4 Shared path tracker

The tracker computes touched paths once per tool call (path arguments, plus `bash` words that exist on disk). Its output feeds:

| Consumer | Uses it for |
|---|---|
| Path notes | Which memories to show |
| Drop filter | Supersession (re-read and re-edit rules) |
| `real_expand` | Staleness warnings |
| Capture | Default `paths` for extracted facts |
| `real_recall` | Ranking memories about recently touched paths first |

### 13.5 Shared judge budget

All judge calls (drop, remember, urgency, consolidation) share one client with batching, question splitting by the server's `max_questions`, and one rate limiter. Priority, highest first: remember path, drop decisions, path urgency, consolidation.

Failure policy differs by layer:

| Layer | When the judge is unavailable |
|---|---|
| Context | Keep everything; deterministic rules still run; re-judge later |
| Memory | Queue the candidate; retry automatically |

## 14. Telemetry and rollout

**Metrics**

- Tokens reclaimed by source (rule / judge / emergency)
- Prompt-cache hit rate before and after each apply pass
- **False-drop rate:** dropped outputs expanded within N turns
- **Capture quality:** share of captured memories later forgotten, edited heavily, or removed by consolidation
- Recall hit rate for `output` vs `memory` sources
- Judge latency and spend per layer

**Rollout**

1. Ship with `judge.shadow: true` for the context layer and `capture: "suggest"`.
2. Tune `p_drop`, `min_confidence` from the false-drop rate.
3. Move capture to `"auto"` once accepted-suggestion rate is high.

## 15. Commands

`/realctx` opens a menu; `/realmem` remains an alias.

| Subcommand | Does |
|---|---|
| `status` | Context usage, queued drops, memory counts, warnings |
| `manage [query]` | Browse memories and pending captures; edit, re-scope, approve |
| `outputs` | Browse this session's captured outputs, verdicts and drops |
| `flush` | Apply queued drops now, ignoring the cache TTL |
| `settings` | Judge, embedder, rewrite model, thresholds; connectivity tests |
| `debug` | Dry-run a drop decision or a remember, showing raw judge answers |
| `add`, `import`, `prune-paths`, `consolidate`, `fix-gitignore`, `embed`, `reindex`, `retry` | As in realmem |

Consolidation stays user-started, as in realmem: a judge review against same-store neighbours (forget, cover, supersede, merge, revise), then a path-revision pass.

## 16. Storage

| Data | Location |
|---|---|
| Memory facts | Markdown files per scope (§10) |
| Database (index, embeddings, usage, urgency, locks, pending, approvals, verdicts, output metadata) | `~/.pi/agent/realctx/realctx.sqlite` (WAL, lease locks) |
| Output originals | `~/.pi/agent/realctx/sessions/<project-key>/` |
| Session state | `appendEntry`: ID registry, drop set, `realctx-snapshot`, `realctx-shown` |
| Config | `~/.pi/agent/realctx/config.json` (mode 0600; keys as `$VAR` or `env:VAR`) |

**Migration from realmem:** on first start, `~/.pi/agent/realmem/` is moved to `~/.pi/agent/realctx/` (database renamed, tables kept), and project stores at `.pi/realmem/` are moved to `.pi/realctx/` with a one-line notice. Memory IDs and file contents are unchanged. Session entries named `realmem-*` are read as their `realctx-*` equivalents.

## 17. Configuration

| Key | Default | Meaning |
|---|---|---|
| `judge.endpoint`, `judge.model`, `judge.key` | — | Shared System One judge |
| `judge.timeout_ms` | `3000` | Per-request timeout |
| `judge.max_questions` | server limit | Split questions across requests |
| `judge.shadow` | `true` | Context layer logs verdicts without acting |
| `embedding.endpoint`, `embedding.model` | — | Without it: BM25-only search and dedup |
| `rewrite.model` | — | Pi model for Edit/Merge, extraction, summaries |
| `context.capture_min_tokens` | `1000` | Smaller outputs aren't stored or dropped |
| `context.drop_min_tokens` | `1000` | Never drop below this |
| `context.protect_turns` | `4` | Recent turns immune from dropping |
| `context.protected_tools` | `["todo", "skill"]` | Never dropped (latest instance for snapshots) |
| `context.p_drop` | `0.15` | Max `still_needed` to drop |
| `context.p_unique` | `0.3` | Max `unique_info` to drop |
| `context.min_confidence` | `0.7` | Min judge confidence to act |
| `context.apply_threshold` | `0.65` | Safe-window usage that applies queued drops |
| `context.emergency_threshold` | `0.9` | Emergency reclaim |
| `context.cache_ttl` | `"5m"` | Provider cache lifetime; per-model override |
| `context.expand_max_tokens` | `4000` | Cap per expansion |
| `context.repin_turns` | `10` | Expanded items stay kept |
| `capture.mode` | `"suggest"` | `off` / `suggest` / `auto` |
| `capture.p_durable` | `0.7` | `durable_fact` needed to attempt capture |
| `capture.min_importance` | stricter than remember | Gate for capture candidates |
| `capture.max_per_session_hour` | `6` | Rate limit |
| `path_notes.high`, `path_notes.mid` | `1.5`, `0.75` | Urgency tiers |
| `path_notes.max_full`, `max_captions`, `char_budget` | as realmem | Per-result limits |
| `consolidate.neighbors` | `12` | Same-store neighbours reviewed |
| `consolidate.forget`, `consolidate.revise` | `0.7`, `0.7` | Probability thresholds |
| `consolidate.min_importance` | `0.5` | Below this: forget |

## 18. Failure handling

| Failure | Behavior |
|---|---|
| Judge down | Context: keep all. Memory: queue and retry |
| Embedder down | BM25-only neighbours and search |
| Output store unreadable | Disable dropping; never drop what can't be restored |
| Memory write lock held > 2 min | Queue the candidate |
| Foreign context manager detected | Context layer off, memory layer on, warning shown |
| Rendering exception | Pass messages through unchanged; log loudly |

realctx never blocks the agent's turn on its own work.

## 19. Open questions

1. **Capture granularity.** Should capture also consider user messages (corrections, stated preferences), or stay limited to tool outputs?
2. **Endpoint drift.** LLM Gateway has added `/v1/decisions` and plans to deprecate `/v1/systemone` for its own service. The judge adapter should support both.
3. **Local-first judging.** Should the default judge be local (Ollama), since drop decisions send tool output excerpts?
4. **Idle consolidation.** realmem consolidates only on request. Is a scheduled, suggest-only run worth adding?
5. **Subagents.** Separate context layer per child session, with the memory layer shared?
6. **Output retention.** How long to keep originals for ended sessions, and whether `real_recall` should search other sessions' outputs.

## 20. References

- realmem: https://github.com/WtzLAS/realmem
- Magic Context: https://github.com/cortexkit/magic-context
- billion-context: https://github.com/ranxianglei/billion-context
- DCP: https://github.com/Opencode-DCP/opencode-dynamic-context-pruning
- Pi extensions: https://pi.dev/docs/latest/extensions
- System One API (LLM Gateway): https://llmgateway.io/changelog/system-one-typed-decisions
- Pydantic AI System One models: https://pydantic.dev/docs/ai/models/system-one/
