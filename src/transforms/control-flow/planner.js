"use strict";

const { OP } = require("../../virtualize/opcodes");
const { matchesExempt } = require("../shared/match");
const { buildBranchCfg } = require("../../virtualize/asm/cfg");
const { buildBlockPlan } = require("../cftracker/plan");
const { allocateJunkLabels, buildTableLayout } = require("../shared/table-layout");

const I16_MIN = -0x8000;
const I16_MAX = 0x7fff;

function planControlFlow(module, options = {}, context = null) {
  const funcs = module.funcs || module.functions || [];
  const seed = options.seed ?? 0;
  const junkCodesPercent = options.junkCodesPercent ?? 0;
  const loadFactor = Math.max(1 - junkCodesPercent, 0.01);
  const functionNames = collectFunctionNames(module, funcs);
  const functions = funcs.map((func, funcIdx) => planFunction(func, funcIdx, seed, junkCodesPercent, loadFactor, matchesExempt(options.exempt, functionNames[funcIdx]) ? functionNames[funcIdx] : null, context));

  return { functions };
}

function planFunction(func, funcIdx, seed, junkCodesPercent, loadFactor, exemptName, context) {
  const layoutSeedInput = seed ^ funcIdx;
  const decodeKey = mix32(seed ^ Math.imul(funcIdx + 1, 0x6d2b79f5));

  if (exemptName) {
    return createSkippedPlan(funcIdx, `exempt-function:${exemptName}`, { staticSlots: [] });
  }

  const branchCfg = buildBranchCfg(func.code || [], func.exTable || []);
  const functionGraph = readFunctionGraph(context, funcIdx);
  const cfgEdges = functionGraph?.edges || branchCfg.edges || [];
  const rejectedCandidates = (branchCfg.unsupportedBranches || []).map((branch) => normalizeUnsupportedBranch(funcIdx, branchCfg.layout, branch));
  if (rejectedCandidates.length > 0) {
    return createSkippedPlan(funcIdx, `unsupported-branch-layout:${rejectedCandidates[0].reason}`, { rejectedCandidates, staticSlots: [] });
  }

  const candidates = [];
  const blockPlan = readBlockPlan(context, funcIdx, branchCfg, seed);
  const entryCfid = blockPlan.entryCfid;
  const callSites = collectCallSites(branchCfg, blockPlan);
  const usedRealKeys = new Set();

  const dispatchableEdges = [];
  const nonDispatchableEdges = [];
  for (const edge of cfgEdges) {
    const genericRejection = classifyGenericEdgeExclusion(edge);
    if (genericRejection) {
      nonDispatchableEdges.push(createNonDispatchableEdge(funcIdx, edge, genericRejection));
      continue;
    }
    const instruction = branchCfg.layout.bySeqPc.get(edge.fromSeqPc);
    const rejection = classifyCandidate(branchCfg.layout, instruction, edge, funcIdx);
    if (rejection) {
      rejectedCandidates.push(rejection);
      nonDispatchableEdges.push(createNonDispatchableEdge(funcIdx, edge, rejection.reason));
      return createSkippedPlan(funcIdx, `unsupported-branch-layout:${rejection.reason}`, {
        rejectedCandidates,
        callSites,
        entryCfid,
        dispatchableEdges,
        nonDispatchableEdges,
        staticSlots: [],
      });
    }

    const predicate = readCurrentFlowPredicate(context, funcIdx, edge.fromSeqPc);
    const sourceBlockId = blockPlan.pcToBlock[edge.fromSeqPc];
    const targetBlockId = blockPlan.pcToBlock[edge.targetPc];
    const sourceCfid = getKnownBlockCfid(blockPlan, sourceBlockId);
    const targetCfid = getKnownBlockCfid(blockPlan, targetBlockId);
    const fallthroughBlockId = edge.kind === "branch" ? blockPlan.pcToBlock[edge.endPc] : null;
    const fallthroughCfid = Number.isInteger(fallthroughBlockId) ? getKnownBlockCfid(blockPlan, fallthroughBlockId) : null;
    const state = deriveUniqueState(seed, funcIdx, candidates.length, edge.fromSeqPc, edge.targetPc, [sourceCfid], usedRealKeys);
    usedRealKeys.add(sourceCfid ^ state);
    dispatchableEdges.push(createDispatchableEdge(funcIdx, edge, predicate, candidates.length, sourceBlockId, targetBlockId));
    candidates.push({
      funcIdx,
      branchIndex: candidates.length,
      kind: edge.kind,
      seqPc: edge.fromSeqPc,
      opPc: edge.fromOpPc,
      op: edge.op,
      endPc: edge.endPc,
      operandIndex: edge.operandIndex,
      targetPc: edge.targetPc,
      originalOffset: edge.targetPc - edge.endPc,
      plannedDynamicOffset: edge.targetPc - edge.endPc,
      state,
      sourceBlockId,
      targetBlockId,
      sourceCfid,
      targetCfid,
      fallthroughBlockId,
      fallthroughCfid,
      incomingCfids: [sourceCfid],
      predicate,
    });
  }

  const realEntries = candidates.map((candidate) => ({
    kind: "real",
    key: candidate.sourceCfid ^ candidate.state,
    sourceCfid: candidate.sourceCfid,
    state: candidate.state,
    funcIdx,
    branchIndex: candidate.branchIndex,
    targetPc: candidate.targetPc,
    plannedDynamicOffset: candidate.plannedDynamicOffset,
  }));
  const exceptionProxies = collectExceptionProxies(func.exTable || [], branchCfg, blockPlan, seed, funcIdx, candidates.length, usedRealKeys);
  const exceptionProxyEntries = exceptionProxies.flatMap((proxy) => proxy.incomingCfids.map((incomingCfid) => ({
    kind: "exception-proxy",
    key: incomingCfid ^ proxy.state,
    sourceCfid: incomingCfid,
    state: proxy.state,
    funcIdx,
    proxyIndex: proxy.proxyIndex,
    exTableIndex: proxy.exTableIndex,
    targetPc: proxy.handlerPc,
    plannedDynamicOffset: 0,
  })));
  const allRealEntries = [...realEntries, ...exceptionProxyEntries];
  const junkEntries = allocateJunkLabels(allRealEntries.map((entry) => entry.key), junkCodesPercent, seed ^ funcIdx)
    .map((key, index) => ({ kind: "junk", key, funcIdx, index }));

  const unsafeCallSeed = findUnsafeCallSeed(func, branchCfg.layout, callSites, candidates);
  if (unsafeCallSeed) {
    return createSkippedPlan(funcIdx, unsafeCallSeed.reason, {
      rejectedCandidates,
      callSites,
      entryCfid,
      blocks: blockPlan.blocks,
      pcToBlock: blockPlan.pcToBlock,
      blockCfids: blockPlan.blockCfids,
      dispatchableEdges,
      nonDispatchableEdges,
      staticSlots: [],
    });
  }

  const unsupportedSeedRepairReason = classifyUnsupportedDirectVmSeedRepair(func, candidates);
  if (unsupportedSeedRepairReason) {
    return createSkippedPlan(funcIdx, unsupportedSeedRepairReason, {
      rejectedCandidates,
      callSites,
      entryCfid,
      blocks: blockPlan.blocks,
      pcToBlock: blockPlan.pcToBlock,
      blockCfids: blockPlan.blockCfids,
      dispatchableEdges,
      nonDispatchableEdges,
      staticSlots: [],
    });
  }

  const tableEntries = [...allRealEntries, ...junkEntries];
  let tableLayout = null;
  if (tableEntries.length > 0) {
    try {
      tableLayout = buildControlFlowTableLayout(tableEntries, { seed: layoutSeedInput, loadFactor, hashMode: "dispatch32" });
    } catch (error) {
      if (error instanceof RangeError && /table size exceeds u16 operand capacity/i.test(String(error.message || ""))) {
        return createSkippedPlan(funcIdx, "dispatch-table-too-large", {
          entryCfid,
          blocks: blockPlan.blocks,
          pcToBlock: blockPlan.pcToBlock,
          blockCfids: blockPlan.blockCfids,
          callSites,
          candidates,
          dispatchableEdges,
          nonDispatchableEdges,
          rejectedCandidates,
          realEntries,
          exceptionProxies,
          exceptionProxyEntries,
          junkEntries,
          tableEntries,
          staticSlots: [],
        });
      }
      throw error;
    }
  }

  return {
    funcIdx,
    skipped: false,
    reason: null,
    entryCfid,
    dispatcherPlan: tableLayout ? buildDispatcherPlan(tableLayout, entryCfid, decodeKey) : null,
    blocks: blockPlan.blocks,
    pcToBlock: blockPlan.pcToBlock,
    blockCfids: blockPlan.blockCfids,
    callSites,
    candidates,
    dispatchableEdges,
    nonDispatchableEdges,
    rejectedCandidates,
    exceptionProxies,
    realEntries,
    exceptionProxyEntries,
    junkEntries,
    tableEntries,
    tableLayout,
    staticSlots: tableLayout ? buildStaticSlotPlan(tableLayout) : [],
  };
}

