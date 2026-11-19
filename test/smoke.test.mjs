import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import sdlcModesExtension from "../index.ts";

const TEST_CONFIG = {
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

async function withExtension(run) {
  const temporaryAgentDir = await mkdtemp(join(tmpdir(), "pi-sdlc-modes-test-"));
  const configDirectory = join(temporaryAgentDir, "extensions", "pi-sdlc-modes");
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;

  try {
    await mkdir(configDirectory, { recursive: true });
    await writeFile(join(configDirectory, "config.json"), JSON.stringify(TEST_CONFIG));
    process.env.PI_CODING_AGENT_DIR = temporaryAgentDir;

    const commands = new Map();
    const tools = new Map();
    const shortcuts = new Map();
    const hooks = new Map();
    const entryRenderers = new Map();
    const appendedEntries = [];
    const branchEntries = [];
    const notifications = [];
    const widgetUpdates = [];
    const statusUpdates = [];
    const pickerCalls = [];
    const activeTools = ["read", "bash", "edit", "write", "sdlc_set_mode"];
    const configuredTools = ["read", "bash", "edit", "write", "sdlc_set_mode"];
    const flagValues = {};
    const registeredFlags = new Map();
    let pickerSelection = "Build";

    const pi = {
      registerCommand: (name, options) => commands.set(name, options),
      registerTool: (tool) => tools.set(tool.name, tool),
      registerShortcut: (shortcut, options) => shortcuts.set(shortcut, options),
      registerEntryRenderer: (type, renderer) => entryRenderers.set(type, renderer),
      appendEntry: (type, data) => {
        const entry = { type: "custom", customType: type, data };
        appendedEntries.push(entry);
        branchEntries.push(entry);
      },
      on: (event, handler) => hooks.set(event, handler),
      registerFlag: (name, options) => registeredFlags.set(name, options),
      getFlag: (name) => flagValues[name] ?? registeredFlags.get(name)?.default,
      getActiveTools: () => [...activeTools],
      getAllTools: () => configuredTools.map((name) => ({ name })),
      setActiveTools: (names) => {
        activeTools.splice(0, activeTools.length, ...names);
      },
    };
    const context = {
      mode: "tui",
      hasUI: true,
      ui: {
        notify: (...args) => notifications.push(args),
        select: async (...args) => {
          pickerCalls.push(args);
          return pickerSelection;
        },
        setStatus: (...args) => statusUpdates.push(args),
        setWidget: (...args) => widgetUpdates.push(args),
      },
      sessionManager: { getBranch: () => branchEntries },
    };

    sdlcModesExtension(pi);
    await run({
      commands,
      tools,
      shortcuts,
      hooks,
      entryRenderers,
      appendedEntries,
      branchEntries,
      notifications,
      widgetUpdates,
      statusUpdates,
      pickerCalls,
      activeTools,
      configuredTools,
      flagValues,
      registeredFlags,
      setPickerSelection: (value) => {
        pickerSelection = value;
      },
      context,
    });
  } finally {
    if (previousAgentDir === undefined) {
      delete process.env.PI_CODING_AGENT_DIR;
    } else {
      process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    }
    await rm(temporaryAgentDir, { recursive: true, force: true });
  }
}

function createPromptEvent() {
  return { systemPromptOptions: { sections: {} } };
}

test("picker-only mode selection, shortcuts, and the session-scoped on/off toggle work", async () => {
  await withExtension(async (harness) => {
    const {
      commands,
      tools,
      shortcuts,
      hooks,
      entryRenderers,
      appendedEntries,
      branchEntries,
      notifications,
      widgetUpdates,
      statusUpdates,
      pickerCalls,
      activeTools,
      context,
    } = harness;
    const command = commands.get("sdlc");

    assert.ok(command, "registers the /sdlc command");
    assert.ok(tools.has("sdlc_set_mode"), "registers the model-callable mode switch tool");
    assert.ok(shortcuts.has("ctrl+shift+m"), "registers the default Ctrl+Shift+M shortcut");
    assert.ok(entryRenderers.has("sdlc-mode-state"), "registers the mode-state renderer");
    assert.ok(entryRenderers.has("sdlc-mode-enabled-state"), "registers the enabled-state renderer");
    assert.deepEqual(
      [...hooks.keys()].sort(),
      ["before_agent_start", "input", "session_start", "session_tree"],
      "registers all SDLC lifecycle hooks",
    );

    await hooks.get("session_start")({}, context);
    const initialPrompt = createPromptEvent();
    hooks.get("before_agent_start")(initialPrompt);
    assert.match(initialPrompt.systemPromptOptions.sections.sdlc_mode, /^## Active SDLC Mode: Discovery\n/);

    await command.handler("build", context);
    await command.handler("next", context);
    assert.equal(appendedEntries.length, 0, "typed mode names and next do not change modes");
    assert.equal(notifications.at(-1)[1], "error");
    assert.deepEqual(
      command.getArgumentCompletions("").map(({ value }) => value),
      ["on", "off"],
      "only on/off arguments are offered as completions",
    );

    await command.handler("", context);
    assert.deepEqual(pickerCalls[0], ["Choose an SDLC mode", ["Discovery", "Build"]]);
    assert.equal(appendedEntries[0].customType, "sdlc-mode-state");
    assert.equal(appendedEntries[0].data.modeId, "build");

    const buildPrompt = createPromptEvent();
    hooks.get("before_agent_start")(buildPrompt);
    assert.match(buildPrompt.systemPromptOptions.sections.sdlc_mode, /^## Active SDLC Mode: Build\n/);

    await shortcuts.get("ctrl+shift+m").handler(context);
    assert.equal(appendedEntries.at(-1).data.modeId, "discovery", "the shortcut advances to the next mode");

    await command.handler("off", context);
    assert.equal(appendedEntries.at(-1).customType, "sdlc-mode-enabled-state");
    assert.equal(appendedEntries.at(-1).data.enabled, false);
    assert.deepEqual(widgetUpdates.at(-1), ["sdlc-mode", undefined], "off clears the TUI widget");
    assert.deepEqual(statusUpdates.at(-1), ["sdlc-mode", undefined], "off clears the status indicator");

    const offPrompt = createPromptEvent();
    hooks.get("before_agent_start")(offPrompt);
    assert.equal("sdlc_mode" in offPrompt.systemPromptOptions.sections, false, "off omits SDLC prompt guidance");
    assert.equal(activeTools.includes("sdlc_set_mode"), false, "off deactivates the mode-switch tool");
    assert.deepEqual(activeTools, ["read", "bash", "edit", "write"], "off keeps other tools active");

    const entriesBeforeDisabledCycle = appendedEntries.length;
    await shortcuts.get("ctrl+shift+m").handler(context);
    assert.equal(appendedEntries.length, entriesBeforeDisabledCycle, "the cycle shortcut is a no-op while off");

    await command.handler("", context);
    assert.equal(appendedEntries.at(-1).customType, "sdlc-mode-state", "the picker remains usable while off");
    assert.equal(appendedEntries.at(-1).data.modeId, "build");
    const stillOffPrompt = createPromptEvent();
    hooks.get("before_agent_start")(stillOffPrompt);
    assert.equal("sdlc_mode" in stillOffPrompt.systemPromptOptions.sections, false);

    await hooks.get("session_start")({}, context);
    const resumedPrompt = createPromptEvent();
    hooks.get("before_agent_start")(resumedPrompt);
    assert.equal(
      "sdlc_mode" in resumedPrompt.systemPromptOptions.sections,
      false,
      "a resumed session restores off state",
    );

    await command.handler("on", context);
    assert.equal(appendedEntries.at(-1).data.enabled, true);
    assert.equal(activeTools.includes("sdlc_set_mode"), true, "on reactivates the mode-switch tool");
    const enabledPrompt = createPromptEvent();
    hooks.get("before_agent_start")(enabledPrompt);
    assert.match(enabledPrompt.systemPromptOptions.sections.sdlc_mode, /^## Active SDLC Mode: Build\n/);

    await command.handler("off", context);
    branchEntries.splice(0);
    await hooks.get("session_start")({}, context);
    assert.equal(activeTools.includes("sdlc_set_mode"), true, "a new session keeps SDLC tools on");
    const newSessionPrompt = createPromptEvent();
    hooks.get("before_agent_start")(newSessionPrompt);
    assert.match(newSessionPrompt.systemPromptOptions.sections.sdlc_mode, /^## Active SDLC Mode: Discovery\n/);
    assert.equal(appendedEntries.at(-1).customType, "sdlc-mode-enabled-state");
  });
});

test("invalid saved mode and enabled-state entries do not restore invalid state", async () => {
  await withExtension(async ({ hooks, branchEntries, context, activeTools }) => {
    branchEntries.push(
      {
        type: "custom",
        customType: "sdlc-mode-state",
        data: { modeId: "build", modeName: "Build", description: "Invalid saved state", changedAt: "yesterday" },
      },
      {
        type: "custom",
        customType: "sdlc-mode-enabled-state",
        data: { enabled: "no", changedAt: "yesterday" },
      },
    );
    await hooks.get("session_start")({}, context);
    const promptEvent = createPromptEvent();
    hooks.get("before_agent_start")(promptEvent);
    assert.match(promptEvent.systemPromptOptions.sections.sdlc_mode, /^## Active SDLC Mode: Discovery\n/);
    assert.equal(activeTools.includes("sdlc_set_mode"), true, "invalid enabled state falls back to on");
  });
});

test("session tree navigation restores the mode, enabled state, and mode-switch tool", async () => {
  await withExtension(async ({ hooks, branchEntries, context, activeTools }) => {
    branchEntries.push(
      {
        type: "custom",
        customType: "sdlc-mode-state",
        data: { modeId: "build", modeName: "Build", description: "Fixture build description.", changedAt: 1 },
      },
      { type: "custom", customType: "sdlc-mode-enabled-state", data: { enabled: false, changedAt: 2 } },
    );

    await hooks.get("session_tree")({}, context);
    const offPrompt = createPromptEvent();
    hooks.get("before_agent_start")(offPrompt);
    assert.equal("sdlc_mode" in offPrompt.systemPromptOptions.sections, false, "tree navigation restores off");
    assert.equal(activeTools.includes("sdlc_set_mode"), false, "tree navigation removes the mode-switch tool when off");

    branchEntries.push({
      type: "custom",
      customType: "sdlc-mode-enabled-state",
      data: { enabled: true, changedAt: 3 },
    });
    await hooks.get("session_tree")({}, context);
    const onPrompt = createPromptEvent();
    hooks.get("before_agent_start")(onPrompt);
    assert.match(onPrompt.systemPromptOptions.sections.sdlc_mode, /^## Active SDLC Mode: Build\n/);
    assert.equal(activeTools.includes("sdlc_set_mode"), true, "tree navigation restores the mode-switch tool when on");
  });
});

test("a mode-switch tool excluded from the session's tools stays excluded", async () => {
  await withExtension(async ({ commands, hooks, activeTools, configuredTools, notifications, context }) => {
    activeTools.splice(0, activeTools.length, "read", "grep");
    configuredTools.splice(configuredTools.indexOf("sdlc_set_mode"), 1);

    await hooks.get("session_start")({}, context);
    assert.deepEqual(activeTools, ["read", "grep"], "a fresh session does not add an excluded tool");

    const promptEvent = createPromptEvent();
    hooks.get("before_agent_start")(promptEvent);
    assert.match(promptEvent.systemPromptOptions.sections.sdlc_mode, /^## Active SDLC Mode: Discovery\n/);
    assert.equal(
      promptEvent.systemPromptOptions.sections.sdlc_mode.includes("## Changing SDLC Modes"),
      false,
      "guidance that refers to the excluded tool is omitted",
    );

    await commands.get("sdlc").handler("on", context);
    assert.deepEqual(activeTools, ["read", "grep"], "SDLC on does not re-add an excluded tool");
    assert.equal(notifications.at(-1)[1], "info", "SDLC was already on");
  });
});

test("a resumed session with an explicit tool exclusion does not restore the mode-switch tool", async () => {
  await withExtension(async ({ commands, hooks, activeTools, configuredTools, branchEntries, context }) => {
    branchEntries.push({
      type: "custom",
      customType: "sdlc-mode-enabled-state",
      data: { enabled: false, changedAt: 1 },
    });
    activeTools.splice(0, activeTools.length, "read", "grep");
    configuredTools.splice(configuredTools.indexOf("sdlc_set_mode"), 1);

    await hooks.get("session_start")({}, context);
    await commands.get("sdlc").handler("on", context);
    assert.deepEqual(activeTools, ["read", "grep"], "saved SDLC history does not override an explicit tool exclusion");
  });
});

test("a resumed session keeps the mode-switch tool available after SDLC was turned off", async () => {
  await withExtension(async ({ commands, hooks, activeTools, branchEntries, context }) => {
    branchEntries.push({
      type: "custom",
      customType: "sdlc-mode-enabled-state",
      data: { enabled: false, changedAt: 1 },
    });
    activeTools.splice(0, activeTools.length, "read", "grep");

    await hooks.get("session_start")({}, context);
    assert.deepEqual(activeTools, ["read", "grep"], "off keeps the tool removed");

    branchEntries.push({
      type: "custom",
      customType: "sdlc-mode-enabled-state",
      data: { enabled: true, changedAt: 2 },
    });
    await commands.get("sdlc").handler("on", context);
    assert.equal(activeTools.includes("sdlc_set_mode"), true, "a session with SDLC history is not treated as excluded");
  });
});

test("--sdlc-mode and --sdlc-off set the starting state of a new session and record it", async () => {
  await withExtension(async ({ hooks, flagValues, registeredFlags, appendedEntries, branchEntries, context }) => {
    assert.ok(registeredFlags.has("sdlc-mode"), "registers --sdlc-mode");
    assert.ok(registeredFlags.has("sdlc-off"), "registers --sdlc-off");

    flagValues["sdlc-mode"] = "build";
    flagValues["sdlc-off"] = true;
    await hooks.get("session_start")({}, context);

    assert.deepEqual(
      appendedEntries.map((entry) => entry.customType),
      ["sdlc-mode-state", "sdlc-mode-enabled-state"],
      "records the flag-selected mode and the off state",
    );
    assert.equal(appendedEntries[0].data.modeId, "build");
    assert.equal(appendedEntries[1].data.enabled, false);

    branchEntries.push(...appendedEntries);
    const promptEvent = createPromptEvent();
    hooks.get("before_agent_start")(promptEvent);
    assert.equal("sdlc_mode" in promptEvent.systemPromptOptions.sections, false, "--sdlc-off disables SDLC");
  });
});

test("an unknown --sdlc-mode blocks every prompt with a non-zero exit and records nothing", async () => {
  const previousExitCode = process.exitCode;
  try {
    await withExtension(async ({ hooks, flagValues, appendedEntries, notifications, context }) => {
      flagValues["sdlc-mode"] = "not-a-mode";
      flagValues["sdlc-off"] = true;
      await hooks.get("session_start")({}, context);
      assert.equal(appendedEntries.length, 0, "an unknown mode records nothing, and --sdlc-off is not applied");
      assert.match(
        notifications.at(-1)[0],
        /^Unknown SDLC mode "not-a-mode" for --sdlc-mode\. Available: discovery, build\.$/,
      );

      const result = hooks.get("input")({ text: "hello", source: "interactive" }, context);
      assert.deepEqual(result, { action: "handled" }, "the prompt is handled without calling the model");
      assert.equal(process.exitCode, 1, "the process exits non-zero");
    });
  } finally {
    process.exitCode = previousExitCode;
  }
});

test("a resumed session ignores the startup flags", async () => {
  await withExtension(async ({ hooks, flagValues, appendedEntries, branchEntries, context }) => {
    flagValues["sdlc-mode"] = "build";
    flagValues["sdlc-off"] = true;
    branchEntries.push({
      type: "custom",
      customType: "sdlc-mode-state",
      data: { modeId: "discovery", modeName: "Discovery", description: "Fixture discovery description.", changedAt: 1 },
    });
    await hooks.get("session_start")({}, context);
    assert.equal(appendedEntries.length, 0, "resumed sessions do not record flag values");
    assert.deepEqual(hooks.get("input")({ text: "hello", source: "interactive" }, context), { action: "continue" });
    const promptEvent = createPromptEvent();
    hooks.get("before_agent_start")(promptEvent);
    assert.match(promptEvent.systemPromptOptions.sections.sdlc_mode, /^## Active SDLC Mode: Discovery\n/);
  });
});

test("--sdlc-mode alone sets the mode and keeps SDLC on", async () => {
  await withExtension(async ({ hooks, flagValues, appendedEntries, activeTools, context }) => {
    flagValues["sdlc-mode"] = "build";
    await hooks.get("session_start")({}, context);
    assert.deepEqual(
      appendedEntries.map((entry) => entry.customType),
      ["sdlc-mode-state"],
    );
    assert.equal(activeTools.includes("sdlc_set_mode"), true, "SDLC stays on with its tool");
    const promptEvent = createPromptEvent();
    hooks.get("before_agent_start")(promptEvent);
    assert.match(promptEvent.systemPromptOptions.sections.sdlc_mode, /^## Active SDLC Mode: Build\n/);
  });
});
