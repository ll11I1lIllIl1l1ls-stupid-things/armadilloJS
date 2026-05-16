"use strict";

const { createTransformContext } = require("./transforms/cfg");

function isVMModuleArtifact(value) {
  return !!value
    && typeof value === "object"
    && typeof value.entry === "number"
    && (Array.isArray(value.functions) || Array.isArray(value.funcs));
}

function isVMAsmArtifact(value) {
  return !!value
    && typeof value === "object"
    && value.kind === "vm-asm"
    && Array.isArray(value.instructions);
}

function assertBytecodeArtifact(value, stage) {
  if (isVMModuleArtifact(value) || isVMAsmArtifact(value)) return;
  throw new TypeError(`Pipeline ${stage} must be VM bytecode or bytecode ASM, never source JavaScript AST`);
}

class Pipeline {
  constructor() { this.transforms = []; }
  register(transform) { this.transforms.push(transform); }
  run(module) {
    assertBytecodeArtifact(module, "input");
    const context = createTransformContext();
    for (const transform of this.transforms) {
      module = transform.run(module, context);
      assertBytecodeArtifact(module, "output");
    }
    attachContext(module, context);
    return module;
  }
}

function attachContext(module, context) {
  if (!module || typeof module !== "object") return;
  Object.defineProperty(module, "context", {
    value: context,
    configurable: true,
    writable: true,
    enumerable: false,
  });
}

module.exports = { Pipeline, assertBytecodeArtifact, isVMAsmArtifact, isVMModuleArtifact };