function readFunctionGraph(context, funcIdx) {
  const graph = context?.cfg?.getFunctionMetadata?.(funcIdx)?.graph;
  if (!graph || !Array.isArray(graph.edges)) return null;
  return graph;
}

function readCurrentFlowPredicate(context, funcIdx, pc) {
  if (typeof context?.cfg?.getCurrentFlowPredicate !== "function") return null;
  return context.cfg.getCurrentFlowPredicate(funcIdx, pc);
}

function readBlockPlan(context, funcIdx, branchCfg, seed) {
  const metadata = context?.cftracker?.getFunctionMetadata?.(funcIdx);
  if (metadata?.getCfid && Array.isArray(metadata.blocks) && metadata.pcToBlock && Array.isArray(metadata.blockCfids)) {
    return metadata;
  }
  const cfgMeta = context?.cfg?.getFunctionMetadata?.(funcIdx) || null;
  const preassignedCfids = createPreassignedCfids(branchCfg.blocks || [], cfgMeta?.blocks || []);
  return buildBlockPlan(branchCfg, seed, funcIdx, { preassignedCfids });
}

function getBlockId(block) {
  return Object.prototype.hasOwnProperty.call(block, "blockId") ? block.blockId : block.id;
}

function createPreassignedCfids(targetBlocks, sourceBlocks) {
  const preassigned = new Map();
  for (const targetBlock of targetBlocks) {
    const targetStart = getBlockStart(targetBlock);
    const targetEnd = getBlockEnd(targetBlock);
    const sourceBlock = findLogicalSourceBlock(sourceBlocks, targetStart, targetEnd);
    if (!sourceBlock || !Number.isInteger(sourceBlock.cfid)) continue;
    preassigned.set(getBlockId(targetBlock), sourceBlock.cfid);
  }
  return preassigned;
}

