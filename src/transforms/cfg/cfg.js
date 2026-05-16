"use strict";

const { OP } = require("../../virtualize/opcodes");
const { decodeFunctionLayout } = require("../../virtualize/asm/layout");
const { buildBranchCfg } = require("../../virtualize/asm/cfg");

function analyzeFunctionFlowGraph(func, options = {}) {
  const functionId = options.functionId ?? 0;
  const exTable = Array.isArray(func?.exTable) ? func.exTable : [];
  const branchCfg = buildBranchCfg(func?.code || [], exTable);
  const layout = branchCfg.layout || decodeFunctionLayout(func?.code || []);
  const protectedRanges = normalizeProtectedRanges(exTable);
  const edges = [
    ...branchCfg.edges.map(normalizeConcreteEdge),
    ...branchCfg.unsupportedBranches.map(normalizeUnsupportedEdge),
  ].sort(compareEdges);
  const blocks = buildBlocks(layout, functionId, edges, protectedRanges);
  const blocksByPc = indexBlocks(blocks);

  markReachable(blocks, blocksByPc, layout, edges);
  markOpaqueBlocks(blocks, edges);

  return {
    kind: "FunctionFlowGraph",
    functionId,
    blocks,
    edges,
    protectedRanges,
    exceptionRanges: protectedRanges,
    getBlockForPc(pc) {
      return getBlockForPc(blocks, pc);
    },
  };
}

function analyzeModuleFlowGraph(module) {
  const funcs = module?.funcs || module?.functions || [];
  const functions = funcs.map((func, functionId) => analyzeFunctionFlowGraph(func, { functionId }));
  const functionsById = new Map(functions.map((graph) => [graph.functionId, graph]));
  return {
    kind: "ModuleFlowGraph",
    functions,
    functionGraphs: functions,
    functionsById,
    getFunctionFlowGraph(functionId) {
      return functionsById.get(functionId) || null;
    },
  };
}

function buildBlocks(layout, functionId, edges, protectedRanges) {
  const leaders = collectLeaders(layout, edges, protectedRanges);
  const sortedLeaders = Array.from(leaders).sort((left, right) => left - right);
  const blocks = [];

  for (let index = 0; index < sortedLeaders.length; index++) {
    const startPc = sortedLeaders[index];
    const endPc = sortedLeaders[index + 1] ?? layout.code.length;
    if (startPc >= endPc) continue;
    const instructions = layout.instructions.filter((instruction) => instruction.seqPc >= startPc && instruction.seqPc < endPc);
    if (instructions.length === 0) continue;
    const terminatorInstruction = findTerminator(instructions[instructions.length - 1]);
    blocks.push({
      blockId: `${functionId}:${startPc}`,
      functionId,
      startPc,
      endPc,
      reachable: false,
      opaque: false,
      terminator: terminatorInstruction ? createTerminator(terminatorInstruction) : null,
    });
  }

  return blocks;
}

function collectLeaders(layout, edges, protectedRanges) {
  const leaders = new Set();
  if (layout.instructions.length > 0) leaders.add(layout.instructions[0].seqPc);

  for (const edge of edges) {
    if (Number.isInteger(edge.targetPc) && layout.sequenceStarts.has(edge.targetPc)) leaders.add(edge.targetPc);
    if (edge.kind === "fallthrough" && layout.sequenceStarts.has(edge.targetPc)) leaders.add(edge.targetPc);
  }

  for (const instruction of layout.instructions) {
    if (isControlTerminator(instruction) && layout.sequenceStarts.has(instruction.endPc)) leaders.add(instruction.endPc);
  }

  for (const range of protectedRanges) {
    if (layout.sequenceStarts.has(range.startPc)) leaders.add(range.startPc);
    if (range.endPc !== layout.code.length && layout.sequenceStarts.has(range.endPc)) leaders.add(range.endPc);
    if (layout.sequenceStarts.has(range.handlerPc)) leaders.add(range.handlerPc);
  }

  return leaders;
}

function normalizeConcreteEdge(edge) {
  return {
    kind: edge.kind,
    fromPc: edge.fromSeqPc,
    fromSeqPc: edge.fromSeqPc,
    fromOpPc: edge.fromOpPc,
    op: edge.op,
    endPc: edge.endPc,
    targetPc: edge.targetPc,
    opaque: false,
    dispatchableCandidate: isDispatchableConcreteKind(edge.kind),
    operandIndex: edge.operandIndex,
    conditionOperand: edge.conditionOperand,
    exTableIndex: edge.exTableIndex,
  };
}

function normalizeUnsupportedEdge(branch) {
  const kind = branch.op === OP.jmp_if ? "branch" : branch.op === OP.iter_op ? "iter-continue" : branch.op === OP.jmp ? "jump" : "unsupported";
  const edge = {
    kind,
    fromPc: branch.seqPc,
    fromSeqPc: branch.seqPc,
    fromOpPc: branch.opPc,
    op: branch.op,
    endPc: branch.endPc,
    reason: branch.reason,
    opaque: true,
    dispatchableCandidate: false,
  };
  if (branch.reason && !/^dynamic/.test(branch.reason) && Number.isInteger(branch.targetPc)) edge.targetPc = branch.targetPc;
  return edge;
}

