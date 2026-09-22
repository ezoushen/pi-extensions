# pi-prefix-stabilizer

Keep Pi's provider request prefix byte-stable across turns, reloads, and resumes so
a server-side prefix cache can reuse it.

The extension normalizes install paths inside the system prompt, sorts tool-schema
lists by name, then fingerprints the normalized system text. It warns when that text
changes during a session because one early changed token invalidates every cached
block after it.

## External contract

The provider must offer content-addressed prefix caching whose cache key depends on
the rendered request prefix. This extension stabilizes bytes; it does not enable or
configure the server cache.

For path normalization, `packagePathSuffix` must identify the volatile suffix in the
rendered prompt. `stablePath` is the replacement shown to the model. If tools or the
model need that path to resolve on disk, create it yourself or opt into
`createSymlink`.

## If the contract is unmet

Without provider-side prefix caching, requests remain correct but receive no cache
benefit. If the configured package suffix is absent, no path is rewritten; tool
sorting and drift detection still run. A genuine normalized-prompt change emits a
warning for that change, while identical repeats do not re-warn.

A mention of the package suffix is only ever treated as a volatile install path -- and
so only ever rewritten to `stablePath` -- if it is absolute and actually exists on
disk. A relative mention or an absolute-looking one that does not exist is left alone:
it was never an install path, so rewriting it would change the text's meaning rather
than stabilise a fact.

Symlink creation is off by default. If explicitly enabled and the link cannot be
created, the failure is written to the configured log when logging is enabled and the
turn continues. It also never replaces an existing symlink with a bad one: if the
candidate install root does not exist on disk, whatever is already at `stablePath` is
left untouched.

In pi's print (`-p`) and json modes there is no UI to notify, so the drift warning that
would otherwise be silent there is written to stderr instead, once per process.

## Load order

Load `pi-prefix-stabilizer` before `pi-compaction-cache`.

The stabilizer must normalize the ordinary provider payload before the compaction
extension captures it as the live cache prefix.

```sh
pi install npm:pi-prefix-stabilizer
pi install npm:pi-compaction-cache
```

## Settings

The three JSON settings resolve from `pi-prefix-stabilizer.json` in the global Pi
config directory, then from a trusted project's Pi config directory, then from the
environment. Later sources win. Project settings are ignored when the project is
untrusted.

| JSON key | Default | Environment override | Meaning |
|---|---|---|---|
| `stablePath` | `$HOME/.pi/pi-home` | `PI_PREFIX_STABILIZER_STABLE_PATH` | Stable replacement for a volatile package install path. |
| `packagePathSuffix` | `node_modules/@earendil-works/pi-coding-agent` | `PI_PREFIX_STABILIZER_PACKAGE_PATH_SUFFIX` | Suffix used to find the absolute package root in prompt text. |
| `createSymlink` | `false` | `PI_PREFIX_STABILIZER_CREATE_SYMLINK=1` | Create or update `stablePath` to point at the discovered package root. |

Two environment-only controls preserve the original operational interface:

| Environment variable | Default | Meaning |
|---|---|---|
| `PI_PREFIX_STABILIZER` | enabled | Set to `0` to disable the extension. |
| `PI_PREFIX_STABILIZER_LOG` | unset | Append JSON records for rewrites, drift, and symlink operations. |

Default installation performs no filesystem writes.

## Measurements

Measured with a large-context model behind a prefix-caching server:

| request | prompt tokens | TTFT | cache hit |
|---|---:|---:|---:|
| cold prompt | about 132,000 | 145.33s | 0.00% |
| byte-identical repeat | about 132,000 | 0.54s | 99.95% |
| first four characters changed | about 132,000 | 144.68s | 0.00% |

The stable repeat was about 270 times faster to first token. In the incident that
motivated the package, an install-path change diverged near token 2,649 of a
118,031-token request; 97.8% of the prompt had to be prefilled again, producing an
observed 127.5–137.5s delay. At the measured 871-token/s prefill rate, the expected
delay was 132.5s.

## Reproduce the measurements

1. Capture one rendered provider payload and the server's prompt-token, cached-token,
   and TTFT metrics.
2. Send it cold, then repeat it byte-for-byte.
3. Change a few characters early in the system prompt and send it again.
4. Compare cached-token counts and TTFT across the three requests.
5. Enable this extension, repeat the experiment across a package reinstall or other
   install-path change, and confirm that the normalized payload remains identical.
6. Reorder tool discovery without changing the tools and confirm that normalization
   prevents a drift warning; then make a real system-prompt change and confirm one
   warning is shown.

Cache capacity and eviction policy remain server concerns; test them separately under
the deployment's real concurrency and request mix.
