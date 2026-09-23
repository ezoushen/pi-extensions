# pi-extensions

Four extensions for the [pi coding agent](https://pi.dev), published from one repository.

Three of them exist because a long-running agent session repeatedly pays to re-read
context a server already has. The fourth shows what each exchange cost and folds its
thinking and tool calls into compact lines.

| package | what it does |
|---|---|
| [`pi-prefix-stabilizer`](extensions/prefix-stabilizer) | Keeps pi's system prompt byte-stable so a server's KV prefix cache survives across turns and resumes. Normalises the install path, sorts tools deterministically, and warns once when the prompt genuinely drifts. |
| [`pi-compaction-cache`](extensions/compaction-cache) | Makes `/compact` reuse that cache instead of re-prefilling the window from cold, by building the summarization request as a true prefix of the live conversation. |
| [`pi-cmem`](extensions/cmem) | Bridges pi to a [claude-mem](https://github.com/thedotmack/claude-mem) worker over its HTTP API, so pi sessions share one memory namespace with other agents working in the same repository. |
| [`pi-exchange-stats`](extensions/exchange-stats) | Timing and cost for each exchange, in the status line and an exchange card. Folds each run of thinking and tool calls into one process line, with per-block titles and Pi's native output one toggle away. |

## Install

```sh
pi install npm:pi-prefix-stabilizer
pi install npm:pi-compaction-cache
pi install npm:pi-cmem
pi install npm:pi-exchange-stats
```

Each package is independent. Install only what you want.

**One ordering rule, if you install both cache packages:** list `pi-prefix-stabilizer`
before `pi-compaction-cache` in your `packages` array. The stabiliser normalises the
provider payload, and the compaction extension captures that payload as its cache
prefix — reversed, the compaction extension captures a volatile prefix and silently
gets no cache hits at all. A repo-level test enforces this contract.

## Configuration

Every environment fact is a setting with a documented default. Nothing is hard-coded
to one machine, and nothing writes to your home directory unless you ask it to.

Settings resolve in this order, with later sources winning:

1. the package's documented default
2. a peer service's own published settings, where one applies (`pi-cmem` reads
   claude-mem's settings file to find the worker it is actually running on)
3. the package's config file in your pi agent directory
4. the same file in `<project>/.pi/`, **only when the project is trusted**
5. the package's environment variable

Each value carries the source it came from, so a package can tell you not just what a
setting is but where it came from. See each package's README for its own settings table.

The config files are named per package — note that two of them do not follow the
package name:

| package | config file |
|---|---|
| `pi-prefix-stabilizer` | `pi-prefix-stabilizer.json` |
| `pi-compaction-cache` | `compaction-cache.json` |
| `pi-cmem` | `pi-cmem.json` |
| `pi-exchange-stats` | `exchange-stats.json` |

## Behaviour when something is missing

None of these four is correctness-critical, so none of them takes a session down. A
malformed settings file degrades to the documented defaults. An unreachable peer
service is reported, not fatal. Every such announcement is made **once** per session
per distinct reason — and when pi is running non-interactively, where there is no UI to
notify, it goes to stderr instead of vanishing.

Silence is the failure mode these packages are built to avoid. If one of them decides
not to act, it says so.

## Development

```sh
npm install
npm run build     # esbuild, one bundled entry per package
npm test          # unit and contract tests
npm run test:live # drives a real pi session against the packed tarballs
```

The live suite starts its own stub provider on a local port and runs pi against a
scratch agent directory. It contacts no external service and does not touch your real
pi installation.

## Licence

MIT. `pi-cmem` talks to claude-mem, which is Apache-2.0; it imports none of its code.
