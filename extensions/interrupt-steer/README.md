# pi-interrupt-steer

Interrupt a running Pi turn and send the editor text as one new user message.

## Install

```sh
pi install npm:pi-interrupt-steer
```

## External contract

The default shortcut is `ctrl+alt+enter`. While Pi is streaming, it aborts the
current operation and waits up to five seconds for Pi to become idle before
sending the editor text. Pi first restores queued steering messages, then
queued follow-up messages, and appends the text already in the editor. Each part
is separated by a blank line. The extension sends that combined text once and
clears the editor. If Pi does not become idle in time, the text stays in the
editor and the extension shows a warning.

When Pi is idle, the shortcut sends the editor text without aborting. If the
editor is empty and no messages are queued, it leaves the run alone and shows a
notification. If the call to `pi.sendUserMessage` throws synchronously, the
extension restores the text to the editor and shows a warning. Pi may report
send errors asynchronously; the extension cannot restore editor text for those
errors.

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

An invalid key uses `ctrl+alt+enter` and shows one warning. If the synchronous
call to `pi.sendUserMessage` throws, the combined text remains in the editor and
the extension shows a warning. Asynchronous send errors are handled by Pi and do
not trigger editor restoration by this extension.