function findLogicalSourceBlock(sourceBlocks, targetStart, targetEnd) {
  return sourceBlocks.find((block) => block.startPc === targetStart && block.endPc === targetEnd)
    || sourceBlocks.find((block) => block.startPc === targetStart)
    || sourceBlocks.find((block) => block.startPc <= targetStart && targetEnd <= block.endPc)
    || null;
}

function getBlockStart(block) {
  return Number.isInteger(block.startPc) ? block.startPc : block.start;
}

function getBlockEnd(block) {
  return Number.isInteger(block.endPc) ? block.endPc : block.end;
}

function buildControlFlowTableLayout(entries, options) {
  const layout = buildTableLayout(entries.map((entry) => ({ label: entry.key, payload: entry })), options);
  return {
    labels: layout.labels,
    handlers: layout.payloads,
    seed: layout.seed,
    hashMode: layout.hashMode,
    tableSize: layout.tableSize,
    attempts: layout.attempts,
    slots: layout.slots.map((slot) => (slot ? {
      slot: slot.slot,
      index: slot.index,
      label: slot.label,
      handler: slot.payload,
    } : null)),
    decoySlots: layout.decoySlots,
  };
}

function getKnownBlockCfid(blockPlan, blockId) {
  return blockPlan.getCfid(blockId);
}

