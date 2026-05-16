"use strict";

const { Pipeline } = require("../pipeline");
const { createCfTrackerTransform } = require("./cftracker");
const { createControlFlowTransform } = require("./control-flow");
const { createCfgTransform } = require("./cfg");
const { createNumberProtectionTransform } = require("./number-protection");
const { createRemapTransform } = require("./remap");
const { createStringProtectionTransform } = require("./string-protection");

function createTransformPipeline(config = {}) {
  const pipeline = new Pipeline();
  const globalExempt = config.exempt || [];
  const cfgSeed = getCfgSeed(config);

  if (shouldEnableCfgPreprocessing(config)) {
    pipeline.register(createCfgTransform({
      injectRuntimeState: false,
      runtimeStateExempt: getRuntimeStateExempt(config, globalExempt),
      seed: cfgSeed,
    }));
  }
  if (config.stringProtection && config.stringProtection.enabled === true) {
    pipeline.register(createStringProtectionTransform({
      ...config.stringProtection,
      exempt: [...globalExempt, ...(config.stringProtection.exempt || [])],
    }));
  }
  if (config.numberProtection && config.numberProtection.enabled === true) {
    pipeline.register(createNumberProtectionTransform({
      ...config.numberProtection,
      exempt: [...globalExempt, ...(config.numberProtection.exempt || [])],
    }));
  }
  if (shouldEnableCfgMaterialization(config)) {
    pipeline.register(createCfgTransform({
      injectRuntimeState: true,
      runtimeStateExempt: getRuntimeStateExempt(config, globalExempt),
      seed: cfgSeed,
      force: true,
    }));
  }
  if (shouldEnableCfTrackerPreprocessing(config)) {
    pipeline.register(createCfTrackerTransform({
      enabled: true,
      seed: cfgSeed,
    }));
  }
  if (config.controlFlow && config.controlFlow.enabled === true) {
    pipeline.register(createControlFlowTransform({
      ...config.controlFlow,
      exempt: [...globalExempt, ...(config.controlFlow.exempt || [])],
    }));
  }
  if (config.remap && config.remap.enabled === true) {
    pipeline.register(createRemapTransform({
      ...config.remap,
      exempt: [...globalExempt, ...(config.remap.exempt || [])],
    }));
  }
  return pipeline;
}

function shouldEnableCfgPreprocessing(config) {
  return isEnabled(config.controlFlow)
    || isEnabled(config.stringProtection)
    || isEnabled(config.numberProtection);
}

function shouldEnableCfTrackerPreprocessing(config) {
  return isEnabled(config.controlFlow);
}

function isEnabled(transformConfig) {
  return !!transformConfig && transformConfig.enabled === true;
}

function shouldInjectCfgRuntimeState(config) {
  return isEnabled(config.controlFlow)
    || isEnabled(config.stringProtection)
    || isEnabled(config.numberProtection);
}

function shouldEnableCfgMaterialization(config) {
  return shouldInjectCfgRuntimeState(config);
}

function getCfgSeed(config) {
  if (isEnabled(config.controlFlow) && Number.isInteger(config.controlFlow?.seed)) return config.controlFlow.seed;
  if (isEnabled(config.stringProtection) && Number.isInteger(config.stringProtection?.seed)) return config.stringProtection.seed;
  if (isEnabled(config.numberProtection) && Number.isInteger(config.numberProtection?.seed)) return config.numberProtection.seed;
  return 0;
}

function getRuntimeStateExempt(config, globalExempt = []) {
  const enabledLocalExemptions = [config.controlFlow, config.stringProtection, config.numberProtection]
    .filter(isEnabled)
    .map((transformConfig) => transformConfig.exempt || []);
  if (enabledLocalExemptions.length === 0) return [...globalExempt];
  const sharedLocalExemptions = enabledLocalExemptions
    .slice(1)
    .reduce((shared, exemptions) => shared.filter((entry) => exemptions.includes(entry)), enabledLocalExemptions[0].slice());
  return [...globalExempt, ...sharedLocalExemptions];
}

module.exports = { createTransformPipeline };
