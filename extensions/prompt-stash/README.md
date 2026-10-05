# pi-prompt-stash

A Ctrl+S stash for pi's prompt editor, in the style of Claude Code's message
handling: set aside the text you are typing without losing it, and get it back
at exactly the moment you need it.

## Install

```sh
pi install npm:pi-prompt-stash
```

## External contract

Pressing the stash key with text in the editor stashes that text and clears the
editor. Pressing the key with an empty editor restores the oldest stashed
prompt to the editor; it is never sent on its own, only restored for you to
review and submit. The stash is a queue: stashing twice keeps both prompts, and
restores hand them back in the order they were written.

The moment you send a prompt, the extension restores the oldest stash into the
editor automatically -- the sent message becomes the active prompt, and the
stashed draft becomes the next one to review and submit. The restore fires on
each accepted `input` event, the moment pi dispatches the submitted text, so it
happens whether the run was idle or streaming (steering and queued messages
included). pi clears the editor before that event dispatches, so the restore
lands in an empty editor; if another extension has filled the editor by then,
the stash is kept and a notification says it is waiting.

A stashed prompt that you send verbatim anyway is dropped from the queue
(matched exactly against the submitted text), so the auto-restore can never
refill the editor with an already-submitted message.

Built-in slash commands are intercepted by pi's editor and never reach the
input event, so they cannot trigger the restore directly. The two config
selectors are covered through their own events: completing `/model` (or the
scoped-models picker) and `/thinking` restores the stash -- but only for an
explicit pick, so `ctrl+p` model cycling and session restores never surface a
stash, and a selection with text still in the editor is skipped silently.
Extension commands (including `/stash` itself) and prompt-template or skill
commands behave correctly on their own: extension commands never trigger a
restore, and templates and skills are sent as prompts, so they do.

The default key is `ctrl+s`, which is free in pi's main editor: pi only binds
`ctrl+s` inside pickers and selectors. `app.message.followUp` (`alt+enter`)
remains pi's own way to queue a message that is *sent* when the current run
ends; the stash only restores text into the editor, never sends.

Stashes live in memory for one pi process. A `session_start` clears the queue,
so stashes do not follow you into a resumed or new session. pi's editor API
exposes the text but not the cursor position, so a restored prompt lands with
the cursor at the end of the text. `/stash` restores like the key does, and
`/stash clear` discards every stashed prompt.

## Settings

Set `key` in `pi-prompt-stash.json` in the Pi agent settings directory, or use
`PI_PROMPT_STASH_KEY`:

| setting | default | environment variable | purpose |
|---|---|---|---|
| `key` | `ctrl+s` | `PI_PROMPT_STASH_KEY` | Shortcut with one or more modifiers and a letter, digit, or named key. |

For example:

```json
{
  "key": "ctrl+shift+s"
}
```

Valid modifiers are `ctrl`, `alt`, `shift`, and `super`. Valid named keys are
`enter`, `escape`, `tab`, `space`, `backspace`, `delete`, `up`, `down`, `left`,
`right`, `home`, and `end`.

## If the contract is unmet

An invalid key uses `ctrl+s` and shows one warning. A restore with a non-empty
editor keeps the stash and says so instead of overwriting your text. Whitespace
only editor text counts as empty. Pressing the key with an empty editor and an
empty queue says so and changes nothing. One-shot built-in commands that do not
end in a selection -- `/new`, `/export`, `/compact`, and their kin -- do not
surface the stash; restore it with the key or `/stash` when you want it.
Nothing is restored after a send if Pi's editor was not available to the
extension; the stash survives and a later restore still works.
