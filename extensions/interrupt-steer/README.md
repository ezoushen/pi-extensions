# pi-interrupt-steer

Interrupt a running Pi turn and send the editor text as one new user message.

## Install

```sh
pi install npm:pi-interrupt-steer
```

## External contract

The default shortcut is `ctrl+alt+enter`. While Pi is streaming, it aborts the
current operation, waits until Pi is idle, then sends the editor text. Pi first
restores queued steering messages, then queued follow-up messages, and appends
the text already in the editor. Each part is separated by a blank line. The
extension sends that combined text once and clears the editor.

When Pi is idle, the shortcut sends the editor text without aborting. If the
editor is empty and no messages are queued, it leaves the run alone and shows a
notification. If sending throws, it restores the text to the editor and shows a
warning.

The terminal must distinguish `ctrl+alt+enter` for this shortcut to fire. A
terminal without the kitty keyboard protocol may report it as `alt+enter`, which
Pi uses to queue a follow-up message.

## Settings

Set `key` in `pi-interrupt-steer.json` in the Pi agent settings directory, or use
`PI_INTERRUPT_STEER_KEY`:

| setting | default | environment variable | purpose |
|---|---|---|---|
| `key` | `ctrl+alt+enter` | `PI_INTERRUPT_STEER_KEY` | Shortcut with one or more modifiers and a letter, digit, or named key. |

For example:

```json
{
  "key": "ctrl+shift+x"
}
```

Valid modifiers are `ctrl`, `alt`, `shift`, and `super`. Valid named keys are
`enter`, `escape`, `tab`, `space`, `backspace`, `delete`, `up`, `down`, `left`,
`right`, `home`, and `end`.

## If the contract is unmet

An invalid key uses `ctrl+alt+enter` and shows one warning. If sending fails, the
combined text remains in the editor and the extension shows a warning.
