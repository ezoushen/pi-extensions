# pi-compaction-cache

Make Pi compaction reuse a server's prefix cache instead of rebuilding the
summarization request from a cold prompt.

Pi normally serializes the conversation into a new user message under a new system
prompt. That request shares no prefix with the live conversation. This extension
keeps the live system prompt, tools, and chronological messages, then appends Pi's
summarization instructions as the final user turn:

```text
[ live system + live tools ][ live messages ][ summarization instructions ]
```

The extension captures the ordinary provider payload, performs compaction from
`session_before_compact`, and rewrites the summarization payload through
`onPayload`. Pi still owns split-turn handling, file-operation metadata, usage
accounting, and persistence. Any guard failure returns control to Pi's default
compaction.

## External contract

The serving system must provide content-addressed prefix caching and retain the
conversation prefix until compaction uses it. Some server implementations require a
retention setting for sliding-window or hybrid cache groups; this package cannot set
or detect that server policy.

Sending the longer live conversation is appropriate only when cached input is free.
With no `models` matcher, the extension therefore activates only when the current
model reports both input and cache-read prices as zero. An explicit matcher overrides
that heuristic for catalog entries whose cost metadata is absent or unsuitable.

The provider must also invoke the supplied `onPayload` callback. The extension checks
that the rewrite actually ran before accepting a summary.

## If the contract is unmet

If the model is inapplicable, the provider does not rewrite the payload, the live
prefix is unavailable, or another correctness guard fails, Pi performs its default
compaction. The extension announces each distinct decline reason once per session.
Run `/compaction-cache-status` to see whether it applies to the current model, the
deciding rule, and every resolved setting with provenance.

In pi's print (`-p`) and json modes there is no UI to notify, so an announcement that
would otherwise be silent there is written to stderr instead, once per distinct reason
per process.

If server-side caching or retention is ineffective, compaction remains correct but
does not receive the prefill benefit. This condition is not observable through the
provider API, so validate it with server metrics using the protocol below.

## Load order

Load `pi-prefix-stabilizer` before `pi-compaction-cache`.

The stabilizer must normalize the ordinary request before this extension captures it.
Keep the compaction package after extensions that observe compaction without supplying
one. If another handler replaces its result, `pi-compaction-cache` warns once and
disables itself for the rest of the session rather than paying for discarded work.

Install in dependency order:

```sh
pi install npm:pi-prefix-stabilizer
pi install npm:pi-compaction-cache
```

## Settings

Settings resolve from `compaction-cache.json` in the global Pi config directory,
then from a trusted project's Pi config directory, then from the environment. Later
sources win. Project settings are ignored when the project is untrusted.

| JSON key | Default | Environment override | Meaning |
|---|---:|---|---|
| `enabled` | `true` | `PI_COMPACTION_CACHE=0` disables | Register normally but decline compaction work when false. |
| `models` | `[]` | `PI_COMPACTION_CACHE_MODELS='["provider/model"]'` | Non-empty minimatch patterns override the cost heuristic; patterns match `provider/modelId` or a bare `modelId`. |
| `logPath` | `""` | `PI_COMPACTION_CACHE_LOG` | Append JSON diagnostics when a path is set. |
| `debug` | `false` | `PI_COMPACTION_CACHE_DEBUG=1` | Include captured payload skeletons in the diagnostic log. |
| `scope` | `"boundary"` | `PI_COMPACTION_CACHE_SCOPE` | `boundary` sends the old slice Pi will discard; `full` sends the whole conversation. |
| `maxWords` | `1500` | `PI_COMPACTION_CACHE_MAX_WORDS` | Summary word-budget guidance; `0` disables the guidance. |

Example:

```json
{
  "models": ["local/*", "my-model"],
  "scope": "boundary",
  "maxWords": 1500
}
```

## Measurements

These results came from a large-context model behind a prefix-caching server. They
show the mechanism, not a portable capacity recommendation.

### Server retention

Before the server retained checkpoints for its hybrid cache groups, byte-identical
repeats were cold. After retention was enabled, the same prompts reused almost all
input:

| prompt tokens | before (cold → repeat) | after (cold → repeat) | hit | tokens not reused |
|---:|---:|---:|---:|---:|
| 9,089 | 9.73s → 9.72s, no reuse | 12.91s → 0.36s | 98.6% | 129 |
| 22,914 | 23.62s → 23.71s, no reuse | 27.36s → 0.41s | 99.4% | 130 |
| 64,016 | 83.43s → 67.77s, no reuse | 69.97s → 0.44s | 99.8% | 144 |

The small un-reused tail shows checkpoint granularity, but it does not determine the
right retention value. Retention must survive the eviction pressure created by other
requests.

**Superseded history:** a value of `128` was initially recommended because it bounded
the un-reused tail near 130 tokens. That recommendation was reversed by a pressure
test: a cached 132,000-token prefix at that value was evicted by one intervening
request, producing 144.26s at 0% reuse; a larger value produced 0.61s at 99.95% reuse.
The pool was 34% utilized with 0 preemptions in both arms. A server-side retention
setting may therefore be required, but its right value is governed by eviction
pressure rather than by the un-reused tail and must be measured on the reader's own deployment.

