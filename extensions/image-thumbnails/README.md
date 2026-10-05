# pi-image-thumbnails

Image thumbnails for [pi](https://pi.dev), end to end. Every way an image can
show up in the prompt editor — a pasted file path, a `[Image #1]` reference, a
markdown image, a `file://` URL — becomes a real image block on the message
that is sent, and a small aspect-fill thumbnail in the editor itself while you
type.

## Install

```sh
pi install npm:pi-image-thumbnails
```

## External contract

When you submit a prompt, each image token is replaced by an actual
`ImageContent` block attached to the user message (via pi's `input` event).
Path tokens are rewritten to a readable `[image: name.png]` anchor;
`[Image #N]` references stay verbatim and resolve against the images this
session has already seen — user messages and tool results, in order of
appearance. Files pi cannot send natively (bmp, avif, tiff) are converted to
PNG with pi's own transcoder first; pi then applies its normal resize
pipeline. Tokens that do not resolve (missing file, unknown `[Image #N]`) are
left untouched, so nothing silently disappears.

Recognized forms:

| written | becomes |
|---|---|
| `/abs/path/photo.png` | image block + `[image: photo.png]` |
| `~/shots/pic.jpg`, `./logo.webp`, `assets/x.gif` | same |
| `file:///abs/path/shot.bmp` | image block (converted to PNG) |
| `"path with spaces.png"` | image block |
| `![alt](img.png)`, `[x](img.png)` | image block |
| `[Image #1]`, `[image: 2]`, `[image #3]` | the Nth image seen this session |

In the editor, the prompt text is left exactly as you typed it. Each detected
image appears in an attachment strip above the prompt — a small aspect-fill
thumbnail with its filename beside it, like the attachment tiles in Claude
Desktop or Codex Desktop. Aspect fill means the image is cover-scaled and
center-cropped to the thumbnail box, not letterboxed. One attachment per
unique image; thumbnails are decoded asynchronously and cached by path, size,
and mtime. The decoration wraps whatever editor is active — if another
extension already replaces the editor, its instance is decorated instead of
being pushed aside. The editor is only replaced in pi's interactive (`tui`)
mode; RPC, JSON, and print modes keep the send-path behavior with no
rendering.

## Settings

Set `cols` and `rows` in `pi-image-thumbnails.json` in the Pi agent settings
directory, or in a trusted project's `.pi/`, or use the environment variables:

| setting | default | environment variable | purpose |
|---|---|---|---|
| `cols` | `10` | `PI_IMAGE_THUMBS_COLS` | Thumbnail width in terminal cells, clamped to 2–40. |
| `rows` | `4` | `PI_IMAGE_THUMBS_ROWS` | Thumbnail height in terminal cells, clamped to 1–12; each cell covers two pixel rows. |

## If the contract is unmet

A token is left as plain text — and no image is attached — when the file does
not exist, is unreadable, is larger than 30 MB, or has an unsupported
extension; pi then behaves exactly as it would without the extension. The
editor never modifies your text: the attachment strip is additive, so a very
long path that word-wraps simply shows its attachment once a copy of the
_token_ fits on one display line (the image is still attached correctly on
send). Large bracketed pastes (`[paste #1]`) that contain a path are expanded
by pi before the `input` event, so they attach correctly, but the strip cannot
see inside the marker. Thumbnails are half-block art, not the kitty or iTerm2
image protocol, so they render identically in every terminal. The strip adds
lines above the prompt, so mouse-click caret positioning inside the editor is
offset by the strip height while attachments are visible. The `[Image #N]`
registry covers the current session only and resets on session switch. If the
editor render hook ever throws, the strip is skipped for that frame and the
editor falls back to plain text.

## Notes and limits

- The `[Image #N]` registry covers user messages and tool results seen in the
  current session, oldest first, capped at 100 images.
- A bare filename such as `photo.png` (no slash) is treated as prose, not a
  path; use `./photo.png`.

## License

MIT
