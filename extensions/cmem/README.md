# pi-cmem

Connect Pi to a shared claude-mem worker through its HTTP API. The package registers
one `memory_recall` tool, optionally captures Pi observations, and can inject a memory
digest using a configurable timing mode.

claude-mem is licensed under Apache-2.0. `pi-cmem` is an independent MIT-licensed HTTP
client; it does not import claude-mem code.

`@husniadil/pi-mem` is the fuller alternative: it can spawn the worker and offers a
three-tool recall workflow. This package deliberately stays smaller. In particular,
it does not prefix project names with `pi-`, so Pi, Claude Code, and Codex share one
repository namespace while `platformSource` still distinguishes the producing agent.

## External contract

A claude-mem worker must expose its health, search, context-injection, session, and
observation HTTP endpoints at the configured host and port. The default is the
worker's local endpoint at `127.0.0.1:37777`.

The optional fallback is a Python helper script that can search the same Chroma data
when the worker is unavailable. Capture and context injection always require the
worker; the fallback supports recall only.

## If the contract is unmet

At session start, an unreachable worker produces one warning without preventing Pi
from loading. Capture and context injection are disabled for that outage. Recall uses
the configured fallback helper when it exists; otherwise `memory_recall` reports that
recall is unavailable. A reachable worker returning no matches produces “No matching
memories found.”

In pi's print (`-p`) and json modes there is no UI to notify, so warnings that would
otherwise be silent there are written to stderr instead, once per distinct reason per
process.

`/memory-status` reports worker reachability and version, project scope, and session
identity. It lists every effective setting's value and source: defaults, discovered
claude-mem settings, global or trusted-project config paths, or environment variables.
The same info block shows session counts for observations sent, skipped, and
truncated, digests injected, and the character length of the last non-empty digest.
Settings remain visible when the worker is unreachable. Skipped results are those
without a tool name, from `memory_recall`, or named in `skipTools`. Captured responses
above `maxObservationChars` (default 1,000; minimum 200) are truncated with a marker.
The sent count tracks Pi's observation submissions; it does not confirm that the
worker persisted each one.

## Settings

Settings resolve from `pi-cmem.json` in the global Pi config directory, then from a
trusted project's Pi config directory, then from the environment. Later sources win.
Project settings are ignored when the project is untrusted.

Context injection is off by default. Set `inject` to `true` to enable it. `injectWhen`
controls when pi-cmem fetches and adds the digest:

- `every-call` (default) adds it through Pi's `context` hook on each model call. A turn
  that makes several model calls fetches the digest several times.
- `each-prompt` adds one hidden custom message when each prompt starts. Pi persists that
  message in the session; later requests include earlier prompt messages from the session
  history as well.
- `session-start` adds a hidden custom message before the first prompt in a Pi session.
  A resumed or reloaded session whose history already contains that message does not fetch
  another digest. A new session with no such message can fetch one on its first prompt.

`maxInjectChars` limits the digest text to that many characters and adds a `[truncated]`
marker when needed. The XML-style wrapper and marker are additional characters. Zero
means unlimited. The digest content and its worker-side size come from claude-mem's shared
`CLAUDE_MEM_CONTEXT_*` settings; `maxInjectChars` only truncates the response for pi-cmem
and does not change those shared settings.

`workerHost` and `workerPort` add one more layer below those: when neither an explicit
setting nor the environment names them, they are discovered from claude-mem's own
published settings (`~/.claude-mem/settings.json`, or
`$CLAUDE_MEM_DATA_DIR/settings.json`), which is where the worker it started actually
listens. claude-mem writes the port as a JSON string; discovery accepts both a string
and a number. Full precedence for these two keys: documented default -> claude-mem's
published settings -> global `pi-cmem.json` -> trusted project `pi-cmem.json` ->
environment. An unreachable-worker warning names which of `host`/`port` came from
discovery.

| JSON key | Default | Environment override | Meaning |
|---|---|---|---|
| `disabled` | `false` | `PI_CMEM_DISABLED=1` | Disable bridge activity. |
| `capture` | `true` | `PI_CMEM_CAPTURE=0` | Write prompts, tool observations, and summaries through the worker. |
| `skipTools` | `[]` | `PI_CMEM_SKIP_TOOLS` | Comma-separated Pi tool names to omit from captured observations; `memory_recall` is always skipped. Invalid config values use `[]` with a warning. |
| `maxObservationChars` | `1000` | `PI_CMEM_MAX_OBSERVATION_CHARS` | Maximum captured response length; must be an integer of at least 200. Invalid values use `1000` with a warning. |
| `inject` | `false` | `PI_CMEM_INJECT=1` | Enable worker-produced context digest injection. |
| `injectWhen` | `"every-call"` | `PI_CMEM_INJECT_WHEN` | `every-call`, `each-prompt`, or `session-start`; controls when the digest is added. Invalid values use `every-call` with a warning. |
| `maxInjectChars` | `0` | `PI_CMEM_MAX_INJECT_CHARS` | Maximum digest text length; zero is unlimited. Truncated text gets a marker. Invalid values use `0` with a warning. |
| `workerHost` | `"127.0.0.1"` | `PI_CMEM_WORKER_HOST` | claude-mem worker host; discovered from claude-mem's own settings when not set explicitly. |
| `workerPort` | `37777` | `PI_CMEM_WORKER_PORT` | claude-mem worker port; discovered from claude-mem's own settings when not set explicitly. |
| `project` | `""` | `PI_CMEM_PROJECT` | Project override; empty uses the current working-directory basename. |
| `fallbackPath` | `""` | `PI_CMEM_FALLBACK_PATH` | Optional Chroma search helper; empty means no fallback. |

Example:

```json
{
  "capture": true,
  "skipTools": ["read"],
  "maxObservationChars": 300,
  "inject": true,
  "injectWhen": "each-prompt",
  "maxInjectChars": 1200,
  "project": "shared-repository"
}
```

## Install and verify

```sh
pi install npm:pi-cmem
```

Start a session and run `/memory-status`. With a reachable worker, call
`memory_recall` with a known query and confirm the result belongs to the current bare
repository namespace. With the worker stopped, confirm that startup warns once and
that recall either uses the configured helper or reports the missing fallback. This
check exercises the external contract without depending on any particular deployment.
