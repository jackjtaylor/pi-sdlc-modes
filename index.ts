import { Type } from "typebox";
import { Value } from "typebox/value";
import { type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { loadConfig, ModeStateEntrySchema, type ModeDefinition, type ModeStateEntry } from "./mode-config.ts";

const STATE_ENTRY_TYPE = "sdlc-mode-state";
const WIDGET_ID = "sdlc-mode";
const SYSTEM_PROMPT_SECTION = "sdlc_mode";

function normalizeModeSelector(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/&/g, " ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

export default function sdlcModesExtension(pi: ExtensionAPI): void {
  const config = loadConfig();
  let activeModeId = config.initialMode;

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

  const updateModeIndicator = (ctx: ExtensionContext): void => {
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
    const activeIndex = config.modes.findIndex((mode) => mode.id === activeModeId);
    const nextMode = config.modes[(activeIndex + 1 + config.modes.length) % config.modes.length] ?? firstConfiguredMode;
    setMode(nextMode.id, ctx);
  };

  const selectMode = async (args: string, ctx: ExtensionContext): Promise<void> => {
    const selector = args.trim();
    if (selector.length === 0) {
      if (!ctx.hasUI) {
        ctx.ui.notify(`Current mode: ${getActiveMode().name}. Use /sdlc next or /sdlc <mode>.`, "info");
        return;
      }
      const selectedName = await ctx.ui.select(
        "Choose an SDLC mode",
        config.modes.map((mode) => mode.name),
      );
      if (!selectedName) return;
      const selectedMode = config.modes.find((mode) => mode.name === selectedName);
      if (selectedMode) setMode(selectedMode.id, ctx);
      return;
    }

    if (selector.toLowerCase() === "next") {
      cycleMode(ctx);
      return;
    }

    const normalizedSelector = normalizeModeSelector(selector);
    const selectedMode = config.modes.find(
      (mode) => mode.id === normalizedSelector || normalizeModeSelector(mode.name) === normalizedSelector,
    );
    if (!selectedMode) {
      const availableModes = config.modes.map((mode) => mode.id).join(", ");
      ctx.ui.notify(`Unknown SDLC mode "${selector}". Available: ${availableModes}, next.`, "error");
      return;
    }
    setMode(selectedMode.id, ctx);
  };

  pi.registerEntryRenderer<ModeStateEntry>(STATE_ENTRY_TYPE, (entry, _options, theme) => {
    const data = Value.Check(ModeStateEntrySchema, entry.data) ? entry.data : undefined;
    if (!data) return new Text(theme.fg("dim", "SDLC mode changed"), 0, 0);
    return new Text(theme.fg("dim", `SDLC · ${data.modeName} — ${data.description}`), 0, 0);
  });

  pi.registerTool({
    name: "sdlc_set_mode",
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
    description: "Choose an SDLC mode, use /sdlc next, or select /sdlc <mode>",
    getArgumentCompletions: (prefix) => {
      const choices = [
        {
          value: "next",
          label: "next",
          description: "Advance to the next SDLC mode",
        },
        ...config.modes.map((mode) => ({
          value: mode.id,
          label: mode.name,
          description: mode.description,
        })),
      ];
      const matches = choices.filter((choice) => choice.value.startsWith(prefix.toLowerCase()));
      return matches.length > 0 ? matches : null;
    },
    handler: async (args, ctx) => selectMode(args, ctx),
  });

  pi.registerShortcut(config.cycleShortcut, {
    description: "Advance to the next SDLC mode",
    handler: async (ctx) => cycleMode(ctx),
  });

  pi.on("session_start", async (_event, ctx) => {
    restoreModeFromBranch(ctx);
    updateModeIndicator(ctx);
  });

  pi.on("session_tree", async (_event, ctx) => {
    restoreModeFromBranch(ctx);
    updateModeIndicator(ctx);
  });

  pi.on("before_agent_start", (event) => {
    const mode = getActiveMode();
    event.systemPromptOptions.sections[SYSTEM_PROMPT_SECTION] = [
      `## Active SDLC Mode: ${mode.name}`,
      mode.description,
      "",
      mode.instructions,
      "",
      "## Changing SDLC Modes",
      "Use sdlc_set_mode only when the user explicitly requests a mode change or clearly authorizes moving to that phase.",
      "Do not switch merely because another mode seems useful. If the user's intent is unclear, ask and wait for confirmation.",
    ].join("\n");
  });
}
