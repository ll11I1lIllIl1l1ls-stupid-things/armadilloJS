"use strict";

const { OP, BINOP } = require("../../virtualize/opcodes");
const { BytecodeBuffer } = require("../../virtualize/compiler/context");
const { decodeFunctionLayout } = require("../../virtualize/asm/layout");
const { assertTableSize, computeNumericHash } = require("../shared/table-layout");
const { reserveHiddenCfidLocal } = require("./locals");
const { createEqualsConditionTransformer } = require("./equals-condition");

const I16_MAX = 0x7fff;
const MAX_SERIALIZED_FUNCTION_CODE_SIZE = 0xffff;
const CONTROL_FLOW_DYNAMIC_PATCHES = Symbol.for("armadillo.controlFlowDynamicPatches");
const equalsConditionTransformer = createEqualsConditionTransformer();

function emitControlFlow(module, plan, context = null) {
  const clone = cloneValue(module);
  const funcs = clone.funcs || clone.functions || [];
  const functionPlans = plan?.functions || [];
  const transformedFuncIndexes = new Set();

  for (const functionPlan of functionPlans) {
    const func = funcs[functionPlan.funcIdx];
    if (!func || functionPlan.skipped) continue;
    if (functionPlan.tableLayout?.tableSize > 0xffff) assertTableSize(functionPlan.tableLayout.tableSize);
    if (functionPlan.tableEntries.length === 0) continue;
    if ((functionPlan.candidates || []).length === 0 && (functionPlan.exceptionProxies || []).length === 0) continue;
    if (functionPlan.tableLayout && estimateEncodedFunctionSize(func.code || [], functionPlan) > MAX_SERIALIZED_FUNCTION_CODE_SIZE) continue;
    funcs[functionPlan.funcIdx] = emitFunction(clone, func, functionPlan, didParentGainHiddenLocal(funcs, functionPlans, functionPlan.funcIdx, context), context);
    transformedFuncIndexes.add(functionPlan.funcIdx);
  }

  for (let funcIdx = 0; funcIdx < funcs.length; funcIdx++) {
    if (transformedFuncIndexes.has(funcIdx)) continue;
    if (!didParentGainHiddenLocal(funcs, functionPlans, funcIdx, context)) continue;
    funcs[funcIdx] = shiftParentLocalUpvalues(funcs[funcIdx]);
  }

  return clone;
}

function emitFunction(module, func, functionPlan, parentGainedHiddenLocal, context) {
  const hasInjectedState = context?.flowState?.hasRuntimeState?.(functionPlan.funcIdx) === true;
  const shiftedFunc = hasInjectedState
    ? cloneValue(func)
    : reserveHiddenCfidLocal(func, { shiftLocalUpvalues: parentGainedHiddenLocal });
  const layout = decodeFunctionLayout(shiftedFunc.code || []);
  const candidateBySeqPc = new Map(functionPlan.candidates.map((candidate) => [candidate.seqPc, candidate]));
  const callSiteBySeqPc = new Map((functionPlan.callSites || []).map((callSite) => [callSite.seqPc, callSite]));
  const rewritten = cloneValue(shiftedFunc);
  const buffer = new BytecodeBuffer();
  const originalToNewPc = new Map();
  const originalBoundaryToNewPc = new Map();
  const originalEndBoundaryToNewPc = new Map();
  const exceptionProxyToNewPc = new Map();
  const staticPatches = [];
  const dynamicPatches = [];
  const suppressedSeqPcs = new Set();
  const blockByStartPc = new Map((functionPlan.blocks || []).map((block) => [block.startPc, block]));
  const entryPc = layout.instructions[0]?.seqPc;

  validateControlFlowPlan(functionPlan);
  if (!hasInjectedState) emitCfidInitialization(buffer, functionPlan.dispatcherPlan?.initialCfid ?? functionPlan.entryCfid, module);

  for (const candidate of functionPlan.candidates || []) {
    const instruction = layout.bySeqPc.get(candidate.seqPc);
    const match = instruction ? equalsConditionTransformer.match({ module, layout, branchInstruction: instruction }) : null;
    if (!match) continue;
    candidate.equalsConditionMatch = match;
    for (const seqPc of match.suppressedSeqPcs || []) suppressedSeqPcs.add(seqPc);
  }

  for (const instruction of layout.instructions) {
    if (suppressedSeqPcs.has(instruction.seqPc)) continue;
    if (instruction.seqPc !== entryPc) {
      const block = blockByStartPc.get(instruction.seqPc);
      if (block && Number.isInteger(block.cfid)) emitCfidSet(buffer, module, block.cfid);
    }
    originalEndBoundaryToNewPc.set(instruction.seqPc, buffer.position);
    originalToNewPc.set(instruction.seqPc, buffer.position);
    originalBoundaryToNewPc.set(instruction.seqPc, buffer.position);
    const candidate = candidateBySeqPc.get(instruction.seqPc);
    if (candidate) {
        emitDynamicBranch(buffer, instruction, candidate, dynamicPatches, module, functionPlan, layout);
    } else {
      copyInstruction(buffer, layout.code, instruction);
      collectStaticPatch(buffer, instruction, staticPatches);
      const callSite = callSiteBySeqPc.get(instruction.seqPc);
      if (callSite) emitCallCfidUpdate(buffer, module, callSite.targetCfid);
    }
    originalBoundaryToNewPc.set(instruction.endPc, buffer.position);
    originalEndBoundaryToNewPc.set(instruction.endPc, buffer.position);
  }
  emitExceptionProxies(buffer, functionPlan.exceptionProxies || [], dynamicPatches, exceptionProxyToNewPc, module, functionPlan);

  const code = buffer.toUint8Array();
  patchStaticBranches(code, originalToNewPc, staticPatches);
  collectDynamicOffsets(code, originalToNewPc, dynamicPatches);
  if (code.length > MAX_SERIALIZED_FUNCTION_CODE_SIZE) return cloneValue(func);
  rewritten.code = code;
  recordDynamicPatchMetadata(rewritten, dynamicPatches, originalToNewPc);
  delete rewritten.cf;
  delete rewritten[`control${"Flow"}`];
  delete rewritten[`control${"Flow"}Table`];
  rewritten.exTable = remapExceptionTable(rewritten.exTable || [], originalBoundaryToNewPc, originalEndBoundaryToNewPc, originalToNewPc, exceptionProxyToNewPc);
  rewritten.srcMap = remapSourceMap(rewritten.srcMap || [], originalBoundaryToNewPc);
  return rewritten;
}

