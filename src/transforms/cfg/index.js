"use strict";

const { OP } = require("../../virtualize/opcodes");
const { matchesExempt } = require("../shared/match");
const { BytecodeBuffer } = require("../../virtualize/compiler/context");
const { reserveHiddenCfidLocal } = require("../control-flow/locals");
const { analyzeModuleFlowGraph } = require("./cfg");
const { createCfTrackerContext } = require("../cftracker");
const { buildBlockPlan } = require("../cftracker/plan");
const LOGICAL_CFID_SITES = Symbol.for("armadillo.logicalCfidSites");
const MATERIALIZED_LOGICAL_CFIDS = Symbol.for("armadillo.materializedLogicalCfids");

class FunctionFlowContext {
  constructor(cfg, functionId) {
    this.cfg = cfg;
    this.functionId = functionId;
  }

  getCurrentFlowPredicate(pc) {
    return this.cfg.getCurrentFlowPredicate(this.functionId, pc);
  }
}

class CfgContext {
  constructor(flowState) {
    this.metadata = null;
    this.flowState = flowState;
  }

  hasMetadata() {
    return this.metadata !== null;
  }

  preprocessModule(module, options = {}) {
    if (!isVMModuleArtifact(module)) {
      this.metadata = null;
      return null;
    }
    if (options.force !== true && this.metadata && this.metadata.module === module) return this.metadata;
    const seed = options.seed ?? 0;

    const previousMetadata = this.metadata;
    if (options.injectRuntimeState === true) {
      injectSharedRuntimeRecordersWithExemptions(module, this.flowState, options.runtimeStateExempt || [], seed, previousMetadata);
    }

    const moduleGraph = analyzeModuleFlowGraph(module);
    const funcs = module.funcs || module.functions || [];
    const functions = moduleGraph.functions.map((functionGraph) => {
      const materializedCfids = funcs[functionGraph.functionId]?.[MATERIALIZED_LOGICAL_CFIDS] || [];
      return createFunctionMetadata(functionGraph, this.flowState, seed, {
        preassignedCfids: createPreassignedCfidsByStart(functionGraph.blocks || [], materializedCfids),
      });
    });
    const functionsById = new Map(functions.map((entry) => [entry.functionId, entry]));
    this.metadata = {
      module,
      moduleGraph,
      functions,
      functionsById,
    };
    return this.metadata;
  }

  getFunctionFlowContext(functionId) {
    const functionMeta = this.getFunctionMetadata(functionId);
    if (!functionMeta) return null;
    if (!functionMeta.context) {
      functionMeta.context = new FunctionFlowContext(this, functionId);
    }
    return functionMeta.context;
  }

  getCurrentFlowPredicate(functionId, pc) {
    const functionMeta = this.getFunctionMetadata(functionId);
    if (!functionMeta) return null;
    const block = functionMeta.graph.getBlockForPc(pc);
    if (!block) return null;
    return functionMeta.predicatesByBlockId.get(block.blockId) || null;
  }

  getFlowId(functionId, pc) {
    const predicate = this.getCurrentFlowPredicate(functionId, pc);
    return predicate ? predicate.flowId : null;
  }

  getBlockForPc(functionId, pc) {
    const functionMeta = this.getFunctionMetadata(functionId);
    if (!functionMeta) return null;
    return functionMeta.graph.getBlockForPc(pc);
  }

  getFunctionMetadata(functionId) {
    if (!this.metadata) return null;
    return this.metadata.functionsById.get(functionId) || null;
  }
}

class FlowStateHandle {
  constructor(functionId, recorderId) {
    this.kind = "FlowStateHandle";
    this.functionId = functionId;
    this.handleId = `flow-state:${functionId}:${recorderId}`;
    Object.freeze(this);
  }
}

class SharedFlowRecorder {
  constructor(functionId, recorderId, owner) {
    this.kind = "SharedFlowRecorder";
    this.functionId = functionId;
    this.recorderId = recorderId;
    this.owner = owner;
    this.initialState = recorderId & 0x7fff;
    this.stateHandle = new FlowStateHandle(functionId, recorderId);
    Object.freeze(this);
  }
}

class FlowStateCoordinator {
  constructor() {
    this.recordersByFunctionId = new Map();
    this.runtimeStateFunctionIds = new Set();
    this.nextRecorderId = 0;
  }

  getStateHandle(functionId) {
    const recorder = this.recordersByFunctionId.get(functionId);
    return recorder ? recorder.stateHandle : null;
  }

