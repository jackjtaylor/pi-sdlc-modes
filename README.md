# @jackjtaylor/pi-sdlc-modes

This package has modes to guide Pi through the stages of software development, from exploring a codebase to preparing a release.

## Install

```bash
pi install npm:@jackjtaylor/pi-sdlc-modes
```

You can update this package with `pi update --extensions`.

## Select Modes

- Press `Ctrl+Shift+M` to cycle through the modes (or configure another shortcut).
- Run `/sdlc` to choose a mode from the interactive picker.
- Run `/sdlc off` to disable the extension for this session, or `/sdlc on` to re-enable the extension. The extension is enabled for new sessions by default.

The modes guide Pi's responses and how it should work. They don't forbid tools, restrict context, or change what Pi has access to. The modes are also not extension or package-specific, so you can ask Pi to, for example, create plans using an extension, or by creating files.

When the extension is off, Pi won't be able to change modes, and it won't see any system prompt info or context about the extension. If you re-enable the extension, the tool will be available again for Pi to use, and it'll see context about the selected mode.

### Start Sessions in a Mode

You can set flags when starting Pi, for example, with a subagent.

```bash
pi -p --sdlc-mode build-and-test "Please read the plan and..."
pi -p --sdlc-off "Please answer my question..."
```

- `--sdlc-mode <id>` starts a new session in that mode.
- `--sdlc-off` starts a new session with the extension disabled.

The flags apply only to new sessions. If you resume a session, it'll keep its mode and enabled or disabled state.

## Configure

The defaults are in `DEFAULTS.json`.
To customise the modes or shortcut, create `~/.pi/agent/extensions/pi-sdlc-modes/config.json` and use the same schema as in `DEFAULTS.json`.
If you find a better prompt or a mode that would be useful, please let me know!

## Security

In this very early stage of development, I haven't reviewed or verified the code line-by-line, so keep that in mind when using this package.

## Stability

As this is a very early version, I'm actively developing and changing this, so it's possible in the future some of the tools or modes may change. If so, you should be able to ask Pi and it'll help update your workflows or configuration accordingly.