function classifyGenericEdgeExclusion(edge) {
  if (edge.dispatchableCandidate === false) return "not-dispatchable-candidate";
  if (edge.kind !== "jump" && edge.kind !== "branch") return "not-dispatchable-candidate";
  return null;
}

function createDispatchableEdge(funcIdx, edge, predicate, branchIndex, sourceBlockId, targetBlockId) {
  return {
    recordType: "DispatchableEdge",
    kind: edge.kind,
    dispatchable: true,
    funcIdx,
    branchIndex,
    fromPc: edge.fromPc ?? edge.fromSeqPc,
    fromSeqPc: edge.fromSeqPc,
    fromOpPc: edge.fromOpPc,
    op: edge.op,
    endPc: edge.endPc,
    targetPc: edge.targetPc,
    operandIndex: edge.operandIndex,
    sourceBlockId,
    targetBlockId,
    predicate,
  };
}

function createNonDispatchableEdge(funcIdx, edge, reason) {
  return {
    funcIdx,
    kind: edge.kind,
    fromPc: edge.fromPc ?? edge.fromSeqPc,
    fromSeqPc: edge.fromSeqPc,
    fromOpPc: edge.fromOpPc,
    op: edge.op,
    endPc: edge.endPc,
    targetPc: edge.targetPc,
    reason,
  };
}

function normalizeUnsupportedBranch(funcIdx, layout, branch) {
  const outsideFunction = Number.isInteger(branch.targetPc) && (branch.targetPc < 0 || branch.targetPc >= layout.code.length);
  return {
    funcIdx,
    seqPc: branch.seqPc,
    opPc: branch.opPc,
    op: branch.op,
    endPc: branch.endPc,
    targetPc: branch.targetPc,
    reason: outsideFunction ? "target-outside-function" : branch.reason,
  };
}

function classifyCandidate(layout, instruction, edge, funcIdx) {
  if (!instruction || (instruction.op !== OP.jmp && instruction.op !== OP.jmp_if)) {
    return createRejected(funcIdx, instruction, edge, "unsupported-opcode");
  }

  const offset = instruction.operands[edge.operandIndex];
  if (!offset || offset.dynamic === true) {
    return createRejected(funcIdx, instruction, edge, "dynamic-branch-offset");
  }

  if (!isI16(offset.value)) {
    return createRejected(funcIdx, instruction, edge, "branch-offset-out-of-range");
  }

  if (!Number.isInteger(edge.targetPc) || edge.targetPc < 0 || edge.targetPc >= layout.code.length) {
    return createRejected(funcIdx, instruction, edge, "target-outside-function");
  }

  if (!layout.sequenceStarts.has(edge.targetPc)) {
    return createRejected(funcIdx, instruction, edge, "target-not-instruction-start");
  }

  const plannedDynamicOffset = edge.targetPc - edge.endPc;
  if (!isI16(plannedDynamicOffset)) {
    return createRejected(funcIdx, instruction, edge, "planned-dynamic-offset-out-of-range");
  }

  return null;
}