  hasRuntimeState(functionId) {
    return this.runtimeStateFunctionIds.has(functionId);
  }

  markRuntimeStateInjected(functionId) {
    if (this.recordersByFunctionId.has(functionId)) this.runtimeStateFunctionIds.add(functionId);
  }

  assertSingleRecorder(functionId) {
    if (this.recordersByFunctionId.has(functionId)) {
      throw new Error(`duplicate-recorder: SharedFlowRecorder already exists for function ${functionId}`);
    }
    return true;
  }

  ensureSharedRecorder(functionId, owner) {
    const existing = this.recordersByFunctionId.get(functionId);
    if (existing) return existing;
    const recorder = new SharedFlowRecorder(functionId, this.nextRecorderId++, owner);
    this.recordersByFunctionId.set(functionId, recorder);
    return recorder;
  }
}

class CfgTransformer {
  constructor(options = {}) {
    this.injectRuntimeState = options.injectRuntimeState === true;
    this.runtimeStateExempt = Array.isArray(options.runtimeStateExempt) ? options.runtimeStateExempt.slice() : [];
    this.seed = options.seed ?? 0;
    this.force = options.force === true;
  }

  run(module, context) {
    if (!isVMModuleArtifact(module)) return module;
    if (this.injectRuntimeState) module = cloneValue(module);
    if (context && context.cfg instanceof CfgContext) {
      context.cfg.preprocessModule(module, {
        injectRuntimeState: this.injectRuntimeState,
        runtimeStateExempt: this.runtimeStateExempt,
        seed: this.seed,
        force: this.force,
      });
    }
    return module;
  }
}

function isVMModuleArtifact(value) {
  return !!value
    && typeof value === "object"
    && typeof value.entry === "number"
    && (Array.isArray(value.functions) || Array.isArray(value.funcs));
}

function createTransformContext() {
  const flowState = new FlowStateCoordinator();
  return {
    flowState,
    cfg: new CfgContext(flowState),
    cftracker: createCfTrackerContext(),
  };
}

function createCfgTransform(options = {}) {
  return new CfgTransformer(options);
}

function injectSharedRuntimeRecorders(module, flowState) {
  injectSharedRuntimeRecordersWithExemptions(module, flowState, [], 0);
}

function injectSharedRuntimeRecordersWithExemptions(module, flowState, exemptList, seed = 0, logicalMetadata = null) {
  const funcs = module.funcs || module.functions || [];
  const functionNames = collectFunctionNames(module, funcs);
  for (let functionId = 0; functionId < funcs.length; functionId++) {
    const func = funcs[functionId];
    if (!func) continue;
    if (matchesExempt(exemptList, functionNames[functionId])) continue;
    const recorder = flowState.ensureSharedRecorder(functionId, "CfgTransformer");
    const logicalBlocks = getLogicalBlocksForMaterialization(func, functionId, seed, logicalMetadata);
    funcs[functionId] = injectFunctionRecorder(module, func, recorder, logicalBlocks);
    flowState.markRuntimeStateInjected(functionId);
  }
}

function injectFunctionRecorder(module, func, recorder, logicalBlocks = []) {
  const shifted = reserveHiddenCfidLocal(func);
  const originalCode = shifted.code instanceof Uint8Array ? shifted.code : Uint8Array.from(shifted.code || []);
  const blockCfidsByStartPc = new Map((logicalBlocks || [])
    .filter((block) => Number.isInteger(block.startPc) && Number.isInteger(block.cfid))
    .map((block) => [block.startPc, block.cfid]));
  for (const site of func[LOGICAL_CFID_SITES] || []) {
    if (Number.isInteger(site.seqPc) && Number.isInteger(site.cfid)) {
      blockCfidsByStartPc.set(site.seqPc, site.cfid);
    }
  }
  if (!blockCfidsByStartPc.has(0)) blockCfidsByStartPc.set(0, recorder.initialState);
  const buffer = new BytecodeBuffer();
  const pcMap = new Map();
  const instructionPcMap = new Map();
  const layout = require("../../virtualize/asm/layout").decodeFunctionLayout(originalCode);
  for (const instruction of layout.instructions) {
    pcMap.set(instruction.seqPc, buffer.position);
    const blockCfid = blockCfidsByStartPc.get(instruction.seqPc);
    if (Number.isInteger(blockCfid)) emitCfidStore(buffer, module, blockCfid);
    instructionPcMap.set(instruction.seqPc, buffer.position);
    for (let pc = instruction.seqPc; pc < instruction.endPc; pc++) buffer.emitU8(originalCode[pc]);
  }
  shifted.code = buffer.toUint8Array();
  Object.defineProperty(shifted, MATERIALIZED_LOGICAL_CFIDS, {
    value: createMaterializedLogicalCfids(logicalBlocks, func[LOGICAL_CFID_SITES] || [], pcMap),
    writable: true,
    configurable: true,
  });
  remapRelativeControlFlowOperands(shifted.code, layout, pcMap, instructionPcMap);
  shifted.exTable = remapExceptionTable(shifted.exTable || [], pcMap, layout, shifted.code.length);
  shifted.srcMap = remapSourceMap(shifted.srcMap || [], pcMap, layout, shifted.code.length);
  return shifted;
}

