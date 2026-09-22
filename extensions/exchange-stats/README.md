# pi-exchange-stats

Show timing, token, cache, cost, and tool-use statistics for each Pi exchange.

An **exchange** is one uninterrupted work span from a submitted prompt until Pi has
nothing left to do automatically. A **turn** is one model response plus the tools it
invokes, so an exchange can contain several turns. The status line shows the current
or most recent exchange, and a transcript card records the settled breakdown.

Tool time is the union of tool spans, not their sum, so parallel calls are not counted
twice. Model time is estimated as turn wall time minus tool time. Output throughput is
calculated per turn, while cumulative cost and token fields use Pi's reported usage.
Run `/exstats` to append a cumulative session card.

## External contract

Pi must emit its documented session, agent, turn, tool, and UI-prompt lifecycle events.
Assistant messages should include usage and cost fields when the provider supports
them. No network service or machine-local file is required.

## If the contract is unmet

Missing usage fields are reported as zero; the extension does not invent token or cost
data. Missing lifecycle events produce an incomplete or absent span. When UI status is
unavailable, status updates are skipped. If custom-entry persistence is unavailable,
the live status can still update and the agent turn continues.

The measurements are process-local. They do not claim provider-side queue time,
exclusive model compute time, or billing beyond the usage object Pi received.

## Settings

There are no settings and no environment variables. The package operates entirely
from Pi-provided events and context.

## Install and verify

```sh
pi install npm:pi-exchange-stats
```

Submit a prompt that makes at least one tool call and wait for Pi to settle. Expand the
exchange card and verify that its turn count, output tokens, tool names, and wall-time
breakdown match the transcript. Run `/exstats` and confirm that the session card equals
the sum of completed exchanges. To check parallel-tool accounting, run two overlapping
tools and confirm their union is not larger than the exchange wall time.