The original recommendation also relied on a lower-pressure check: four concurrent
27,500-token prompts completed with 0 preemptions, and one repeated afterward reached
99.4% reuse in 0.39s. The later 132,000-token eviction result showed why that check was
not representative enough to choose a deployment setting.

As a separate control, one prompt sent under three different client-side cache keys
reached 98.9% reuse each time. Those request fields did not control the tested server's
content-addressed prefix cache.

### Compaction reuse

One ordinary cold turn followed immediately by compaction:

| request | prompt tokens | cached | hit | TTFT |
|---|---:|---:|---:|---:|
| ordinary turn | 69,790 | 0 | 0.00% | 116.82s |
| compaction | 70,064 | 69,632 | **99.38%** | **1.14s** |

Same synthetic 125k-token snapshot compacted both ways:

| implementation | prompt tokens | cached | block hit | TTFT | wall |
|---|---:|---:|---:|---:|---:|
| Pi default | 151,148 | 0 | 0.00% | 176.5s | 193.9s |
| extension | 202,841 | 202,368 | **99.77%** | **1.55s** | **20.9s** |

Same 90,000-token repository snapshot with 54 tool schemas, compacted both ways:

| implementation | prompt tokens | cached | block hit | TTFT | wall | summary |
|---|---:|---:|---:|---:|---:|---:|
| Pi default | 3,328 | 0 | 0.00% | 6.00s | 45.3s | 4,945 chars |
| extension | 69,927 | 69,504 | **99.40%** | **1.00s** | 23.2s | 8,490 chars |

The extension sent 21 times more evidence because Pi truncates tool results in its
serialized input, yet the cached request still reached first token faster. In the
synthetic quality check, the extension recorded all eight completed segments; the
default summary incorrectly left the eighth pending because it did not see the kept
tail.

### Boundary cut

The cache needs a prefix, not the whole conversation. Pi only discards the old slice,
so the default `boundary` scope stops after the next completed assistant turn. If the
boundary cannot be located, the extension safely falls back to the full conversation.

Same snapshot, word-budget guidance disabled:

| scope | messages sent | prompt tokens | cached | hit | wall | summary |
|---|---:|---:|---:|---:|---:|---:|
| full conversation | 16/16 | 59,696 | 59,136 | 99.06% | 282.7s | 4,125 words |
| boundary cut | **6/16** | **44,963** | 44,416 | 98.78% | **240.0s** | **3,536 words** |

The boundary cut sent 25% fewer tokens at approximately the same cache-hit rate.
With the shipped boundary and word-budget defaults, the same snapshot used 45,001
prompt tokens, reached 99.55% cache reuse and 0.77s TTFT, and produced a 2,437-word
summary in 197.7s. The earlier full version used 59,696 tokens and produced 4,125
words in 282.7s.

### Summary budget

Controlled A/B on one large-session snapshot, changing only the word guidance:

| guidance | summary | words | wall | hit |
|---|---:|---:|---:|---:|
| none | 30,561 chars | 3,598 | 239.8s | 99.17% |
| 1,500 words | **16,574 chars** | 1,816 | **165.6s** | 99.75% |

The summary was 46% smaller and wall time was 31% lower. This was one trial, and the
word count is guidance rather than a hard cap: the result exceeded the requested
budget. On a smaller session it did not reduce output (1,289 words without guidance,
1,345 with it).

### Caveats

TTFT improves when the prefix is retained, but total wall time can still be dominated
by decoding a richer summary. Cache reuse is also statistical under pressure: in an
earlier 202,000-token session series, one of four runs fell to 0.6% reuse after
unrelated work filled the cache, while the other three reached 99.8–100%. The prompt
occupied 26% of the measured pool at the time.

Four successive compactions were exercised, but summary-quality decay across those
generations was not scored.

## Reproduce the measurements

1. Use a large-context model behind a prefix-caching server and expose server-side
   prompt-token, cached-token, TTFT, cache-utilization, eviction, and preemption
   metrics.
2. Send a prompt cold, repeat it byte-for-byte, and confirm that the repeat is cached.
3. Insert representative competing requests, repeat the original prompt, and vary the
   server's retention setting. Record eviction pressure and preemptions as well as the
   small un-reused tail.
4. Save one Pi session snapshot. Compact it once with Pi's default and once with this
   extension, resetting or equivalently controlling cache state between arms.
5. Record prompt tokens, cached tokens, hit rate, TTFT, wall time, and summary size.
   Repeat enough times to expose eviction variance.
6. Confirm `fromExtension: true` and use `/compaction-cache-status` to capture the
   applicability rule and settings for the run.

Do not copy a retention value from these historical measurements. Choose it from the
pressure test on the deployment that will serve real traffic.