function normalizeProtectedRanges(exTable) {
  return exTable.map((entry, index) => ({
    index,
    startPc: entry.start,
    endPc: entry.end,
    handlerPc: entry.handler,
    stackDepth: entry.stackDepth,
    isFinal: entry.isFinal,
  }));
}

function markReachable(blocks, blocksByPc, layout, edges) {
  if (blocks.length === 0) return;
  const edgesByFromPc = new Map();
  for (const edge of edges) {
    if (!Number.isInteger(edge.fromSeqPc)) continue;
    let fromEdges = edgesByFromPc.get(edge.fromSeqPc);
    if (!fromEdges) {
      fromEdges = [];
      edgesByFromPc.set(edge.fromSeqPc, fromEdges);
    }
    fromEdges.push(edge);
  }

  const queue = [blocks[0].startPc];
  const seen = new Set();
  while (queue.length > 0) {
    const startPc = queue.shift();
    if (seen.has(startPc)) continue;
    seen.add(startPc);
    const block = blocksByPc.get(startPc);
    if (!block) continue;
    block.reachable = true;

    for (const targetPc of getBlockSuccessors(block, layout, edgesByFromPc)) {
      const targetBlock = getBlockForPc(blocks, targetPc);
      if (targetBlock && !seen.has(targetBlock.startPc)) queue.push(targetBlock.startPc);
    }
  }
}

function getBlockSuccessors(block, layout, edgesByFromPc) {
  const instructions = layout.instructions.filter((instruction) => instruction.seqPc >= block.startPc && instruction.seqPc < block.endPc);
  if (instructions.length === 0) return [];
  const last = instructions[instructions.length - 1];
  const successors = [];

  for (const edge of edgesByFromPc.get(last.seqPc) || []) {
    if (!edge.opaque && Number.isInteger(edge.targetPc)) successors.push(edge.targetPc);
  }

  if (!isTerminatingInstruction(last) && layout.sequenceStarts.has(last.endPc)) successors.push(last.endPc);
  return successors;
}

function markOpaqueBlocks(blocks, edges) {
  for (const edge of edges) {
    if (!edge.opaque) continue;
    const block = getBlockForPc(blocks, edge.fromSeqPc);
    if (block) block.opaque = true;
  }
}

function indexBlocks(blocks) {
  return new Map(blocks.map((block) => [block.startPc, block]));
}

function getBlockForPc(blocks, pc) {
  return blocks.find((block) => block.startPc <= pc && pc < block.endPc) || null;
}

function findTerminator(instruction) {
  return isTerminatingInstruction(instruction) ? instruction : null;
}

function createTerminator(instruction) {
  return {
    kind: terminatorKind(instruction),
    pc: instruction.seqPc,
    seqPc: instruction.seqPc,
    opPc: instruction.opPc,
    op: instruction.op,
    endPc: instruction.endPc,
  };
}

function isControlTerminator(instruction) {
  return instruction.op === OP.jmp || instruction.op === OP.jmp_if || instruction.op === OP.iter_op || instruction.op === OP.ret || instruction.op === OP.throw;
}

function isTerminatingInstruction(instruction) {
  return instruction && (instruction.op === OP.jmp || instruction.op === OP.jmp_if || instruction.op === OP.ret || instruction.op === OP.throw || isBranchingIterOp(instruction));
}

function isBranchingIterOp(instruction) {
  if (!instruction || instruction.op !== OP.iter_op) return false;
  const kind = instruction.operands[0]?.value;
  return kind === 1 || kind === 4;
}

function terminatorKind(instruction) {
  if (instruction.op === OP.jmp) return "jump";
  if (instruction.op === OP.jmp_if) return "branch";
  if (instruction.op === OP.ret) return "return";
  if (instruction.op === OP.throw) return "throw";
  if (instruction.op === OP.iter_op) return "iter";
  return "unknown";
}

function isDispatchableConcreteKind(kind) {
  return kind === "jump" || kind === "branch";
}

function compareEdges(left, right) {
  return (left.fromSeqPc - right.fromSeqPc)
    || edgeKindOrder(left.kind) - edgeKindOrder(right.kind)
    || ((left.targetPc ?? Number.MAX_SAFE_INTEGER) - (right.targetPc ?? Number.MAX_SAFE_INTEGER));
}

function edgeKindOrder(kind) {
  if (kind === "branch") return 0;
  if (kind === "fallthrough") return 1;
  if (kind === "jump") return 2;
  if (kind === "iter-continue") return 3;
  if (kind === "exception") return 4;
  return 5;
}

module.exports = { analyzeFunctionFlowGraph, analyzeModuleFlowGraph };