function getLogicalBlocksForMaterialization(func, functionId, seed, logicalMetadata) {
  if (Array.isArray(func[LOGICAL_CFID_SITES]) && func[LOGICAL_CFID_SITES].length > 0) {
    const transformedBlocks = analyzeFunctionLogicalBlocks(func, functionId, seed);
    const preassignedCfids = createPreassignedCfidsByStart(transformedBlocks, func[LOGICAL_CFID_SITES].map((site) => ({ startPc: site.seqPc, cfid: site.cfid })));
    return transformedBlocks.map((block) => ({
      ...block,
      cfid: preassignedCfids.get(block.blockId) ?? block.cfid,
    }));
  }
  const existing = logicalMetadata?.functionsById?.get(functionId)?.blocks;
  if (Array.isArray(existing) && existing.some((block) => Number.isInteger(block.cfid))) return existing;
  return analyzeFunctionLogicalBlocks(func, functionId, seed);
}

function analyzeFunctionLogicalBlocks(func, functionId, seed) {
  const graph = analyzeModuleFlowGraph({ version: 1, entry: 0, funcs: [func], classes: [], constPool: { literals: [] } }).functions[0];
  if (!graph) return [];
  return createFunctionMetadata({ ...graph, functionId }, new FlowStateCoordinator(), seed).blocks;
}

function createMaterializedLogicalCfids(logicalBlocks, logicalSites, pcMap) {
  const entries = [];
  for (const block of logicalBlocks || []) {
    const startPc = pcMap.get(block.startPc);
    if (Number.isInteger(startPc) && Number.isInteger(block.cfid)) entries.push({ startPc, cfid: block.cfid });
  }
  for (const site of logicalSites || []) {
    const startPc = pcMap.get(site.seqPc);
    if (Number.isInteger(startPc) && Number.isInteger(site.cfid)) entries.push({ startPc, cfid: site.cfid });
  }
  return entries;
}

function emitCfidStore(buffer, vmModule, cfid) {
  emitI32Push(buffer, vmModule, cfid | 0);
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
  if (literals.length >= 0xffff) throw new RangeError("cfg literal pool index out of u16 range");
  literals.push(value);
  if (module.constPool) module.constPool.literals = literals;
  module.constants = literals;
  return literals.length - 1;
}

function emitI16StatePush(buffer, value) {
  if (value < -0x8000 || value > 0x7fff) throw new RangeError(`shared flow recorder initial state out of i16 range: ${value}`);
  buffer.emitOp(OP.push_i);
  buffer.emitI16(value | 0);
}

function remapRelativeControlFlowOperands(code, layout, pcMap, instructionPcMap) {
  for (const instruction of layout.instructions) {
    const operandIndex = getRelativeOffsetOperandIndex(instruction);
    if (operandIndex < 0) continue;
    const operand = instruction.operands[operandIndex];
    if (!operand || operand.dynamic || operand.occupiesBytes !== true || operand.type !== "i16") continue;
    const newSeqPc = instructionPcMap.get(instruction.seqPc);
    if (!Number.isInteger(newSeqPc)) continue;
    const originalTarget = operand.endPc + operand.value;
    const newTarget = remapPc(originalTarget, pcMap, layout, code.length, { executableTarget: true });
    const newOperandPc = newSeqPc + (operand.pc - instruction.seqPc);
    writeI16(code, newOperandPc, assertI16(newTarget - (newOperandPc + 2), "cfg remapped branch offset"));
  }
}