function createRejected(funcIdx, instruction, edge, reason) {
  return {
    funcIdx,
    seqPc: edge?.fromSeqPc ?? instruction?.seqPc,
    opPc: edge?.fromOpPc ?? instruction?.opPc,
    op: edge?.op ?? instruction?.op,
    endPc: edge?.endPc ?? instruction?.endPc,
    targetPc: edge?.targetPc,
    reason,
  };
}

function createSkippedPlan(funcIdx, reason, extra = {}) {
  return {
    funcIdx,
    skipped: true,
    reason,
    entryCfid: null,
    blocks: [],
    pcToBlock: {},
    blockCfids: [],
    callSites: [],
    candidates: [],
    dispatchableEdges: [],
    nonDispatchableEdges: [],
    exceptionProxies: [],
    rejectedCandidates: [],
    realEntries: [],
    exceptionProxyEntries: [],
    junkEntries: [],
    tableEntries: [],
    ...extra,
  };
}

function findUnsafeCallSeed(func, layout, callSites, candidates) {
  if (!Array.isArray(func.localNames)) return null;
  if (!callSites || callSites.length === 0 || !candidates || candidates.length === 0) return null;

  for (const callSite of callSites) {
    if (isCallPastLastCandidate(layout, callSite.seqPc, candidates)) continue;
    if (!candidates.some((candidate) => candidate.seqPc > callSite.seqPc && isReachableFromCallSite(layout, callSite.seqPc, candidate.seqPc))) continue;
    const instruction = layout.bySeqPc.get(callSite.seqPc);
    const reason = classifyUnsafeCallSeed(func, layout, instruction);
    if (reason) return { seqPc: callSite.seqPc, reason };
  }

  return null;
}

function classifyUnsafeCallSeed(func, layout, instruction) {
  if (!instruction) return "unknown-callee-seed";
  const next = nextInstruction(layout, instruction);
  if (next?.op === OP.pop) return null;
  if (instruction.op === OP.call_method) return next?.op === OP.store ? "unknown-callee-seed" : null;
  if (instruction.op !== OP.call) return null;
  const window = previousInstructions(layout, instruction, 4);
  if (window.some((candidate) => candidate.op === OP.spread || candidate.operands.some((operand) => operand.dynamic))) return "unknown-callee-seed";
  if (window.some((candidate) => candidate.op === OP.load && candidate.operands[0]?.value === 2)) return "unknown-callee-seed";
  if (window.some((candidate) => candidate.op === OP.load && candidate.operands[0]?.value === 0 && (func.params || []).includes(candidate.operands[1]?.value))) return "unknown-callee-seed";
  return null;
}

function classifyUnsupportedDirectVmSeedRepair(func, candidates) {
  if (!candidates || candidates.length === 0) return null;
  if (Number.isInteger(func.argumentsSlot) && func.argumentsSlot >= 0) return "unsupported-direct-vm-seed-repair:arguments-slot";
  if (Number.isInteger(func.rest) && func.rest >= 0) return "unsupported-direct-vm-seed-repair:rest-slot";
  return null;
}

function nextInstruction(layout, instruction) {
  const index = layout.instructions.findIndex((candidate) => candidate.seqPc === instruction.seqPc);
  return index >= 0 ? layout.instructions[index + 1] : null;
}

function previousInstructions(layout, instruction, count) {
  const index = layout.instructions.findIndex((candidate) => candidate.seqPc === instruction.seqPc);
  return index >= 0 ? layout.instructions.slice(Math.max(0, index - count), index) : [];
}

function isReachableFromCallSite(layout, callSeqPc, candidateSeqPc) {
  const instruction = layout.bySeqPc.get(callSeqPc);
  if (!instruction) return false;
  const worklist = getSuccessorPcs(layout, instruction).filter((pc) => pc > callSeqPc);
  const seen = new Set();
  while (worklist.length > 0) {
    const pc = worklist.shift();
    if (seen.has(pc) || pc <= callSeqPc) continue;
    if (pc === candidateSeqPc) return true;
    seen.add(pc);
    const next = layout.bySeqPc.get(pc);
    if (!next) continue;
    for (const successor of getSuccessorPcs(layout, next)) worklist.push(successor);
  }
  return false;
}

