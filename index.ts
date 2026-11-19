import { Type } from "typebox";
import { Value } from "typebox/value";
import { type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { loadConfig, ModeStateEntrySchema, type ModeDefinition, type ModeStateEntry } from "./modeConfig.ts";

const STATE_ENTRY_TYPE = "sdlc-mode-state";
const ENABLED_STATE_ENTRY_TYPE = "sdlc-mode-enabled-state";
const WIDGET_ID = "sdlc-mode";
const SYSTEM_PROMPT_SECTION = "sdlc_mode";
const SET_MODE_TOOL_NAME = "sdlc_set_mode";
const EnabledStateEntrySchema = Type.Object({
  enabled: Type.Boolean(),
  changedAt: Type.Number(),
});
type EnabledStateEntry = { enabled: boolean; changedAt: number };

export default function sdlcModesExtension(pi: ExtensionAPI): void {
  const config = loadConfig();
  let activeModeId = config.initialMode;
  let sdlcEnabled = true;
  // The tool list from --tools is process-wide, so exclusion is decided once, on the first
  // session start, before SDLC has touched the tools. Later sessions reuse that decision.
  let modeToolExclusionChecked = false;
  let modeToolExcludedByUser = false;

  const firstConfiguredMode = config.modes[0];
  if (!firstConfiguredMode) throw new Error("SDLC configuration must contain at least one mode.");

  const getActiveMode = (): ModeDefinition =>
    config.modes.find((mode) => mode.id === activeModeId) ?? firstConfiguredMode;

  const restoreModeFromBranch = (ctx: ExtensionContext): void => {
    const entries = ctx.sessionManager.getBranch();
    for (let index = entries.length - 1; index >= 0; index--) {
      const entry = entries[index];
      if (!entry || entry.type !== "custom" || entry.customType !== STATE_ENTRY_TYPE) continue;
      const stateData: unknown = entry.data;
      if (!Value.Check(ModeStateEntrySchema, stateData)) continue;
      if (config.modes.some((mode) => mode.id === stateData.modeId)) {
        activeModeId = stateData.modeId;
        return;
      }
    }
    activeModeId = config.initialMode;
  };

  const restoreEnabledStateFromBranch = (ctx: ExtensionContext): void => {
    const entries = ctx.sessionManager.getBranch();
    for (let index = entries.length - 1; index >= 0; index--) {
      const entry = entries[index];
      if (!entry || entry.type !== "custom" || entry.customType !== ENABLED_STATE_ENTRY_TYPE) continue;
      const stateData: unknown = entry.data;
      if (!Value.Check(EnabledStateEntrySchema, stateData)) continue;
      sdlcEnabled = stateData.enabled;
      return;
    }
    sdlcEnabled = true;
  };

  const updateModeIndicator = (ctx: ExtensionContext): void => {
    if (!sdlcEnabled) {
      ctx.ui.setWidget(WIDGET_ID, undefined);
      ctx.ui.setStatus(WIDGET_ID, undefined);
      return;
    }
    const mode = getActiveMode();
    if (ctx.mode === "tui") {
      ctx.ui.setWidget(
        WIDGET_ID,
        (_tui, theme) =>
          new Text(
            `${theme.fg("accent", theme.bold(`SDLC · ${mode.name}`))} ${theme.fg("dim", `[${config.cycleShortcut}]`)}\n${theme.fg("muted", mode.description)}`,
            0,
            0,
          ),
      );
      ctx.ui.setStatus(WIDGET_ID, undefined);
      return;
    }
    if (ctx.hasUI) {
      ctx.ui.setStatus(WIDGET_ID, `SDLC · ${mode.name} — ${mode.description}`);
    }
  };

  const changeMode = (
    modeId: string,
    ctx: ExtensionContext,
  ): { kind: "changed" | "already-active" | "unknown"; message: string } => {
    const mode = config.modes.find((candidate) => candidate.id === modeId);
    if (!mode) return { kind: "unknown", message: `Unknown SDLC mode: ${modeId}` };
    if (activeModeId === mode.id) return { kind: "already-active", message: `Already in ${mode.name}.` };

    activeModeId = mode.id;
    pi.appendEntry<ModeStateEntry>(STATE_ENTRY_TYPE, {
      modeId: mode.id,
      modeName: mode.name,
      description: mode.description,
      changedAt: Date.now(),
    });
    updateModeIndicator(ctx);
    return { kind: "changed", message: `Switched to ${mode.name}.` };
  };

  const setMode = (modeId: string, ctx: ExtensionContext): void => {
    const result = changeMode(modeId, ctx);
    if (result.kind !== "changed") {
      ctx.ui.notify(result.message, result.kind === "unknown" ? "error" : "info");
    }
  };

  const cycleMode = (ctx: ExtensionContext): void => {
    if (!sdlcEnabled) return;
    const activeIndex = config.modes.findIndex((mode) => mode.id === activeModeId);
    const nextMode = config.modes[(activeIndex + 1 + config.modes.length) % config.modes.length] ?? firstConfiguredMode;
    setMode(nextMode.id, ctx);
  };

  const hasSdlcHistory = (ctx: ExtensionContext): boolean =>
    ctx.sessionManager
      .getBranch()
      .some(
        (entry) =>
          entry.type === "custom" &&
          (entry.customType === STATE_ENTRY_TYPE || entry.customType === ENABLED_STATE_ENTRY_TYPE),
      );

  const updateModeToolExclusion = (): void => {
    if (modeToolExclusionChecked) return;
    modeToolExclusionChecked = true;
    // Inactive is not the same as excluded: a resumed branch may have turned SDLC off.
    // getAllTools omits tools filtered out by --tools / --exclude-tools.
    modeToolExcludedByUser = !pi.getAllTools().some((tool) => tool.name === SET_MODE_TOOL_NAME);
  };

  // --sdlc-mode and --sdlc-off set the starting state of a new session only. Resumed or
  // branched sessions keep their saved state. The chosen values are recorded in the session.
  // A startup error (an unknown --sdlc-mode) is kept and blocks every prompt. Pi has no
  // startup abort, and ctx.shutdown() is a no-op in print mode, so input is refused instead.
  let startupError: string | undefined;

  const applyStartupFlags = (ctx: ExtensionContext): void => {
    startupError = undefined;
    if (hasSdlcHistory(ctx)) return;

    const requestedModeId = pi.getFlag("sdlc-mode");
    if (typeof requestedModeId === "string" && requestedModeId.length > 0) {
      const requestedMode = config.modes.find((mode) => mode.id === requestedModeId);
      if (!requestedMode) {
        const availableModes = config.modes.map((mode) => mode.id).join(", ");
        startupError = `Unknown SDLC mode "${requestedModeId}" for --sdlc-mode. Available: ${availableModes}.`;
        ctx.ui.notify(startupError, "error");
        return;
      }
      activeModeId = requestedMode.id;
      pi.appendEntry<ModeStateEntry>(STATE_ENTRY_TYPE, {
        modeId: requestedMode.id,
        modeName: requestedMode.name,
        description: requestedMode.description,
        changedAt: Date.now(),
      });
    }

    if (pi.getFlag("sdlc-off") === true) {
      sdlcEnabled = false;
      pi.appendEntry<EnabledStateEntry>(ENABLED_STATE_ENTRY_TYPE, { enabled: false, changedAt: Date.now() });
    }
  };

  // Pi only declares a tool's guidelines to the model while the tool is active, so
  // disabling SDLC also removes the mode-switch tool and its rules from the prompt.
  // A tool the user excluded stays excluded, even when SDLC is on.
  const syncModeToolActivation = (): void => {
    const otherActiveToolNames = pi.getActiveTools().filter((name) => name !== SET_MODE_TOOL_NAME);
    const includeModeTool = sdlcEnabled && !modeToolExcludedByUser;
    pi.setActiveTools(includeModeTool ? [...otherActiveToolNames, SET_MODE_TOOL_NAME] : otherActiveToolNames);
  };

  const setSdlcEnabled = (enabled: boolean, ctx: ExtensionContext): void => {
    if (sdlcEnabled === enabled) {
      ctx.ui.notify(`SDLC is already ${enabled ? "on" : "off"}.`, "info");
      return;
    }
    sdlcEnabled = enabled;
    syncModeToolActivation();
    pi.appendEntry<EnabledStateEntry>(ENABLED_STATE_ENTRY_TYPE, { enabled, changedAt: Date.now() });
    updateModeIndicator(ctx);
    if (enabled && modeToolExcludedByUser) {
      ctx.ui.notify(`SDLC turned on, but ${SET_MODE_TOOL_NAME} is excluded from the session's tools.`, "warning");
      return;
    }
    ctx.ui.notify(`SDLC turned ${enabled ? "on" : "off"}.`, "info");
  };

  const selectMode = async (args: string, ctx: ExtensionContext): Promise<void> => {
    const selector = args.trim().toLowerCase();
    if (selector === "on" || selector === "off") {
      setSdlcEnabled(selector === "on", ctx);
      return;
    }
    if (selector.length > 0) {
      ctx.ui.notify("Use /sdlc to choose a mode, or /sdlc on|off to enable or disable SDLC.", "error");
      return;
    }
    if (!ctx.hasUI) {
      ctx.ui.notify(`Current mode: ${getActiveMode().name}. The mode picker requires an interactive UI.`, "info");
      return;
    }
    const selectedName = await ctx.ui.select(
      "Choose an SDLC mode",
      config.modes.map((mode) => mode.name),
    );
    if (!selectedName) return;
    const selectedMode = config.modes.find((mode) => mode.name === selectedName);
    if (selectedMode) setMode(selectedMode.id, ctx);
  };

  pi.registerEntryRenderer<ModeStateEntry>(STATE_ENTRY_TYPE, (entry, _options, theme) => {
    const data = Value.Check(ModeStateEntrySchema, entry.data) ? entry.data : undefined;
    if (!data) return new Text(theme.fg("dim", "SDLC mode changed"), 0, 0);
    return new Text(theme.fg("dim", `SDLC · ${data.modeName} — ${data.description}`), 0, 0);
  });

  pi.registerEntryRenderer<EnabledStateEntry>(ENABLED_STATE_ENTRY_TYPE, (entry, _options, theme) => {
    const data = Value.Check(EnabledStateEntrySchema, entry.data) ? entry.data : undefined;
    if (!data) return new Text(theme.fg("dim", "SDLC availability changed"), 0, 0);
    return new Text(theme.fg("dim", `SDLC turned ${data.enabled ? "on" : "off"}`), 0, 0);
  });

  pi.registerTool({
    name: SET_MODE_TOOL_NAME,
    label: "Set SDLC Mode",
    description:
      "Change the active SDLC mode after the user explicitly requests or clearly authorizes that phase change. If the user's intent is unclear, ask and wait for confirmation instead of switching.",
    promptSnippet: "Change the active SDLC mode only with clear user authorization.",
    promptGuidelines: [
      "Only switch modes when the user explicitly requests the switch or clearly authorizes moving to that phase.",
      "A task request alone is not permission if it is unclear whether the user wants a mode change. Ask and wait for confirmation when uncertain.",
    ],
    parameters: Type.Object({
      mode: Type.String({
        description: "Configured SDLC mode ID to switch to.",
        enum: config.modes.map((mode) => mode.id),
      }),
    }),
    annotations: { readOnlyHint: false, idempotentHint: true },
    execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
      const result = changeMode(params.mode, ctx);
      return {
        content: [{ type: "text", text: result.message }],
        details: { modeId: params.mode, changed: result.kind === "changed" },
        isError: result.kind === "unknown",
      };
    },
  });

  pi.registerCommand("sdlc", {
    description: "Choose an SDLC mode or turn SDLC on or off",
    getArgumentCompletions: (prefix) => {
      const choices = [
        { value: "on", label: "on", description: "Enable SDLC for this session" },
        { value: "off", label: "off", description: "Disable SDLC for this session" },
      ];
      const matches = choices.filter((choice) => choice.value.startsWith(prefix.toLowerCase()));
      return matches.length > 0 ? matches : null;
    },
    handler: async (args, ctx) => selectMode(args, ctx),
  });

  pi.registerFlag("sdlc-mode", {
    description: "Start a new session in this SDLC mode ID",
    type: "string",
  });

  pi.registerFlag("sdlc-off", {
    description: "Start a new session with SDLC turned off",
    type: "boolean",
    default: false,
  });

  pi.registerShortcut(config.cycleShortcut, {
    description: "Advance to the next SDLC mode when SDLC is on",
    handler: async (ctx) => cycleMode(ctx),
  });

  pi.on("session_start", async (_event, ctx) => {
    restoreModeFromBranch(ctx);
    restoreEnabledStateFromBranch(ctx);
    updateModeToolExclusion();
    applyStartupFlags(ctx);
    syncModeToolActivation();
    updateModeIndicator(ctx);
  });

  pi.on("session_tree", async (_event, ctx) => {
    restoreModeFromBranch(ctx);
    restoreEnabledStateFromBranch(ctx);
    updateModeToolExclusion();
    syncModeToolActivation();
    updateModeIndicator(ctx);
  });

  pi.on("input", (_event, ctx) => {
    if (startupError === undefined) return { action: "continue" };
    ctx.ui.notify(startupError, "error");
    process.exitCode = 1;
    return { action: "handled" };
  });

  pi.on("before_agent_start", (event) => {
    if (!sdlcEnabled) {
      delete event.systemPromptOptions.sections[SYSTEM_PROMPT_SECTION];
      return;
    }
    const mode = getActiveMode();
    event.systemPromptOptions.sections[SYSTEM_PROMPT_SECTION] = [
      `## Active SDLC Mode: ${mode.name}`,
      mode.description,
      "",
      mode.instructions,
      "",
      ...(modeToolExcludedByUser
        ? []
        : [
            "## Changing SDLC Modes",
            "Use sdlc_set_mode only when the user explicitly requests a mode change or clearly authorizes moving to that phase.",
            "Do not switch merely because another mode seems useful. If the user's intent is unclear, ask and wait for confirmation.",
          ]),
    ].join("\n");
  });
}