function didParentGainHiddenLocal(funcs, functionPlans, funcIdx, context) {
  return funcs.some((func, parentIdx) => {
    if (parentIdx === funcIdx) return false;
    if (context?.flowState?.hasRuntimeState?.(parentIdx) === true) return false;
    const plan = functionPlans.find((candidate) => candidate.funcIdx === parentIdx);
    if (!doesPlanReserveHiddenLocal(plan)) return false;
    return decodeFunctionLayout(func.code || []).instructions.some((instruction) => instruction.op === OP.make_func && instruction.operands[0]?.value === funcIdx);
  });
}

function doesPlanReserveHiddenLocal(plan) {
  if (!plan || plan.skipped || plan.tableEntries.length === 0) return false;
  return (plan.candidates || []).length > 0 || (plan.exceptionProxies || []).length > 0;
}

function shiftParentLocalUpvalues(func) {
  const shifted = cloneValue(func);
  shifted.upvalues = (shifted.upvalues || []).map((upvalue) => {
    const out = cloneValue(upvalue);
    if (out && (out.fromLocal === true || out.scope === 0)) out.index = shiftLocalIndex(out.index);
    return out;
  });
  return shifted;
}

function shiftLocalIndex(index) {
  return Number.isInteger(index) && index >= 0 ? index + 1 : index;
}

function estimateEncodedFunctionSize(code, functionPlan) {
  const candidateCount = (functionPlan.candidates || []).length;
  const callSiteCount = (functionPlan.callSites || []).length;
  return code.length + 24 + (candidateCount * 28) + (callSiteCount * 28) + (functionPlan.tableLayout?.tableSize || 0);
}

function validateControlFlowPlan(functionPlan) {
  const tableLayout = functionPlan.tableLayout;
  if (!tableLayout) throw new Error("Missing control-flow dispatch table layout");
  assertTableSize(tableLayout.tableSize);
}

