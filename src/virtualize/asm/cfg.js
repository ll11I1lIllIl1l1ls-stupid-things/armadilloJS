"use strict";

const { OP } = require("../opcodes");
const { decodeFunctionLayout } = require("./layout");

function buildBranchCfg(input, exTable = []) {
  const layout = isLayout(input) ? input : decodeFunctionLayout(input);
  const edges = [];
  const unsupportedBranches = [];

  for (const instruction of layout.instructions) {
    if (instruction.op === OP.jmp) {
      addJmpEdges(layout, instruction, edges, unsupportedBranches);
    } else if (instruction.op === OP.jmp_if) {
      addJmpIfEdges(layout, instruction, edges, unsupportedBranches);
    } else if (instruction.op === OP.iter_op) {
      addIterOpEdges(layout, instruction, edges, unsupportedBranches);
    }
  }
  addExceptionEdges(layout, exTable, edges, unsupportedBranches);
  const blockGraph = buildBasicBlockGraph(layout, edges);

  return { layout, edges, unsupportedBranches, ...blockGraph };
}

function buildBasicBlockGraph(layout, edges) {
  const leaders = collectBlockLeaders(layout, edges);
  const starts = Array.from(leaders).sort((left, right) => left - right);
  const blocks = [];
  const pcToBlock = {};
  const instructionToBlock = new Map();

  for (let index = 0; index < starts.length; index++) {
    const start = starts[index];
    const end = index + 1 < starts.length ? starts[index + 1] : layout.code.length;
    const instructions = layout.instructions.filter((instruction) => instruction.seqPc >= start && instruction.seqPc < end);
    if (instructions.length === 0) continue;
    const block = {
      id: blocks.length,
      start,
      end,
      instructionSeqPcs: instructions.map((instruction) => instruction.seqPc),
      terminatorSeqPc: instructions[instructions.length - 1].seqPc,
      outgoingEdges: [],
      incomingEdges: [],
    };
    blocks.push(block);
    for (const instruction of instructions) {
      instructionToBlock.set(instruction.seqPc, block.id);
      pcToBlock[instruction.seqPc] = block.id;
    }
  }

  const callEdges = collectCallEdges(layout);
  const allEdges = [...edges, ...callEdges];
  for (const edge of allEdges) {
    const fromBlockId = instructionToBlock.get(edge.fromSeqPc);
    const targetBlockId = Number.isInteger(edge.targetPc) ? instructionToBlock.get(edge.targetPc) : undefined;
    if (!Number.isInteger(fromBlockId) || !Number.isInteger(targetBlockId)) continue;
    const blockEdge = { ...edge, fromBlockId, targetBlockId };
    blocks[fromBlockId].outgoingEdges.push(blockEdge);
    blocks[targetBlockId].incomingEdges.push(blockEdge);
  }

  return { blocks, pcToBlock };
}

function collectBlockLeaders(layout, edges) {
  const leaders = new Set();
  if (layout.instructions.length > 0) leaders.add(layout.instructions[0].seqPc);

  for (const edge of edges) {
    if (Number.isInteger(edge.targetPc) && layout.sequenceStarts.has(edge.targetPc)) leaders.add(edge.targetPc);
    const nextPc = layout.bySeqPc.get(edge.fromSeqPc)?.endPc;
    if (Number.isInteger(nextPc) && layout.sequenceStarts.has(nextPc)) leaders.add(nextPc);
  }

  for (const instruction of layout.instructions) {
    if ((instruction.op === OP.call || instruction.op === OP.call_method) && layout.sequenceStarts.has(instruction.endPc)) {
      leaders.add(instruction.endPc);
    }
  }

  return leaders;
}

function collectCallEdges(layout) {
  const edges = [];
  for (const instruction of layout.instructions) {
    if (instruction.op !== OP.call && instruction.op !== OP.call_method) continue;
    if (!layout.sequenceStarts.has(instruction.endPc)) continue;
    edges.push(createEdge("call-return", instruction, instruction.endPc, { operandIndex: null }));
  }
  return edges;
}