function getRelativeOffsetOperandIndex(instruction) {
  if (instruction.op === OP.jmp) return 0;
  if (instruction.op === OP.jmp_if) return 1;
  if (instruction.op === OP.iter_op) {
    const kindOperand = instruction.operands[0];
    if (kindOperand?.dynamic === true) return -1;
    if (kindOperand?.value === 1 || kindOperand?.value === 4) return 1;
  }
  return -1;
}

function writeI16(code, pc, value) {
  const normalized = value < 0 ? value + 0x10000 : value;
  code[pc] = normalized & 0xff;
  code[pc + 1] = (normalized >>> 8) & 0xff;
}

function assertI16(value, label) {
  if (!Number.isInteger(value) || value < -0x8000 || value > 0x7fff) {
    throw new RangeError(`${label} out of i16 range: ${value}`);
  }
  return value | 0;
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

function cloneValue(value) {
  if (value instanceof Uint8Array) return Uint8Array.from(value);
  if (value instanceof RegExp) return new RegExp(value.source, value.flags);
  if (Array.isArray(value)) return value.map(cloneValue);
  if (value && typeof value === "object") {
    const out = {};
    for (const [key, child] of Object.entries(value)) out[key] = cloneValue(child);
    for (const symbol of Object.getOwnPropertySymbols(value)) out[symbol] = cloneValue(value[symbol]);
    return out;
  }
  return value;
}

function createFunctionMetadata(functionGraph, flowState, seed = 0, options = {}) {
  const predicatesByBlockId = new Map();
  const recorder = flowState.ensureSharedRecorder(functionGraph.functionId, "CfgTransformer");
  const blockPlan = buildBlockPlan(functionGraph, seed, functionGraph.functionId, {
    preassignedCfids: options.preassignedCfids,
  });
  const blockById = new Map(blockPlan.blocks.map((block) => [getBlockId(block), block]));
  const blocks = functionGraph.blocks.map((block) => {
    const blockId = getBlockId(block);
    const plannedBlock = blockById.get(blockId);
    return {
      ...block,
      blockId,
      cfid: plannedBlock?.cfid ?? blockPlan.getCfid(blockId),
    };
  });

  for (const block of blocks) {
    predicatesByBlockId.set(block.blockId, createFlowPredicate(functionGraph.functionId, block, recorder.stateHandle));
  }

  return {
    functionId: functionGraph.functionId,
    graph: functionGraph,
    blocks,
    pcToBlock: blockPlan.pcToBlock,
    blockCfids: blocks.map((block) => block.cfid),
    entryCfid: blocks[0]?.cfid ?? blockPlan.entryCfid,
    getCfid: blockPlan.getCfid,
    predicatesByBlockId,
    context: null,
  };
}

function createPreassignedCfidsByStart(targetBlocks, sourceBlocks) {
  const byStart = new Map();
  for (const sourceBlock of sourceBlocks || []) {
    if (Number.isInteger(sourceBlock.startPc) && Number.isInteger(sourceBlock.cfid)) byStart.set(sourceBlock.startPc, sourceBlock.cfid);
  }
  const preassigned = new Map();
  for (const targetBlock of targetBlocks || []) {
    const cfid = byStart.get(targetBlock.startPc);
    if (Number.isInteger(cfid)) preassigned.set(getBlockId(targetBlock), cfid);
  }
  return preassigned;
}

function getBlockId(block) {
  return Object.prototype.hasOwnProperty.call(block, "blockId") ? block.blockId : block.id;
}

function createFlowPredicate(functionId, block, stateHandle) {
  return {
    kind: "FlowPredicate",
    functionId,
    blockId: block.blockId,
    flowId: `flow:${functionId}:${block.startPc}`,
    stateHandle,
    reachable: block.reachable,
    opaque: block.opaque,
    canUseRuntimeState: true,
  };
}

function collectFunctionNames(module, funcs) {
  const literals = module.constPool?.literals || module.constants || [];
  return funcs.map((func) => {
    if (typeof func?.name === "string") return func.name;
    if (Number.isInteger(func?.nameIdx) && func.nameIdx >= 0 && typeof literals[func.nameIdx] === "string") {
      return literals[func.nameIdx];
    }
    return null;
  });
}

module.exports = {
  createTransformContext,
  createCfgTransform,
  FlowStateCoordinator,
  FlowStateHandle,
  FunctionFlowContext,
  CfgContext,
  CfgTransformer,
  SharedFlowRecorder,
};