function emitDynamicBranch(buffer, instruction, candidate, dynamicPatches, module, functionPlan, layout) {
  const dispatcherPlan = ensureDispatcherPlan(functionPlan);
  const equalsConditionMatch = candidate.equalsConditionMatch || equalsConditionTransformer.match({ module, layout, branchInstruction: instruction });
  if (equalsConditionMatch) {
    equalsConditionTransformer.emit(buffer, module, emitI32Push, equalsConditionMatch, candidate.sourceCfid);
  }
  if (instruction.op === OP.jmp) {
    emitCfidSet(buffer, module, candidate.targetCfid);
  } else if (instruction.op === OP.jmp_if) {
    emitConditionalCfidTransition(buffer, module, instruction, candidate);
  }
  const encodedOffsetOperandPcs = emitDynamicOffsetDispatch(buffer, module, functionPlan, candidate, candidate.targetPc);
  const dynSeqPc = buffer.position;
  if (instruction.op === OP.jmp) {
    buffer.emitDynOp(OP.jmp, [0], { kind: "i16", value: 0 });
  } else if (instruction.op === OP.jmp_if) {
    buffer.emitDynOp(OP.jmp_if, [1], { kind: "u8", value: instruction.operands[0].value }, { kind: "i16", value: 0 });
  } else {
    throw new TypeError(`Unsupported dynamic branch opcode ${instruction.op}`);
  }

  dynamicPatches.push({ branchIndex: candidate.branchIndex, dynSeqPc, targetPc: candidate.targetPc, state: candidate.state, encodedOffsetOperandPcs, encodedSlots: dispatcherPlan?.encodedSlots || [] });
}

function emitExceptionProxies(buffer, proxies, dynamicPatches, exceptionProxyToNewPc, module, functionPlan) {
  const dispatcherPlan = ensureDispatcherPlan(functionPlan);
  for (const proxy of proxies) {
    exceptionProxyToNewPc.set(proxy.exTableIndex, buffer.position);
    emitCfidSet(buffer, module, proxy.targetCfid);
    const encodedOffsetOperandPcs = emitDynamicOffsetDispatch(buffer, module, functionPlan, proxy, proxy.handlerPc);
    const dynSeqPc = buffer.position;
    buffer.emitDynOp(OP.jmp, [0], { kind: "i16", value: 0 });
    dynamicPatches.push({ proxyIndex: proxy.proxyIndex, dynSeqPc, targetPc: proxy.handlerPc, state: proxy.state, encodedOffsetOperandPcs, encodedSlots: dispatcherPlan?.encodedSlots || [] });
  }
}

function emitDynamicOffsetDispatch(buffer, module, functionPlan, handler, targetPc) {
  const tableLayout = functionPlan.tableLayout;
  const dispatcherPlan = ensureDispatcherPlan(functionPlan);
  const slotEntries = selectDispatchSlotEntries(functionPlan, handler);
  const encodedOffsetOperandPatches = [];
  const slotIds = slotEntries.map((entry) => entry.slot);
  const defaultSlot = slotIds.length > 0 ? slotIds[0] : 0;

  emitCurrentDispatchKey(buffer, module, handler.state | 0);
  emitDispatchSlotComputation(buffer, module, tableLayout, dispatcherPlan);
  const matchOperandPcs = [];
  const dynJumpOperandPcs = [];

  for (const entry of slotEntries) {
    buffer.emitOp(OP.dup);
    emitI32Push(buffer, module, entry.slot | 0);
    emitBinop(buffer, BINOP["==="]);
    matchOperandPcs.push(emitForwardJmpIf(buffer, 0));
  }

  buffer.emitOp(OP.pop);
  encodedOffsetOperandPatches.push(emitDecodedOffsetForSlot(buffer, module, dispatcherPlan, defaultSlot));
  dynJumpOperandPcs.push(emitForwardJmp(buffer));

  const matchStartPcs = [];
  for (const entry of slotEntries) {
    matchStartPcs.push(buffer.position);
    buffer.emitOp(OP.pop);
    encodedOffsetOperandPatches.push(emitDecodedOffsetForSlot(buffer, module, dispatcherPlan, entry.slot));
    dynJumpOperandPcs.push(emitForwardJmp(buffer));
  }

  for (let index = 0; index < matchOperandPcs.length; index++) {
    patchRelativeI16(buffer, matchOperandPcs[index], matchStartPcs[index]);
  }

  const dynJumpPc = buffer.position;
  for (const operandPc of dynJumpOperandPcs) patchRelativeI16(buffer, operandPc, dynJumpPc);
  return encodedOffsetOperandPatches;
}

