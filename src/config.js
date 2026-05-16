"use strict";

const fs = require("fs");
const path = require("path");

const REMAP_MODES = new Set(["keep", "strip", "remap"]);

function readConfig(configPath) {
  const resolved = path.resolve(configPath);
  const config = JSON.parse(fs.readFileSync(resolved, "utf8"));
  validateConfig(config, resolved);
  return normalizeConfig(config, path.dirname(resolved));
}

function validateConfig(config, configPath) {
  if (!config || typeof config !== "object") throw new Error(`Config must be an object: ${configPath}`);
  if (!Array.isArray(config.sources) || config.sources.length === 0) throw new Error("Config requires at least one sources entry");
  if (config.exempt !== undefined) validateMatchList(config.exempt, "exempt");
  const enabledBytecodeTransforms = Object.entries(config)
    .filter(([name, value]) => name !== "virtualize" && value && typeof value === "object" && value.enabled === true)
    .map(([name]) => name);
  if (!config.virtualize || config.virtualize.enabled !== true) {
    if (enabledBytecodeTransforms.length > 0) {
      throw new Error(`Bytecode-native transforms require virtualize.enabled = true before enabling: ${enabledBytecodeTransforms.join(", ")}`);
    }
    throw new Error("ArmadilloJS MVP requires virtualize.enabled = true");
  }
  if (config.controlFlow && typeof config.controlFlow === "object") {
    validateControlFlowConfig(config.controlFlow);
  }
  if (config.stringProtection && typeof config.stringProtection === "object") {
    validateStringProtectionConfig(config.stringProtection);
  }
  if (config.numberProtection && typeof config.numberProtection === "object") {
    validateNumberProtectionConfig(config.numberProtection);
  }
  if (config.remap && config.remap.enabled === true) {
    validateRemapConfig(config.remap);
  }
  for (const source of config.sources) {
    if (!source || typeof source.input !== "string" || typeof source.output !== "string") {
      throw new Error("Each sources entry requires string input and output");
    }
  }
}

function validateRemapConfig(remap) {
  for (const field of ["module", "methods", "fields"]) {
    if (!REMAP_MODES.has(remap[field])) {
      throw new Error(`remap.${field} must be one of: keep, strip, remap`);
    }
  }
  if (remap.patchObjectKeys) {
    throw new Error("Not implemented remap.patchObjectKeys");
  }
  if (remap.patchJSONstringify) {
    throw new Error("Not implemented remap.patchJSONstringify");
  }
}

function validateControlFlowConfig(controlFlow) {
  if (controlFlow.junkCodesPercent !== undefined) {
    const percent = controlFlow.junkCodesPercent;
    if (typeof percent !== "number" || !Number.isFinite(percent) || percent < 0) {
      throw new Error("controlFlow.junkCodesPercent must be a number between 0 and 1");
    }
  }
  if (controlFlow.seed !== undefined && !Number.isSafeInteger(controlFlow.seed)) {
    throw new Error("controlFlow.seed must be an integer");
  }
  if (controlFlow.exempt !== undefined) validateMatchList(controlFlow.exempt, "controlFlow.exempt");
}

function validateStringProtectionConfig(stringProtection) {
  if (stringProtection.seed !== undefined && !Number.isSafeInteger(stringProtection.seed)) {
    throw new Error("stringProtection.seed must be an integer");
  }
  if (stringProtection.exempt !== undefined) validateMatchList(stringProtection.exempt, "stringProtection.exempt");
}

function validateNumberProtectionConfig(numberProtection) {
  if (numberProtection.seed !== undefined && !Number.isSafeInteger(numberProtection.seed)) {
    throw new Error("numberProtection.seed must be an integer");
  }
  if (numberProtection.exempt !== undefined) validateMatchList(numberProtection.exempt, "numberProtection.exempt");
}

function validateMatchList(value, label) {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new Error(`${label} must be an array of path/function match strings`);
  }
}

function normalizeConfig(config, baseDir) {
  return {
    ...config,
    baseDir,
    sources: config.sources.map((source) => ({
      input: path.resolve(baseDir, source.input),
      output: path.resolve(baseDir, source.output),
    })),
  };
}

module.exports = { readConfig };