function addJmpEdges(layout, instruction, edges, unsupportedBranches) {
  const offset = instruction.operands[0];
  if (isDynamic(offset)) {
    unsupportedBranches.push(createUnsupported(instruction, "dynamic-branch-offset"));
    return;
  }

  const targetPc = instruction.endPc + offset.value;
  if (!layout.sequenceStarts.has(targetPc)) {
    unsupportedBranches.push(createUnsupported(instruction, "target-not-instruction-start", { targetPc }));
    return;
  }

  edges.push(createEdge("jump", instruction, targetPc, { operandIndex: 0 }));
}

function addJmpIfEdges(layout, instruction, edges, unsupportedBranches) {
  const offset = instruction.operands[1];
  if (isDynamic(offset)) {
    unsupportedBranches.push(createUnsupported(instruction, "dynamic-branch-offset"));
    return;
  }

  const targetPc = instruction.endPc + offset.value;
  if (!layout.sequenceStarts.has(targetPc)) {
    unsupportedBranches.push(createUnsupported(instruction, "target-not-instruction-start", { targetPc }));
    return;
  }

  edges.push(createEdge("branch", instruction, targetPc, { operandIndex: 1, conditionOperand: instruction.operands[0] }));
  edges.push(createEdge("fallthrough", instruction, instruction.endPc, { operandIndex: null, conditionOperand: instruction.operands[0] }));
}

function addIterOpEdges(layout, instruction, edges, unsupportedBranches) {
  const kind = instruction.operands[0]?.value;
  if (kind !== 1 && kind !== 4) return;

  const offset = instruction.operands[1];
  if (isDynamic(offset)) {
    unsupportedBranches.push(createUnsupported(instruction, "dynamic-iter-offset"));
    return;
  }

  const targetPc = instruction.endPc + offset.value;
  if (!layout.sequenceStarts.has(targetPc)) {
    unsupportedBranches.push(createUnsupported(instruction, "iter-target-not-instruction-start", { targetPc }));
    return;
  }

  edges.push(createEdge("iter-continue", instruction, targetPc, { operandIndex: 1, conditionOperand: instruction.operands[0] }));
  if (layout.sequenceStarts.has(instruction.endPc)) {
    edges.push(createEdge("fallthrough", instruction, instruction.endPc, { operandIndex: null, conditionOperand: instruction.operands[0] }));
  }
}

function addExceptionEdges(layout, exTable, edges, unsupportedBranches) {
  for (let index = 0; index < exTable.length; index++) {
    const entry = exTable[index];
    if (!layout.sequenceStarts.has(entry.start)) {
      unsupportedBranches.push(createExceptionUnsupported(entry, "exception-start-not-instruction-start"));
      continue;
    }
    if (entry.end !== layout.code.length && !layout.sequenceStarts.has(entry.end)) {
      unsupportedBranches.push(createExceptionUnsupported(entry, "exception-end-not-instruction-boundary"));
      continue;
    }
    if (!layout.sequenceStarts.has(entry.handler)) {
      unsupportedBranches.push(createExceptionUnsupported(entry, "exception-handler-not-instruction-start"));
      continue;
    }
    if (entry.start >= entry.end) {
      unsupportedBranches.push(createExceptionUnsupported(entry, "exception-range-empty"));
      continue;
    }

    for (const instruction of layout.instructions) {
      if (instruction.seqPc < entry.start || instruction.seqPc >= entry.end) continue;
      edges.push(createEdge("exception", instruction, entry.handler, {
        operandIndex: null,
        exTableIndex: index,
        exTableEntry: entry,
      }));
    }
  }
}

function createEdge(kind, instruction, targetPc, extra) {
  return {
    kind,
    fromSeqPc: instruction.seqPc,
    fromOpPc: instruction.opPc,
    op: instruction.op,
    endPc: instruction.endPc,
    targetPc,
    ...extra,
  };
}

function createUnsupported(instruction, reason, extra = {}) {
  return {
    seqPc: instruction.seqPc,
    opPc: instruction.opPc,
    op: instruction.op,
    endPc: instruction.endPc,
    reason,
    ...extra,
  };
}

function createExceptionUnsupported(entry, reason) {
  return {
    seqPc: entry.start,
    opPc: entry.start,
    op: null,
    endPc: entry.end,
    targetPc: entry.handler,
    reason,
  };
}

function isDynamic(operand) {
  return !operand || operand.dynamic === true;
}

function isLayout(value) {
  return value && Array.isArray(value.instructions) && value.sequenceStarts instanceof Set;
}

module.exports = { buildBranchCfg };
