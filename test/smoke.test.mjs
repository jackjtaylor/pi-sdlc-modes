import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import sdlcModesExtension from "../index.ts";

test("registers SDLC commands and hooks, then records and prompts the selected mode", async () => {
  const temporaryAgentDir = await mkdtemp(join(tmpdir(), "pi-sdlc-modes-test-"));
  const configDirectory = join(temporaryAgentDir, "extensions", "pi-sdlc-modes");
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const config = {
    cycleShortcut: "ctrl+shift+m",
    initialMode: "discovery",
    modes: [
      {
        id: "discovery",
        name: "Discovery",
        description: "Fixture discovery description.",
        instructions: "Fixture discovery instructions.",
      },
      {
        id: "build",
        name: "Build",
        description: "Fixture build description.",
        instructions: "Fixture build instructions.",
      },
    ],
  };

  try {
    await mkdir(configDirectory, { recursive: true });
    await writeFile(join(configDirectory, "config.json"), JSON.stringify(config));
    process.env.PI_CODING_AGENT_DIR = temporaryAgentDir;

    const commands = new Map();
    const tools = new Map();
    const shortcuts = new Map();
    const hooks = new Map();
    const entryRenderers = new Map();
    const appendedEntries = [];
    const pi = {
      registerCommand: (name, options) => commands.set(name, options),
      registerTool: (tool) => tools.set(tool.name, tool),
      registerShortcut: (shortcut, options) => shortcuts.set(shortcut, options),
      registerEntryRenderer: (type, renderer) => entryRenderers.set(type, renderer),
      appendEntry: (type, data) => appendedEntries.push({ type, data }),
      on: (event, handler) => hooks.set(event, handler),
    };
    const notifications = [];
    const branchEntries = [];
    const context = {
      mode: "rpc",
      hasUI: false,
      ui: {
        notify: (...args) => notifications.push(args),
        setStatus: () => {},
        setWidget: () => {},
      },
      sessionManager: { getBranch: () => branchEntries },
    };

    sdlcModesExtension(pi);

    assert.ok(commands.has("sdlc"), "registers the /sdlc command");
    assert.ok(tools.has("sdlc_set_mode"), "registers the model-callable mode switch tool");
    assert.ok(shortcuts.has("ctrl+shift+m"), "registers the configured mode-cycle shortcut");
    assert.ok(entryRenderers.has("sdlc-mode-state"), "registers the mode-state renderer");
    assert.deepEqual(
      [...hooks.keys()].sort(),
      ["before_agent_start", "session_start", "session_tree"],
      "registers all SDLC lifecycle hooks",
    );

    await commands.get("sdlc").handler("build", context);

    assert.equal(appendedEntries.length, 1, "appends one state entry for the mode change");
    assert.equal(appendedEntries[0].type, "sdlc-mode-state");
    assert.deepEqual(
      {
        modeId: appendedEntries[0].data.modeId,
        modeName: appendedEntries[0].data.modeName,
        description: appendedEntries[0].data.description,
      },
      {
        modeId: "build",
        modeName: "Build",
        description: "Fixture build description.",
      },
    );
    assert.equal(typeof appendedEntries[0].data.changedAt, "number");

    const promptEvent = { systemPromptOptions: { sections: {} } };
    hooks.get("before_agent_start")(promptEvent);
    assert.equal(
      promptEvent.systemPromptOptions.sections.sdlc_mode,
      [
        "## Active SDLC Mode: Build",
        "Fixture build description.",
        "",
        "Fixture build instructions.",
        "",
        "## Changing SDLC Modes",
        "Use sdlc_set_mode only when the user explicitly requests a mode change or clearly authorizes moving to that phase.",
        "Do not switch merely because another mode seems useful. If the user's intent is unclear, ask and wait for confirmation.",
      ].join("\n"),
    );
    assert.deepEqual(notifications, []);

    const setModeTool = tools.get("sdlc_set_mode");
    assert.deepEqual(
      setModeTool.parameters.properties.mode.enum,
      ["discovery", "build"],
      "limits tool selections to configured modes",
    );
    await setModeTool.execute("tool-call-discovery", { mode: "discovery" }, undefined, undefined, context);
    await setModeTool.execute("tool-call-build", { mode: "build" }, undefined, undefined, context);

    assert.equal(appendedEntries.length, 3, "the tool persists each successful mode change");
    assert.equal(appendedEntries[2].type, "sdlc-mode-state");
    assert.deepEqual(
      {
        modeId: appendedEntries[2].data.modeId,
        modeName: appendedEntries[2].data.modeName,
        description: appendedEntries[2].data.description,
      },
      {
        modeId: "build",
        modeName: "Build",
        description: "Fixture build description.",
      },
    );

    const nextPromptEvent = { systemPromptOptions: { sections: {} } };
    hooks.get("before_agent_start")(nextPromptEvent);
    assert.equal(
      nextPromptEvent.systemPromptOptions.sections.sdlc_mode,
      [
        "## Active SDLC Mode: Build",
        "Fixture build description.",
        "",
        "Fixture build instructions.",
        "",
        "## Changing SDLC Modes",
        "Use sdlc_set_mode only when the user explicitly requests a mode change or clearly authorizes moving to that phase.",
        "Do not switch merely because another mode seems useful. If the user's intent is unclear, ask and wait for confirmation.",
      ].join("\n"),
      "the tool-selected mode updates the next prompt",
    );

    branchEntries.push({
      type: "custom",
      customType: "sdlc-mode-state",
      data: { modeId: "build", modeName: "Build", description: "Invalid saved state", changedAt: "yesterday" },
    });
    await hooks.get("session_start")({}, context);
    const restoredPromptEvent = { systemPromptOptions: { sections: {} } };
    hooks.get("before_agent_start")(restoredPromptEvent);
    assert.match(
      restoredPromptEvent.systemPromptOptions.sections.sdlc_mode,
      /^## Active SDLC Mode: Discovery\n/,
      "malformed saved entries do not restore an invalid mode",
    );

    const invalidEntryRenderer = entryRenderers.get("sdlc-mode-state")(
      { data: { modeId: "build", modeName: "Build", description: "Invalid", changedAt: "yesterday" } },
      {},
      { fg: (_color, text) => text },
    );
    assert.equal(invalidEntryRenderer.render(80)[0]?.trimEnd(), "SDLC mode changed");
  } finally {
    if (previousAgentDir === undefined) {
      delete process.env.PI_CODING_AGENT_DIR;
    } else {
      process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    }
    await rm(temporaryAgentDir, { recursive: true, force: true });
  }
});
