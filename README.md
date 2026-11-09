# @jackjtaylor/pi-sdlc-modes

This packages has modes to guide Pi through the stages of software development, from exploring a codebase to preparing a release.

## Install

```bash
pi install npm:@jackjtaylor/pi-sdlc-modes
```

You can update this package with `pi update --extensions`.

```bash
pi remove npm:@jackjtaylor/pi-sdlc-modes
```

## Select Modes

- Press `Ctrl+Alt+M` to cycle through the modes (or create your own in a configuration file).
- Run `/sdlc` to pick a mode, or `/sdlc <mode>` to select one by name.
- Run `/sdlc next` to move to the next mode.

The selected mode appears above the editor in the terminal user interface. Your new sessions start in `Explore` by default. Pi remembers the mode you selected, even when you're resuming a session later.

The modes guide Pi's responses and how it should work. They don't forbid tools, restrict context, or change what Pi has access to. The modes are also not extension or package-specific, so you can ask Pi to, for example, create plans using an extension, or by creating files.

## Configure

The defaults are in `DEFAULTS.json`.
To customise the modes or shortcut, create `~/.pi/agent/extensions/pi-sdlc-modes/config.json` and use the same schema as in `DEFAULTS.json`.

## Security

In this very early stage of development, I haven't reviewed or verified the code line-by-line, so keep that in mind when using this package.
