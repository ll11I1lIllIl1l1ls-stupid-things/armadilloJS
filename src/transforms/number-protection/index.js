"use strict";

const { isVMModuleArtifact } = require("../../pipeline");
const { OP } = require("../../virtualize/opcodes");
const { BytecodeBuffer } = require("../../virtualize/compiler/context");
const { decodeFunctionLayout } = require("../../virtualize/asm/layout");

const RESERVED_CONST_SLOTS = 4;
const MIN_INLINE_I16 = -0x8000;
const MAX_INLINE_I16 = 0x7fff;

function createNumberProtectionTransform(options = {}) {
  if (options.enabled !== true) {
    return {
      name: "number-protection",
      run(module) {
        return module;
      },
    };
  }

  return {
    name: "number-protection",
    run(module) {
      if (!isVMModuleArtifact(module)) return module;
      const literals = ensureLiteralArray(module);
      const plans = planNumberProtection(module, literals, options.seed ?? 0);
      applyNumberProtectionPlans(module, plans);
      return module;
    },
  };
}

function ensureLiteralArray(module) {
  const literals = module.constPool?.literals || module.constants;
  if (!Array.isArray(literals)) {
    throw new TypeError("number-protection requires a VM module constant pool");
  }
  if (!module.constPool) module.constPool = { literals };
  module.constPool.literals = literals;
  module.constants = literals;
  return literals;
}

function planNumberProtection(module, literals, seed) {
  const funcs = module.funcs || module.functions || [];
  const descriptorByOriginalConst = new Map();
  const plansByFunc = new Map();

  funcs.forEach((func, funcIdx) => {
    if (!func) return;
    const code = func.code || [];
    const layout = decodeFunctionLayout(code);
    const plan = [];

    for (const instruction of layout.instructions) {
      if (instruction.op !== OP.push) continue;
      const operand = instruction.operands[0];
      if (!operand || operand.dynamic || !Number.isInteger(operand.value)) continue;
      const constIndex = operand.value;
      if (constIndex < RESERVED_CONST_SLOTS) continue;
      const numberValue = literals[constIndex];
      if (!shouldProtectNumber(numberValue)) continue;

      let descriptorIndex = descriptorByOriginalConst.get(constIndex);
      if (descriptorIndex === undefined) {
        descriptorIndex = literals.length;
        literals.push(protectNumberToDescriptor(numberValue, {
          originalConstIndex: constIndex,
          descriptorIndex,
          seed,
        }));
        descriptorByOriginalConst.set(constIndex, descriptorIndex);
      }
      plan.push({ seqPc: instruction.seqPc, descriptorIndex });
    }

    if (plan.length > 0) plansByFunc.set(funcIdx, plan);
  });

  for (const constIndex of descriptorByOriginalConst.keys()) {
    literals[constIndex] = undefined;
  }

  return plansByFunc;
}

function shouldProtectNumber(value) {
  return typeof value === "number"
    && Number.isFinite(value)
    && Number.isInteger(value)
    && (value < MIN_INLINE_I16 || value > MAX_INLINE_I16);
}

function protectNumberToDescriptor(value, state) {
  const key = deriveMask(state.seed, state.originalConstIndex, state.descriptorIndex);
  return {
    __vmProtectedNumber: true,
    version: 1,
    key,
    payload: value - key,
  };
}

function applyNumberProtectionPlans(module, plansByFunc) {
  const funcs = module.funcs || module.functions || [];
  for (const [funcIdx, plan] of plansByFunc) {
    const func = funcs[funcIdx];
    if (!func) continue;
    applyNumberProtectionPlan(func, plan);
  }
}

function applyNumberProtectionPlan(func, plan) {
  const code = func.code instanceof Uint8Array ? func.code : Uint8Array.from(func.code || []);
  const rewriteBySeqPc = new Map(plan.map((entry) => [entry.seqPc, entry]));
  const layout = decodeFunctionLayout(code);
  const buffer = new BytecodeBuffer();
  const pcMap = new Map();

  for (const instruction of layout.instructions) {
    pcMap.set(instruction.seqPc, buffer.position);
    const rewrite = rewriteBySeqPc.get(instruction.seqPc);
    if (rewrite) emitProtectedNumberRead(buffer, rewrite.descriptorIndex);
    else copyInstruction(buffer, instruction, code);
  }

  func.code = buffer.toUint8Array();
  func.exTable = remapExceptionTable(func.exTable || [], pcMap, layout, func.code.length);
  func.srcMap = remapSourceMap(func.srcMap || [], pcMap, layout, func.code.length);
}

function emitProtectedNumberRead(buffer, descriptorIndex) {
  buffer.emitOp(OP.push);
  buffer.emitU16(descriptorIndex);
}

function copyInstruction(buffer, instruction, code) {
  for (let pc = instruction.seqPc; pc < instruction.endPc; pc++) {
    buffer.emitU8(code[pc]);
  }
}

function remapExceptionTable(exTable, pcMap, layout, newCodeLength) {
  return exTable.map((entry) => ({
    ...entry,
    start: remapPc(entry.start, pcMap, layout, newCodeLength),
    end: remapPc(entry.end, pcMap, layout, newCodeLength),
    handler: remapPc(entry.handler, pcMap, layout, newCodeLength, { executableTarget: true }),
  }));
}

function remapSourceMap(srcMap, pcMap, layout, newCodeLength) {
  return srcMap.map((entry) => ({
    ...entry,
    pc: remapPc(entry.pc, pcMap, layout, newCodeLength),
  }));
}

function remapPc(pc, pcMap, layout, newCodeLength, options = {}) {
  if (pcMap.has(pc)) return pcMap.get(pc);
  if (pc === layout.code.length) return newCodeLength;
  for (let index = 0; index < layout.instructions.length; index++) {
    const instruction = layout.instructions[index];
    if (pc < instruction.seqPc || pc >= instruction.endPc) continue;
    const newStart = pcMap.get(instruction.seqPc);
    if (!Number.isInteger(newStart)) break;
    if (options.executableTarget === true) return newStart;
    const nextInstruction = layout.instructions[index + 1];
    const newEnd = nextInstruction ? pcMap.get(nextInstruction.seqPc) : newCodeLength;
    if (!Number.isInteger(newEnd) || newEnd <= newStart) return newStart;
    return newEnd - 1;
  }
  return pc;
}

function deriveMask(seed, originalConstIndex, descriptorIndex) {
  const mixed = mix32((seed >>> 0)
    ^ Math.imul((originalConstIndex + 1) >>> 0, 0x45d9f3b)
    ^ Math.imul((descriptorIndex + 1) >>> 0, 0x119de1f3));
  return (mixed & 0xffff) - 0x8000;
}

function mix32(value) {
  let state = value >>> 0;
  state ^= state >>> 16;
  state = Math.imul(state, 0x7feb352d) >>> 0;
  state ^= state >>> 15;
  state = Math.imul(state, 0x846ca68b) >>> 0;
  state ^= state >>> 16;
  return state >>> 0;
}

module.exports = {
  createNumberProtectionTransform,
};