function isCallPastLastCandidate(layout, callSeqPc, candidates) {
  const lastCandidatePc = candidates.reduce((max, candidate) => Math.max(max, candidate.seqPc), -1);
  if (callSeqPc <= lastCandidatePc) return false;
  const instruction = layout.bySeqPc.get(callSeqPc);
  if (!instruction) return false;
  const worklist = getSuccessorPcs(layout, instruction).filter((pc) => pc > callSeqPc);
  const seen = new Set();
  while (worklist.length > 0) {
    const pc = worklist.shift();
    if (seen.has(pc) || pc <= callSeqPc) continue;
    seen.add(pc);
    const next = layout.bySeqPc.get(pc);
    if (!next) continue;
    if (next.op === OP.jmp) return false;
    for (const successor of getSuccessorPcs(layout, next)) worklist.push(successor);
  }
  return true;
}

function collectFunctionNames(module, funcs) {
  const literals = module.constPool?.literals || module.constants || [];
  return funcs.map((func) => {
    if (typeof func.name === "string") return func.name;
    if (Number.isInteger(func.nameIdx) && func.nameIdx >= 0 && typeof literals[func.nameIdx] === "string") {
      return literals[func.nameIdx];
    }
    return null;
  });
}

function deriveState(seed, funcIdx, branchIndex, seqPc, targetPc) {
  return mix32(seed ^ Math.imul(funcIdx + 1, 0x85ebca6b) ^ Math.imul(branchIndex + 1, 0xc2b2ae35) ^ seqPc ^ Math.imul(targetPc + 1, 0x27d4eb2d));
}

function deriveUniqueState(seed, funcIdx, branchIndex, seqPc, targetPc, incomingCfids, usedRealKeys) {
  let salt = 0;
  while (salt <= 0xffff) {
    const state = deriveState(seed ^ salt, funcIdx, branchIndex, seqPc, targetPc);
    if (incomingCfids.every((cfid) => !usedRealKeys.has(cfid ^ state))) return state;
    salt++;
  }
  throw new RangeError("unable to allocate unique real control-flow key");
}

function collectCallSites(branchCfg, blockPlan) {
  const callSites = [];
  for (const instruction of branchCfg.layout.instructions) {
    if (instruction.op !== OP.call && instruction.op !== OP.call_method) continue;
    const targetBlockId = blockPlan.pcToBlock[instruction.endPc];
    if (!Number.isInteger(targetBlockId)) continue;
    callSites.push({
      seqPc: instruction.seqPc,
      op: instruction.op,
      targetPc: instruction.endPc,
      targetBlockId,
      targetCfid: getKnownBlockCfid(blockPlan, targetBlockId),
    });
  }
  return callSites;
}

function collectExceptionProxies(exTable, branchCfg, blockPlan, seed, funcIdx, branchIndexBase, usedRealKeys) {
  const incomingByEntry = new Map();
  for (const edge of branchCfg.edges || []) {
    if (edge.kind !== "exception") continue;
    const sourceBlockId = blockPlan.pcToBlock[edge.fromSeqPc];
    if (!Number.isInteger(sourceBlockId)) continue;
    let incoming = incomingByEntry.get(edge.exTableIndex);
    if (!incoming) {
      incoming = new Set();
      incomingByEntry.set(edge.exTableIndex, incoming);
    }
    incoming.add(getKnownBlockCfid(blockPlan, sourceBlockId));
  }

  const proxies = [];
  for (let exTableIndex = 0; exTableIndex < exTable.length; exTableIndex++) {
    const entry = exTable[exTableIndex];
    const incomingCfids = Array.from(incomingByEntry.get(exTableIndex) || []);
    if (incomingCfids.length === 0) continue;
    const targetBlockId = blockPlan.pcToBlock[entry.handler];
    const targetCfid = Number.isInteger(targetBlockId) ? getKnownBlockCfid(blockPlan, targetBlockId) : null;
    const state = deriveUniqueState(seed, funcIdx, branchIndexBase + proxies.length, entry.start, entry.handler, incomingCfids, usedRealKeys);
    for (const incomingCfid of incomingCfids) usedRealKeys.add(incomingCfid ^ state);
    proxies.push({
      funcIdx,
      proxyIndex: proxies.length,
      exTableIndex,
      startPc: entry.start,
      endPc: entry.end,
      handlerPc: entry.handler,
      stackDepth: entry.stackDepth,
      isFinal: entry.isFinal,
      state,
      targetBlockId,
      targetCfid,
      incomingCfids,
    });
  }
  return proxies;
}