function ensureDispatcherPlan(functionPlan) {
  if (functionPlan.dispatcherPlan) return functionPlan.dispatcherPlan;
  const tableLayout = functionPlan.tableLayout;
  if (!tableLayout) return null;
  const encodedSlots = tableLayout.slots.map((slot, index) => {
    const mixKey = 0;
    const plannedOffset = slot?.handler && Number.isInteger(slot.handler.plannedDynamicOffset)
      ? slot.handler.plannedDynamicOffset | 0
      : 0;
    return {
      slot: index,
      kind: slot ? slot.handler.kind : "decoy",
      handler: slot ? slot.handler : null,
      mixKey,
      encodedOffset: plannedOffset,
    };
  });
  return {
    v: 1,
    initialCfid: functionPlan.entryCfid | 0,
    tableSize: tableLayout.tableSize,
    layoutSeed: tableLayout.seed >>> 0,
    keySeed: 0,
    encodedSlots,
  };
}

function selectDispatchSlotEntries(functionPlan, handler) {
  const relevantEntries = (functionPlan.tableEntries || []).filter((entry) => {
    if (handler.proxyIndex !== undefined) return entry.kind === "exception-proxy" && entry.proxyIndex === handler.proxyIndex;
    return entry.kind === "real" && entry.branchIndex === handler.branchIndex;
  });
  if (relevantEntries.length > 0) {
    return relevantEntries.map((entry) => ({ entry, slot: findSlotForEntry(functionPlan.tableLayout, entry) }));
  }
  const incomingCfids = Array.isArray(handler.incomingCfids) && handler.incomingCfids.length > 0
    ? handler.incomingCfids
    : [handler.sourceCfid ?? 0];
  return incomingCfids.map((cfid) => ({
    entry: { key: (cfid ^ handler.state) | 0 },
    slot: computeFallbackSlot(functionPlan.tableLayout, (cfid ^ handler.state) | 0),
  }));
}

function findSlotForEntry(tableLayout, entry) {
  const slot = tableLayout?.slots?.find((candidate) => candidate && dispatchEntriesMatch(candidate.handler, entry));
  if (!slot) throw new Error("Missing dispatch slot for handler entry");
  return slot.slot;
}

function dispatchEntriesMatch(left, right) {
  if (left === right) return true;
  if (!left || !right) return false;
  return left.kind === right.kind
    && left.key === right.key
    && left.branchIndex === right.branchIndex
    && left.proxyIndex === right.proxyIndex
    && left.sourceCfid === right.sourceCfid
    && left.state === right.state
    && left.targetPc === right.targetPc
    && left.plannedDynamicOffset === right.plannedDynamicOffset;
}

function computeFallbackSlot(tableLayout, key) {
  if (!tableLayout) throw new Error("Missing dispatch table layout");
  return computeNumericHash(key | 0, tableLayout.seed >>> 0) & (tableLayout.tableSize - 1);
}

function emitDispatchSlotComputation(buffer, module, tableLayout, dispatcherPlan) {
  if (!tableLayout || !dispatcherPlan) throw new Error("Missing dispatcher metadata for slot computation");
  emitI32Push(buffer, module, dispatcherPlan.layoutSeed | 0);
  emitBinop(buffer, BINOP["^"]);
  emitHashMix32(buffer, module);
  emitI32Push(buffer, module, tableLayout.tableSize - 1);
  emitBinop(buffer, BINOP["&"]);
}

function emitHashMix32(buffer, module) {
  buffer.emitOp(OP.dup);
  emitI32Push(buffer, module, 31);
  emitBinop(buffer, BINOP["*"]);
  buffer.emitOp(OP.swap);
  emitI32Push(buffer, module, 1);
  emitBinop(buffer, BINOP[">>>"]);
  emitBinop(buffer, BINOP["^"]);
}

function emitSlotPayloadPush(buffer, module, dispatcherPlan, slot) {
  const encodedSlot = dispatcherPlan?.encodedSlots?.[slot];
  if (!encodedSlot) throw new Error(`Missing encoded slot payload for slot ${slot}`);
  return emitI32Push(buffer, module, encodedSlot.encodedOffset | 0);
}

function emitSlotPayloadDecode(buffer, module, dispatcherPlan, slot) {
  const encodedSlot = dispatcherPlan?.encodedSlots?.[slot];
  if (!encodedSlot) throw new Error(`Missing encoded slot payload for slot ${slot}`);
  emitI32Push(buffer, module, encodedSlot.mixKey | 0);
  emitBinop(buffer, BINOP["^"]);
}

function emitDecodedOffsetForSlot(buffer, module, dispatcherPlan, slot) {
  const operandPc = emitSlotPayloadPush(buffer, module, dispatcherPlan, slot);
  emitSlotPayloadDecode(buffer, module, dispatcherPlan, slot);
  return { operandPc, slot };
}

