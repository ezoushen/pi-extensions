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
is separated by a blank line. Pi stores steering and follow-up messages in
separate queues, so their original cross-type typing order is not preserved. The
extension sends that combined text once, then treats a user `message_start` as
acceptance only when the message text exactly matches what it sent. For string
content it compares the string; for content parts it compares their text joined
together. Other user messages are ignored while it waits up to 60 seconds. It
clears the editor only if it still contains the submitted text. A prompt rewritten
by another extension can still be sent, but the original editor text stays and
the timeout warning appears. While waiting for Pi to become idle or start a
matching message, repeated shortcut presses show an info notice and do not abort
or send again. If Pi does not start a matching message within 60 seconds, the text
stays in the editor and the warning says to check the transcript before sending
it again; an input handler may have handled the prompt without starting a message.

When Pi is idle, the shortcut sends the editor text without aborting. With an
empty editor and no queued session messages, it leaves the run alone and shows a
notification. During compaction, the shortcut cannot see Pi's separate
compaction queue, so an empty-editor press with no session messages visible to
the shortcut does not interrupt Pi; Pi delivers its compaction queue after
compaction. For idle sends as well, the extension clears the editor only after a
matching user `message_start` and only if the editor still contains the submitted
text.

The terminal must send `ctrl+alt+enter` distinctly for this shortcut to fire.
A terminal without the kitty keyboard protocol may send the legacy `ESC CR`
sequence instead. Pi interprets that as `alt+enter`: the editor text is queued as
a follow-up, the current response finishes first, and the run is not interrupted.

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

An invalid key uses `ctrl+alt+enter` and shows one warning. If Pi does not emit
a matching user `message_start` within 60 seconds after the send, the text remains
in the editor and the extension warns you to check the transcript before sending
it again. If the editor changes while Pi is processing the message, the extension
leaves the current text there when it differs from the submitted text.
