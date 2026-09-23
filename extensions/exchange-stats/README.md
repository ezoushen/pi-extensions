# pi-exchange-stats

Show timing, token, cache, cost, and tool-use statistics for each Pi exchange.
Each run of thinking and tool calls between pieces of assistant text starts folded
as one process line, even when it spans assistant messages or turns. The line shows
block counts and total wall time, or the current block and its live time while
streaming. At the next fold level, each block has a one-line title in stream order.
Tool titles show the argument, status, duration, and result line count. Thinking
titles show the trace's last complete sentence, or `Thinking` until one completes.
With `summaryModel` configured, a short model headline takes its place when ready;
the leading `≈` marks it as a summary. A failed or timed-out request returns to
the sentence fallback and gives one warning per session.
The headline is shortened first to make room for duration and stats.
Titles also show elapsed time, thinking tokens and rate while streaming; a `~` marks
token estimates when the provider has not reported reasoning usage. Settled titles
show duration and word count. Opening a thinking block shows Pi's full trace,
regardless of Pi's hide-thinking setting. Process lines and block titles use the
active Pi theme's dim color. Assistant text and opened native content keep Pi's own
styling.

Press `ctrl+alt+f` to toggle the latest process between its line and block titles.
Press `ctrl+alt+e` to open or fold every process in the latest exchange. Press
`ctrl+alt+s` to open the picker; use Up/Down and Enter to toggle an exchange,
process, or block, and Escape to close it. The picker marks open items; opening a
block also opens its process, while folding that block leaves the process open.
These controls work while an exchange streams and change only the display. In
fullscreen mode, left click a process line or block title to toggle it.

An experimental transcript cursor is available with `cursorMode: true`. Press
`ctrl+alt+g` to enter it, Up/Down to move through process lines and the block
titles of open processes, Enter to toggle the highlighted item, and Escape to
return to the editor. The selected title also appears in the status line, since
regular terminal scrollback can leave the highlighted line above the viewport.
Fullscreen Pi exposes scrolling by line, but its extension UI does not expose the
selected transcript row's position; the cursor therefore cannot scroll to it.

An **exchange** is one uninterrupted work span from a submitted prompt until Pi has
nothing left to do automatically. A **turn** is one model response plus the tools it
invokes, so an exchange can contain several turns. The status line shows the current
or most recent exchange. The transcript card shows the exchange headline, summary,
and token and cost totals in both collapsed and expanded views. Block titles carry
the individual timing and count details.

Tool time is the union of tool spans, not their sum, so parallel calls are not counted
twice. Model time is estimated as turn wall time minus tool time. Output throughput is
calculated per turn, while cumulative cost and token fields use Pi's reported usage.
Run `/exstats` to append a cumulative session card. Exchange entries retain block
durations, status, counts, and headlines outside model context. On resume, reload,
or a branch switch, the extension rebuilds fold state from the active session
branch without sending historical thinking to the headline model. Older entries
without block statistics still show their card; their thinking titles use `—` for
unknown duration.

## External contract

Pi must emit its documented session, agent, turn, tool, and UI-prompt lifecycle events.
Display wrappers are installed at `session_start` and released at `session_shutdown`;
loading the extension without a session leaves Pi's component prototypes unchanged.
Overlapping extension instances share the wrappers until the last session releases them.
Tool folding uses Pi's `ToolExecutionComponent.render` interface from version 0.87.1.
Thinking folding uses `AssistantMessageComponent.updateContent` and Pi's
`message_update` events. Its clock starts at the first thinking delta and stops
at `thinking_end`, the first following non-thinking event, or message end,
whichever comes first. Streamed snapshots of one assistant message must retain
the same Pi message timestamp for the local clock to follow them.
Assistant messages should include usage and cost fields when the provider supports
them. Model headlines use Pi's configured provider; no separate endpoint is needed.

## If the contract is unmet

Missing usage fields are reported as zero for exchange totals; the extension does
not invent exchange token or cost data. Thinking estimates are explicitly marked
with `~`.
Missing lifecycle events produce an incomplete or absent span. When UI status is
unavailable, status updates are skipped. If custom-entry persistence is unavailable,
the live status can still update and the agent turn continues. If Pi no longer
provides the tool render interface, a single warning is shown and tool rows use
Pi's native renderer; exchange stats continue.
If Pi no longer provides the assistant content interface, a single warning is
shown and thinking uses Pi's native rendering.

The timings are measured locally, then saved in exchange entries. They do not
claim provider-side queue time, exclusive model compute time, or billing beyond
the usage object Pi received.

## Settings

The optional `exchange-stats.json` file in Pi's agent directory configures
`processKey`, `exchangeKey`, and `pickerKey`. Their defaults are `ctrl+alt+f`,
`ctrl+alt+e`, and `ctrl+alt+s`. The experimental `cursorKey` defaults to
`ctrl+alt+g`. Each key value must be a modified Pi key such as
`ctrl+alt+x` or `alt+enter`; an invalid value uses its default and produces one warning.
The matching environment variables are `PI_EXCHANGE_STATS_PROCESS_KEY`,
`PI_EXCHANGE_STATS_EXCHANGE_KEY`, `PI_EXCHANGE_STATS_PICKER_KEY`, and
`PI_EXCHANGE_STATS_CURSOR_KEY`. Set `cursorMode` to the boolean `true` in the same
file, or set `PI_EXCHANGE_STATS_CURSOR_MODE=true`, to register the cursor shortcut.
It is off by default.

Set `summaryModel` to a `provider/modelId` registered in Pi's model registry.
It is off by default. Put it in `<agentDir>/exchange-stats.json`, or in a trusted
project's `.pi/exchange-stats.json`. For example:

```json
{ "summaryModel": "my-provider/my-headline-model" }
```

`PI_EXCHANGE_STATS_SUMMARY_MODEL` overrides the file setting. While thinking
streams, the extension sends at most the last 1,500 trace characters after about
400 new tokens or six seconds, and once more when the block ends. Requests use
reasoning off and a 32 token output cap. The model call never delays the turn or
the trace; with the setting absent or an unknown model, titles use the trace
sentence.

## Install and verify

```sh
pi install npm:pi-exchange-stats
```

Submit a prompt that makes at least one tool call and produces thinking, then wait
for Pi to settle. Check that one process line covers each stretch between pieces of
assistant text, that its counts and live activity change as blocks arrive, and that
its total time stops when the process completes. Expand the
exchange card and verify that its summary and token and cost totals match the
transcript. Open a process to see individual block timings and counts. Run
`/exstats` and confirm that the session card equals the sum of completed
exchanges. To check parallel-tool accounting, run two overlapping tools and
confirm their union is not larger than the exchange wall time.