function emitPatchableI16Push(buffer) {
  buffer.emitOp(OP.push_i);
  return buffer.emitI16(0);
}

function emitForwardJmp(buffer) {
  buffer.emitOp(OP.jmp);
  return buffer.emitI16(0);
}

function emitForwardJmpIf(buffer, cond) {
  buffer.emitOp(OP.jmp_if);
  buffer.emitU8(cond);
  return buffer.emitI16(0);
}

function patchRelativeI16(buffer, operandPc, targetPc) {
  buffer.patchI16(operandPc, assertI16(targetPc - (operandPc + 2), "emitted relative jump offset"));
}

function emitCurrentDispatchKey(buffer, module, state) {
  buffer.emitOp(OP.load);
  buffer.emitU8(0);
  buffer.emitU16(0);
  emitI32Push(buffer, module, state);
  emitBinop(buffer, BINOP["^"]);
}

function emitBinop(buffer, op) {
  buffer.emitOp(OP.binop);
  buffer.emitU8(op);
}

function emitCfidInitialization(buffer, initialCfid, module) {
  emitI32Push(buffer, module, initialCfid | 0);
  buffer.emitOp(OP.store);
  buffer.emitU8(0);
  buffer.emitU16(0);
  buffer.emitOp(OP.pop);
}

function emitCallCfidUpdate(buffer, module, targetCfid) {
  buffer.emitOp(OP.dup);
  emitI32Push(buffer, module, targetCfid | 0);
  buffer.emitOp(OP.store);
  buffer.emitU8(0);
  buffer.emitU16(0);
  buffer.emitOp(OP.pop);
  buffer.emitOp(OP.pop);
}

function emitConditionalCfidTransition(buffer, module, instruction, candidate) {
  buffer.emitOp(OP.dup);
  const takenLabelOperandPc = emitForwardJmpIf(buffer, instruction.operands[0].value);
  emitCfidSet(buffer, module, candidate.fallthroughCfid);
  const endLabelOperandPc = emitForwardJmp(buffer);
  const takenLabelPc = buffer.position;
  emitCfidSet(buffer, module, candidate.targetCfid);
  patchRelativeI16(buffer, takenLabelOperandPc, takenLabelPc);
  patchRelativeI16(buffer, endLabelOperandPc, buffer.position);
}

function emitCfidSet(buffer, module, cfid) {
  emitI32Push(buffer, module, cfid | 0);
  buffer.emitOp(OP.store);
  buffer.emitU8(0);
  buffer.emitU16(0);
  buffer.emitOp(OP.pop);
}

function emitI32Push(buffer, module, value) {
  if (value >= -0x8000 && value <= 0x7fff) {
    buffer.emitOp(OP.push_i);
    return buffer.emitI16(value);
  }
  buffer.emitOp(OP.push);
  return buffer.emitU16(addLiteral(module, value | 0));
}

function addLiteral(module, value) {
  const literals = module.constPool?.literals || module.constants || [];
  const index = literals.findIndex((literal) => Object.is(literal, value));
  if (index >= 0) return index;
  if (literals.length >= 0xffff) throw new RangeError("control-flow literal pool index out of u16 range");
  literals.push(value);
  if (module.constPool) module.constPool.literals = literals;
  module.constants = literals;
  return literals.length - 1;
}

function copyInstruction(buffer, code, instruction) {
  for (let pc = instruction.seqPc; pc < instruction.endPc; pc++) buffer.emitU8(code[pc]);
}

function collectStaticPatch(buffer, instruction, staticPatches) {
  if (instruction.op === OP.jmp) {
    const offset = instruction.operands[0];
    if (!offset.dynamic) {
      staticPatches.push({ op: instruction.op, targetPc: instruction.endPc + offset.value, operandPc: buffer.position - 2 });
    }
    return;
  }

  if (instruction.op === OP.jmp_if) {
    const offset = instruction.operands[1];
    if (!offset.dynamic) {
      staticPatches.push({ op: instruction.op, targetPc: instruction.endPc + offset.value, operandPc: buffer.position - 2 });
    }
    return;
  }

  if (instruction.op === OP.iter_op) {
    const kind = instruction.operands[0]?.value;
    const offset = instruction.operands[1];
    if ((kind === 1 || kind === 4) && offset && !offset.dynamic) {
      staticPatches.push({ op: instruction.op, targetPc: instruction.endPc + offset.value, operandPc: buffer.position - 2 });
    }
  }
}