function getSuccessorPcs(layout, instruction) {
  if (instruction.op === OP.ret || instruction.op === OP.throw) return [];
  if (instruction.op === OP.jmp) {
    const offset = instruction.operands[0];
    if (!offset || offset.dynamic) return [];
    return layout.sequenceStarts.has(instruction.endPc + offset.value) ? [instruction.endPc + offset.value] : [];
  }
  if (instruction.op === OP.jmp_if) {
    const successors = [];
    const offset = instruction.operands[1];
    if (offset && !offset.dynamic && layout.sequenceStarts.has(instruction.endPc + offset.value)) successors.push(instruction.endPc + offset.value);
    if (layout.sequenceStarts.has(instruction.endPc)) successors.push(instruction.endPc);
    return successors;
  }
  if (instruction.op === OP.iter_op) {
    const kind = instruction.operands[0]?.value;
    if (kind === 1 || kind === 4) {
      const successors = [];
      const offset = instruction.operands[1];
      if (offset && !offset.dynamic && layout.sequenceStarts.has(instruction.endPc + offset.value)) successors.push(instruction.endPc + offset.value);
      if (layout.sequenceStarts.has(instruction.endPc)) successors.push(instruction.endPc);
      return successors;
    }
  }
  return layout.sequenceStarts.has(instruction.endPc) ? [instruction.endPc] : [];
}

function buildDispatcherPlan(tableLayout, entryCfid, decodeKey) {
  return {
    v: 1,
    initialCfid: entryCfid | 0,
    tableSize: tableLayout.tableSize,
    layoutSeed: tableLayout.seed >>> 0,
    keySeed: decodeKey >>> 0,
    encodedSlots: buildStaticSlotPlan(tableLayout, decodeKey),
  };
}
function buildStaticSlotPlan(tableLayout, decodeKey = 0) {
  return tableLayout.slots.map((slot, index) => {
    const mixKey = toI16(mix32((decodeKey ^ index) | 0));
    const plannedOffset = slot?.handler && Number.isInteger(slot.handler.plannedDynamicOffset)
      ? slot.handler.plannedDynamicOffset | 0
      : 0;
    return {
      slot: index,
      kind: slot ? slot.handler.kind : "decoy",
      handler: slot ? slot.handler : null,
      mixKey,
      encodedOffset: toI16((plannedOffset ^ (mixKey & 0xffff)) | 0),
    };
  });
}

function toI16(value) {
  const masked = value & 0xffff;
  return masked >= 0x8000 ? masked - 0x10000 : masked;
}

function mix32(value) {
  let mixed = value >>> 0;
  mixed ^= mixed >>> 16;
  mixed = Math.imul(mixed, 0x7feb352d) >>> 0;
  mixed ^= mixed >>> 15;
  mixed = Math.imul(mixed, 0x846ca68b) >>> 0;
  mixed ^= mixed >>> 16;
  return mixed >>> 0;
}

function isI16(value) {
  return Number.isInteger(value) && value >= I16_MIN && value <= I16_MAX;
}

module.exports = { planControlFlow };
