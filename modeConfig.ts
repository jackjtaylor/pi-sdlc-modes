import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { Key, type KeyId } from "@earendil-works/pi-tui";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";

const EXTENSION_DIRECTORY = "pi-sdlc-modes";
const CONFIG_FILE = "config.json";

const MODIFIERS = new Set(["ctrl", "shift", "alt", "super"]);
const BASE_KEYS: Set<string> = new Set(Object.values(Key).filter((key) => typeof key === "string"));

function isKeyId(value: unknown): value is KeyId {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value) return false;
  if (value === "+") return true;

  const isPlusKey = value.endsWith("++");
  const keySeparator = value.lastIndexOf("+");
  const prefix = isPlusKey ? value.slice(0, -2) : keySeparator === -1 ? "" : value.slice(0, keySeparator);
  const key = isPlusKey ? "+" : keySeparator === -1 ? value : value.slice(keySeparator + 1);
  const modifiers = prefix.length === 0 ? [] : prefix.split("+");

  if (!BASE_KEYS.has(key) && !/^[a-z0-9]$/.test(key)) return false;
  if (modifiers.length > 4 || modifiers.some((modifier) => !MODIFIERS.has(modifier))) return false;
  return new Set(modifiers).size === modifiers.length;
}

const NonblankStringSchema = Type.Refine(Type.String(), (value) => value.trim().length > 0);
const ModeIdSchema = Type.Refine(Type.String(), (value) => /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value));
const CycleShortcutSchema = Type.Refine(Type.Unsafe<KeyId>(Type.String()), isKeyId);

export const ModeDefinitionSchema = Type.Object({
  id: ModeIdSchema,
  name: NonblankStringSchema,
  description: NonblankStringSchema,
  instructions: NonblankStringSchema,
});

const ModesSchema = Type.Array(ModeDefinitionSchema, { minItems: 1 });

export const ModeConfigSchema = Type.Refine(
  Type.Object({
    cycleShortcut: CycleShortcutSchema,
    initialMode: ModeIdSchema,
    modes: ModesSchema,
  }),
  (config) => {
    const ids = new Set(config.modes.map((mode) => mode.id));
    const names = new Set(config.modes.map((mode) => mode.name.trim().toLowerCase()));
    return ids.size === config.modes.length && names.size === config.modes.length && ids.has(config.initialMode);
  },
);

export const ModeStateEntrySchema = Type.Object({
  modeId: Type.String(),
  modeName: Type.String(),
  description: Type.String(),
  changedAt: Type.Number(),
});

export type ModeDefinition = Static<typeof ModeDefinitionSchema>;
export type SdlcConfig = Static<typeof ModeConfigSchema>;
export type ModeStateEntry = Static<typeof ModeStateEntrySchema>;

function cleanConfig(value: SdlcConfig): SdlcConfig {
  return {
    cycleShortcut: value.cycleShortcut,
    initialMode: value.initialMode,
    modes: value.modes.map((mode) => ({
      id: mode.id,
      name: mode.name.trim(),
      description: mode.description.trim(),
      instructions: mode.instructions.trim(),
    })),
  };
}

function readBundledConfig(): SdlcConfig {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(new URL("./DEFAULTS.json", import.meta.url), "utf8"));
  } catch (error) {
    throw new Error(`Could not read bundled DEFAULTS.json: ${String(error)}`);
  }

  if (!Value.Check(ModeConfigSchema, parsed)) {
    throw new Error("Invalid bundled DEFAULTS.json: it does not satisfy the SDLC configuration schema.");
  }
  return cleanConfig(parsed);
}

export const DEFAULT_CONFIG = readBundledConfig();

function isMissingFile(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

export function loadConfig(): SdlcConfig {
  const configPath = join(getAgentDir(), "extensions", EXTENSION_DIRECTORY, CONFIG_FILE);
  let contents: string;
  try {
    contents = readFileSync(configPath, "utf8");
  } catch (error) {
    if (!isMissingFile(error)) {
      console.warn(`[pi-sdlc-modes] Could not read ${configPath}; using bundled defaults. ${String(error)}`);
    }
    return DEFAULT_CONFIG;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch (error) {
    console.warn(`[pi-sdlc-modes] Invalid JSON in ${configPath}; using bundled defaults. ${String(error)}`);
    return DEFAULT_CONFIG;
  }

  if (!Value.Check(ModeConfigSchema, parsed)) {
    console.warn(`[pi-sdlc-modes] Invalid configuration in ${configPath}; using bundled defaults.`);
    return DEFAULT_CONFIG;
  }
  return cleanConfig(parsed);
}