function patchStaticBranches(code, originalToNewPc, staticPatches) {
  for (const patch of staticPatches) {
    const target = originalToNewPc.get(patch.targetPc);
    if (target === undefined) throw new Error(`Missing final target for original pc ${patch.targetPc}`);
    const base = patch.operandPc + 2;
    writeI16(code, patch.operandPc, assertI16(target - base, "static branch offset"));
  }
}

function collectDynamicOffsets(code, originalToNewPc, dynamicPatches) {
  const finalLayout = decodeFunctionLayout(code);
  for (const patch of dynamicPatches) {
    const instruction = finalLayout.bySeqPc.get(patch.dynSeqPc);
    if (!instruction) throw new Error(`Missing rewritten dynamic branch at pc ${patch.dynSeqPc}`);
    const target = originalToNewPc.get(patch.targetPc);
    if (target === undefined) throw new Error(`Missing final target for original pc ${patch.targetPc}`);
    const offset = assertI16(target - instruction.endPc, "dynamic branch offset");
    for (const encodedPatch of patch.encodedOffsetOperandPcs || []) {
      const encodedSlot = patch.encodedSlots?.[encodedPatch.slot];
      if (!encodedSlot) throw new Error(`Missing encoded slot metadata for slot ${encodedPatch.slot}`);
      writeI32Immediate(code, encodedPatch.operandPc, (offset ^ encodedSlot.mixKey) | 0);
    }
  }
}

function recordDynamicPatchMetadata(func, dynamicPatches, originalToNewPc) {
  if (!Array.isArray(dynamicPatches) || dynamicPatches.length === 0) return;
  const metadata = dynamicPatches.map((patch) => ({
    dynSeqPc: patch.dynSeqPc,
    targetPc: readMappedBoundary(originalToNewPc, patch.targetPc, "dynamic branch target"),
    encodedOffsetOperandPcs: (patch.encodedOffsetOperandPcs || []).map((encodedPatch) => ({
      operandPc: encodedPatch.operandPc,
      slot: encodedPatch.slot,
      mixKey: patch.encodedSlots?.[encodedPatch.slot]?.mixKey | 0,
    })),
  }));
  Object.defineProperty(func, CONTROL_FLOW_DYNAMIC_PATCHES, {
    value: metadata,
    writable: true,
    configurable: true,
  });
}

function remapExceptionTable(exTable, originalBoundaryToNewPc, originalEndBoundaryToNewPc, originalToNewPc, exceptionProxyToNewPc) {
  return exTable.map((entry, index) => {
    const start = readMappedBoundary(originalBoundaryToNewPc, entry.start, "exception start");
    const end = readMappedBoundary(originalEndBoundaryToNewPc, entry.end, "exception end");
    const handler = exceptionProxyToNewPc.has(index)
      ? exceptionProxyToNewPc.get(index)
      : readMappedBoundary(originalToNewPc, entry.handler, "exception handler");
    if (start >= end) throw new RangeError(`remapped exception range must be non-empty: ${entry.start}-${entry.end}`);
    return {
      ...entry,
      start,
      end,
      handler,
    };
  });
}

function remapSourceMap(srcMap, originalBoundaryToNewPc) {
  return srcMap.map((entry) => ({
    ...entry,
    pc: readMappedBoundary(originalBoundaryToNewPc, entry.pc, "source map pc"),
  }));
}

function readMappedBoundary(map, pc, label) {
  const mapped = map.get(pc);
  if (mapped === undefined) throw new Error(`Missing ${label} mapping for original pc ${pc}`);
  return mapped;
}

function writeI16(code, pc, value) {
  const encoded = value < 0 ? value + 0x10000 : value;
  code[pc] = encoded & 0xff;
  code[pc + 1] = (encoded >> 8) & 0xff;
}

function writeI32Immediate(code, pc, value) {
  writeI16(code, pc, value);
}

function assertI16(value, label) {
  if (!Number.isInteger(value) || value < -0x8000 || value > I16_MAX) throw new RangeError(`${label} out of range: ${value}`);
  return value;
}

function cloneValue(value) {
  if (value instanceof Uint8Array) return Uint8Array.from(value);
  if (value instanceof RegExp) return new RegExp(value.source, value.flags);
  if (Array.isArray(value)) return value.map(cloneValue);
  if (value && typeof value === "object") {
    const out = {};
    for (const [key, child] of Object.entries(value)) out[key] = cloneValue(child);
    return out;
  }
  return value;
}

module.exports = { emitControlFlow };
