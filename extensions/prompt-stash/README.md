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
editor. Pressing the key with an empty editor restores the most recently
stashed prompt to the editor; it is never sent on its own, only restored for
you to review and submit. The stash is a stack: each stash press pushes, each
restore press pops the most recent entry. Stashing twice keeps both prompts.

When you send your next prompt, the extension restores the most recent stash
into the editor automatically -- that send becomes the active prompt, and the
stashed draft becomes the next one to review and submit. The restore happens
on each accepted user message, so it also fires for steering and queued
messages sent mid-run. If the editor holds unrelated new text at that moment,
the stash is kept and a notification says it is waiting. If the editor still
shows the text that was just submitted (pi has not cleared it yet), that text
is cleared first, then the stash pops.

A stashed prompt that you send verbatim anyway is dropped from the stack
(matched exactly against the text of each user `message_start`, string content
or text parts joined), so the auto-restore can never refill the editor with an
already-submitted message.

The default key is `ctrl+s`, which is free in pi's main editor: pi only binds
`ctrl+s` inside pickers and selectors. `app.message.followUp` (`alt+enter`)
remains pi's own way to queue a message that is *sent* when the current run
ends; the stash only restores text into the editor, never sends.

Stashes live in memory for one pi process. A `session_start` clears the stack,
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
empty stack says so and changes nothing. Nothing is restored after a send if
Pi's editor was not available to the extension; the stash survives and a later
restore still works.
