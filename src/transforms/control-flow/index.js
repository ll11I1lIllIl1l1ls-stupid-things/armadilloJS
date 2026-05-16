"use strict";

const { assertBytecodeArtifact, isVMModuleArtifact } = require("../../pipeline");
const { emitControlFlow } = require("./emitter");
const { planControlFlow } = require("./planner");

function createControlFlowTransform(options = {}) {
  if (options.enabled !== true) {
    return {
      run(module) { return module; },
    };
  }

  return {
    run(module, context) {
      assertBytecodeArtifact(module, "controlFlow input");
      if (!isVMModuleArtifact(module)) return module;
      const plan = planControlFlow(module, options, context);
      const transformed = emitControlFlow(module, plan, context);
      return transformed;
    },
  };
}

module.exports = { createControlFlowTransform };
