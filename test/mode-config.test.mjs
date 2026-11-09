import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Value } from "typebox/value";
import { DEFAULT_CONFIG, loadConfig, ModeConfigSchema } from "../mode-config.ts";

const VALID_CONFIG = {
  cycleShortcut: "ctrl+shift+m",
  initialMode: "discovery",
  modes: [
    {
      id: "discovery",
      name: "Discovery",
      description: "Explore the area.",
      instructions: "Explain what is present.",
    },
    {
      id: "build",
      name: "Build",
      description: "Implement the change.",
      instructions: "Make and verify the change.",
    },
  ],
};

async function withUserConfig(configContents, run) {
  const temporaryAgentDir = await mkdtemp(join(tmpdir(), "pi-sdlc-config-test-"));
  const configDirectory = join(temporaryAgentDir, "extensions", "pi-sdlc-modes");
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;

  try {
    await mkdir(configDirectory, { recursive: true });
    if (configContents === "__unreadable__") {
      await mkdir(join(configDirectory, "config.json"));
    } else if (configContents !== undefined) {
      await writeFile(join(configDirectory, "config.json"), configContents);
    }
    process.env.PI_CODING_AGENT_DIR = temporaryAgentDir;
    return await run();
  } finally {
    if (previousAgentDir === undefined) {
      delete process.env.PI_CODING_AGENT_DIR;
    } else {
      process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    }
    await rm(temporaryAgentDir, { recursive: true, force: true });
  }
}

test("bundled defaults and Pi KeyId forms satisfy the TypeBox config schema", () => {
  assert.equal(Value.Check(ModeConfigSchema, DEFAULT_CONFIG), true);
  for (const cycleShortcut of ["ctrl+alt+m", "escape", "super+f12", "+", "ctrl++", "ctrl+alt+shift+super+?"]) {
    assert.equal(Value.Check(ModeConfigSchema, { ...VALID_CONFIG, cycleShortcut }), true, cycleShortcut);
  }
});

test("loads valid user configuration and ignores unknown fields", async () => {
  const config = structuredClone(VALID_CONFIG);
  config.extraTopLevel = "ignored";
  config.modes[0].extraModeField = { also: "ignored" };
  config.modes[0].name = "  Discovery  ";

  const loaded = await withUserConfig(JSON.stringify(config), () => loadConfig());

  assert.deepEqual(loaded, {
    ...VALID_CONFIG,
    modes: [{ ...VALID_CONFIG.modes[0] }, { ...VALID_CONFIG.modes[1] }],
  });
});

test("requires all known top-level and mode fields", async () => {
  const invalidConfigurations = [];
  for (const field of ["cycleShortcut", "initialMode", "modes"]) {
    const config = structuredClone(VALID_CONFIG);
    delete config[field];
    invalidConfigurations.push(config);
  }
  for (const field of ["id", "name", "description", "instructions"]) {
    const config = structuredClone(VALID_CONFIG);
    delete config.modes[0][field];
    invalidConfigurations.push(config);
  }

  for (const config of invalidConfigurations) {
    const loaded = await withUserConfig(JSON.stringify(config), () => loadConfig());
    assert.deepEqual(loaded, DEFAULT_CONFIG);
  }
});

test("malformed JSON and unreadable files fall back to the entire bundled default configuration", async () => {
  const malformed = await withUserConfig("{ not valid JSON", () => loadConfig());
  const unreadable = await withUserConfig("__unreadable__", () => loadConfig());
  assert.deepEqual(malformed, DEFAULT_CONFIG);
  assert.deepEqual(unreadable, DEFAULT_CONFIG);
});

test("invalid shortcuts and mode definitions fall back to bundled defaults", async () => {
  const invalidConfigurations = [];
  for (const cycleShortcut of ["", "ctrl+ctrl+x", "ctrl+unknown", " ctrl+x", "ctrl+"]) {
    invalidConfigurations.push({ ...structuredClone(VALID_CONFIG), cycleShortcut });
  }

  const emptyModes = structuredClone(VALID_CONFIG);
  emptyModes.modes = [];
  invalidConfigurations.push(emptyModes);

  const invalidMode = structuredClone(VALID_CONFIG);
  invalidMode.modes[0].id = "Not a valid ID";
  invalidConfigurations.push(invalidMode);

  const blankModeText = structuredClone(VALID_CONFIG);
  blankModeText.modes[0].instructions = "  \n ";
  invalidConfigurations.push(blankModeText);

  for (const config of invalidConfigurations) {
    const loaded = await withUserConfig(JSON.stringify(config), () => loadConfig());
    assert.deepEqual(loaded, DEFAULT_CONFIG);
  }
});

test("rejects duplicate IDs and case-insensitive duplicate names", async () => {
  const duplicateId = structuredClone(VALID_CONFIG);
  duplicateId.modes[1].id = duplicateId.modes[0].id;

  const duplicateName = structuredClone(VALID_CONFIG);
  duplicateName.modes[1].name = " discovery ";

  for (const config of [duplicateId, duplicateName]) {
    const loaded = await withUserConfig(JSON.stringify(config), () => loadConfig());
    assert.deepEqual(loaded, DEFAULT_CONFIG);
  }
});

test("rejects an initial mode that is not configured", async () => {
  const config = { ...structuredClone(VALID_CONFIG), initialMode: "review" };
  const loaded = await withUserConfig(JSON.stringify(config), () => loadConfig());
  assert.deepEqual(loaded, DEFAULT_CONFIG);
});

test("uses complete bundled defaults when the user config is missing", async () => {
  const loaded = await withUserConfig(undefined, () => loadConfig());
  assert.deepEqual(loaded, DEFAULT_CONFIG);
});
