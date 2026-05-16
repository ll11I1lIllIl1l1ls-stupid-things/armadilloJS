"use strict";

const { isVMModuleArtifact } = require("../../pipeline");
const { OP, OPERANDS } = require("../../virtualize/opcodes");
const { BytecodeBuffer } = require("../../virtualize/compiler/context");
const { decodeFunctionLayout } = require("../../virtualize/asm/layout");
const { buildOpKinds, deriveOpParam } = require("./ops");
const {
  STRING_PROTECTION_CHUNK_SIZE,
  splitBytesIntoChunks,
  encodeChunkedPayload,
  headerLengthForChunkCount,
} = require("./chunks");
const { matchesExempt } = require("../shared/match");

const textEncoder = new TextEncoder();
const RESERVED_CONST_SLOTS = 4;
const LOGICAL_CFID_SITES = Symbol.for("armadillo.logicalCfidSites");
const PROTECTED_STRING_PAYLOAD_PREFIX = "\u0001";
const MAX_REWRITTEN_FUNCTION_CODE_LENGTH = 0xffff;
// Reserve downstream growth space for later control-flow rewrites after string protection.
// The focused repeated-long-string regression uses this budget to ensure chunked string
// protection still leaves enough room for subsequent transforms instead of consuming the
// raw u16 serializer maximum.
const POST_STRING_PROTECTION_HEADROOM = 10184;
const MAX_STRING_PROTECTION_REWRITTEN_CODE_LENGTH = MAX_REWRITTEN_FUNCTION_CODE_LENGTH - POST_STRING_PROTECTION_HEADROOM;
const SERIALIZABLE_OP_KIND_MAP = Object.freeze({
  xor: "xor",
  add: "add",
  sub: "add",
  rol: "rol",
  ror: "rol",
  mulOdd: "mulOdd",
});

function createStringProtectionTransform(options = {}) {
  if (options.enabled !== true) {
    return {
      name: "string-protection",
      run(module) {
        return module;
      },
    };
  }

  return {
    name: "string-protection",
    run(module, context) {
      if (!isVMModuleArtifact(module)) return module;
      if (!hasInstrumentedFunctions(module, context)) return module;

      const literals = ensureLiteralArray(module);
      const exempt = Array.isArray(options.exempt) ? options.exempt : [];
      const functionNames = collectFunctionNames(module);
      const usage = collectConstantUsage(module, context, exempt, functionNames);

      rewriteProtectedUseSites(module, literals, usage, context, options.seed ?? 0, exempt, functionNames);

      return module;
    },
  };
}

function hasInstrumentedFunctions(module, context) {
  const funcs = module.funcs || module.functions || [];
  return funcs.some((func, funcIdx) => !!func && hasLogicalCfidMetadata(context, funcIdx));
}

function hasLogicalCfidMetadata(context, funcIdx) {
  const meta = context?.cfg?.getFunctionMetadata?.(funcIdx);
  return Array.isArray(meta?.blocks) && meta.blocks.some((block) => Number.isInteger(block.cfid));
}

function ensureLiteralArray(module) {
  const literals = module.constPool?.literals || module.constants;
  if (!Array.isArray(literals)) {
    throw new TypeError("string-protection requires a VM module constant pool");
  }
  if (!module.constPool) module.constPool = { literals };
  module.constPool.literals = literals;
  module.constants = literals;
  return literals;
}

function collectConstantUsage(module, context, exempt = [], functionNames = []) {
  const usage = new Map();
  const funcs = module.funcs || module.functions || [];

  funcs.forEach((func, funcIdx) => {
    if (!func) return;
    const instrumented = hasLogicalCfidMetadata(context, funcIdx) && !matchesExempt(exempt, functionNames[funcIdx]);
    scanFunctionConstants(func.code || [], (constIndex) => {
      if (!Number.isInteger(constIndex) || constIndex < RESERVED_CONST_SLOTS) return;
      let record = usage.get(constIndex);
      if (!record) {
        record = {
          instrumentedFunctionIds: new Set(),
          seenByUninstrumented: false,
          seenByDynamicRuntimeRead: false,
          instrumentedReadCount: 0,
        };
        usage.set(constIndex, record);
      }
      if (instrumented) {
        record.instrumentedFunctionIds.add(funcIdx);
        record.instrumentedReadCount += 1;
      } else {
        record.seenByUninstrumented = true;
      }
    }, null, (constIndex) => {
      if (!instrumented) return;
      usage.hasInstrumentedDynamicRuntimeRead = true;
      if (!Number.isInteger(constIndex) || constIndex < RESERVED_CONST_SLOTS) {
        return;
      }
      let record = usage.get(constIndex);
      if (!record) {
        record = {
          instrumentedFunctionIds: new Set(),
          seenByUninstrumented: false,
          seenByDynamicRuntimeRead: false,
          instrumentedReadCount: 0,
        };
        usage.set(constIndex, record);
      }
      record.seenByDynamicRuntimeRead = true;
    });
  });

  return usage;
}

function scanFunctionConstants(code, visitConstIndex, _visitPlaintextRequiredConstIndex = null, visitDynamicRuntimeRead = null) {
  const layout = decodeFunctionLayout(code instanceof Uint8Array ? code : Uint8Array.from(code || []));
  for (let instructionIndex = 0; instructionIndex < layout.instructions.length; instructionIndex++) {
    const instruction = layout.instructions[instructionIndex];
    const useSites = getProtectedConstUseSites(instruction);
    for (const useSite of useSites) {
      const operand = instruction.operands[useSite.operandIndex];
      if (useSite.dynamic === true || operand?.dynamic === true) {
        if (typeof visitDynamicRuntimeRead === "function") visitDynamicRuntimeRead(inferDynamicConstIndex(layout.instructions, instructionIndex), useSite.kind);
        continue;
      }
      if (Number.isInteger(operand?.value)) visitConstIndex(operand.value, useSite.kind);
    }
  }
}

function inferDynamicConstIndex(instructions, instructionIndex) {
  const previous = instructions[instructionIndex - 1];
  if (!previous || previous.op !== OP.push_i) return null;
  const value = previous.operands[0]?.value;
  return Number.isInteger(value) ? value : null;
}

function rewriteProtectedUseSites(module, literals, usage, context, seed, exempt = [], functionNames = []) {
  const funcs = module.funcs || module.functions || [];
  const firstRewriteByConstIndex = new Map();
  const originalPlaintextsByConstIndex = new Map();
  const protectedReadsByConstIndex = new Map();
  const rewritePlansByFunc = new Map();
  const helperConstCache = {
    indices: new Map(),
    literals,
  };
  literals.forEach((literal, constIndex) => {
    if (typeof literal === "string") originalPlaintextsByConstIndex.set(constIndex, literal);
  });
  funcs.forEach((func, funcIdx) => {
    if (!func || !hasLogicalCfidMetadata(context, funcIdx) || matchesExempt(exempt, functionNames[funcIdx])) return;
    const code = func.code || [];
    const layout = decodeFunctionLayout(code);
    const rewritePlan = [];
    let protectedSiteCount = 0;

    for (const instruction of layout.instructions) {
      const useSites = getProtectedConstUseSites(instruction);
      for (const useSite of useSites) {
        const constOperand = instruction.operands[useSite.operandIndex];
        if (!constOperand || constOperand.dynamic || !Number.isInteger(constOperand.value)) continue;
      const record = usage.get(constOperand.value);
      const plaintext = originalPlaintextsByConstIndex.get(constOperand.value);
      if (plaintext === undefined) continue;
      if (!record || record.instrumentedFunctionIds.has(funcIdx) !== true) continue;

        const block = context?.cfg?.getBlockForPc?.(funcIdx, instruction.seqPc);
        const cfid = deriveProtectedSiteCfid(funcIdx, layout, instruction.seqPc, context, literals);
        if (!Number.isInteger(cfid)) continue;
        const siteMarker = deriveInlineWord(`${funcIdx}:${instruction.seqPc}:${protectedSiteCount}:${block?.blockId ?? 0}`);
        rewritePlan.push({
          seqPc: instruction.seqPc,
          kind: useSite.kind,
          operandIndex: useSite.operandIndex,
          originalConstIndex: constOperand.value,
          plaintext,
          siteMarker,
          cfid,
        });
        protectedReadsByConstIndex.set(
          constOperand.value,
          (protectedReadsByConstIndex.get(constOperand.value) || 0) + 1,
        );
        protectedSiteCount += 1;
      }
    }

    if (rewritePlan.length === 0) return;
    rewritePlansByFunc.set(funcIdx, rewritePlan);
  });

  const selectedRawPlansByFunc = new Map();
  for (const [funcIdx, rewritePlan] of rewritePlansByFunc) {
    const logicalBlockCfidEntries = collectLogicalBlockCfidEntries(funcIdx, context);
    const func = funcs[funcIdx];
    if (!func) continue;
    const selectedPlan = selectRewritePlanThatFits(
      func,
      rewritePlan,
      seed,
      logicalBlockCfidEntries,
      funcIdx,
      usage,
      protectedReadsByConstIndex,
      firstRewriteByConstIndex,
      helperConstCache,
    );
    if (selectedPlan.rawPlan.length === 0) continue;
    selectedRawPlansByFunc.set(funcIdx, selectedPlan.rawPlan);
  }

  const selectedProtectedReadsByConstIndex = new Map();
  for (const rawPlan of selectedRawPlansByFunc.values()) {
    for (const entry of rawPlan) {
      selectedProtectedReadsByConstIndex.set(
        entry.originalConstIndex,
        (selectedProtectedReadsByConstIndex.get(entry.originalConstIndex) || 0) + 1,
      );
    }
  }

  for (const [funcIdx, rawPlan] of selectedRawPlansByFunc) {
    const logicalBlockCfidEntries = collectLogicalBlockCfidEntries(funcIdx, context);
    const func = funcs[funcIdx];
    if (!func) continue;
    const resolvedPlan = resolveRewritePlan(
      rawPlan,
      seed,
      usage,
      selectedProtectedReadsByConstIndex,
      firstRewriteByConstIndex,
      helperConstCache,
      funcIdx,
    );
    applyUseSiteRewrite(func, resolvedPlan, seed, logicalBlockCfidEntries);
  }
}

function resolveRewritePlan(
  rawPlan,
  seed,
  usage,
  selectedProtectedReadsByConstIndex,
  firstRewriteByConstIndex,
  helperConstCache,
  funcIdx,
) {
  return rawPlan.map((entry) => {
    const record = usage.get(entry.originalConstIndex);
    const mustPreserveOriginalSlot = record?.seenByUninstrumented === true
      || record?.seenByDynamicRuntimeRead === true
      || usage.hasInstrumentedDynamicRuntimeRead === true
      || selectedProtectedReadsByConstIndex.get(entry.originalConstIndex) !== record?.instrumentedReadCount;
    const payloadConstIndex = allocateProtectedPayloadSlot(
      helperConstCache.literals,
      firstRewriteByConstIndex,
      entry.originalConstIndex,
      mustPreserveOriginalSlot,
    );
    const protectedPayload = protectLiteralToPayloadString(entry.plaintext, {
      constIndex: payloadConstIndex,
      seed,
      funcIdx,
      siteMarker: entry.siteMarker,
      cfid: entry.cfid,
    });
    helperConstCache.literals[payloadConstIndex] = protectedPayload.encodedPayload;
    return {
      seqPc: entry.seqPc,
      kind: entry.kind,
      operandIndex: entry.operandIndex,
      constIndex: payloadConstIndex,
      siteMarker: entry.siteMarker,
      cfid: entry.cfid,
      funcIdx,
      byteCount: protectedPayload.originalByteLength,
      chunks: protectedPayload.chunks,
      helperConstCache,
    };
  });
}

function applyUseSiteRewrite(func, rewritePlan, seed, logicalBlockCfidEntries = []) {
  const rewriteResult = buildUseSiteRewriteResult(func, rewritePlan, seed, logicalBlockCfidEntries);
  func.code = rewriteResult.rewrittenCode;
  func.exTable = rewriteResult.exTable;
  func.srcMap = rewriteResult.srcMap;
  Object.defineProperty(func, LOGICAL_CFID_SITES, {
    value: rewriteResult.logicalCfidSites,
    writable: true,
    configurable: true,
  });
}

function buildUseSiteRewriteResult(func, rewritePlan, seed, logicalBlockCfidEntries = []) {
  const code = func.code instanceof Uint8Array ? func.code : Uint8Array.from(func.code || []);
  const rewriteBySeqPc = new Map(rewritePlan.map((entry) => [entry.seqPc, entry]));
  const logicalBlockCfidsBySeqPc = new Map(logicalBlockCfidEntries
    .filter((entry) => Number.isInteger(entry.seqPc) && Number.isInteger(entry.cfid))
    .map((entry) => [entry.seqPc, entry.cfid]));
  const layout = decodeFunctionLayout(code);
  const buffer = new BytecodeBuffer();
  const pcMap = new Map();
  const logicalCfidSites = [];
  const instructionBySeqPc = new Map(layout.instructions.map((instruction) => [instruction.seqPc, instruction]));

  for (const instruction of layout.instructions) {
    pcMap.set(instruction.seqPc, buffer.position);
    const blockCfid = logicalBlockCfidsBySeqPc.get(instruction.seqPc);
    if (Number.isInteger(blockCfid)) logicalCfidSites.push({ seqPc: buffer.position, cfid: blockCfid });
    const rewrite = rewriteBySeqPc.get(instruction.seqPc);
    if (rewrite) {
      if (blockCfid !== rewrite.cfid) logicalCfidSites.push({ seqPc: buffer.position, cfid: rewrite.cfid });
      if (rewrite.kind === "push") {
        emitInlineProtectedStringReveal(buffer, rewrite, seed);
      } else {
        emitInlineProtectedOperandRewrite(
          buffer,
          instructionBySeqPc.get(instruction.seqPc) || instruction,
          code,
          rewrite,
          seed,
        );
      }
    } else {
      copyInstruction(buffer, instruction, code);
    }
  }

  const rewrittenCode = buffer.toUint8Array();
  if (rewrittenCode.length > MAX_STRING_PROTECTION_REWRITTEN_CODE_LENGTH) {
    throw new RangeError(
      `string-protection rewritten function code length ${rewrittenCode.length} exceeds budget limit ${MAX_STRING_PROTECTION_REWRITTEN_CODE_LENGTH}`,
    );
  }
  remapRelativeControlFlowOperands(rewrittenCode, layout, pcMap);
  return {
    rewrittenCode,
    exTable: remapExceptionTable(func.exTable || [], pcMap, layout, rewrittenCode.length),
    srcMap: remapSourceMap(func.srcMap || [], pcMap, layout, rewrittenCode.length),
    logicalCfidSites,
  };
}

function selectRewritePlanThatFits(
  func,
  rewritePlan,
  seed,
  logicalBlockCfidEntries = [],
  funcIdx,
  usage,
  protectedReadsByConstIndex,
  firstRewriteByConstIndex,
  helperConstCache,
) {
  if (rewritePlan.length === 0) return rewritePlan;
  for (let protectedCount = rewritePlan.length; protectedCount >= 1; protectedCount--) {
    const selectedProtectedReadsByConstIndex = new Map();
    const candidateRawPlan = rewritePlan.slice(0, protectedCount);
    for (const entry of candidateRawPlan) {
      selectedProtectedReadsByConstIndex.set(
        entry.originalConstIndex,
        (selectedProtectedReadsByConstIndex.get(entry.originalConstIndex) || 0) + 1,
      );
    }
    const candidateLiterals = helperConstCache.literals.slice();
    const candidateHelperConstCache = {
      indices: new Map(helperConstCache.indices),
      literals: candidateLiterals,
    };
    const candidateFirstRewriteByConstIndex = new Map(firstRewriteByConstIndex);
    try {
      const candidateResolvedPlan = resolveRewritePlan(
        candidateRawPlan,
        seed,
        usage,
        selectedProtectedReadsByConstIndex,
        candidateFirstRewriteByConstIndex,
        candidateHelperConstCache,
        funcIdx,
      );
      buildUseSiteRewriteResult(func, candidateResolvedPlan, seed, logicalBlockCfidEntries);
      return { rawPlan: candidateRawPlan };
    } catch (error) {
      if (!(error instanceof RangeError) || !/string-protection rewritten function code length/i.test(error.message)) {
        throw error;
      }
    }
  }
  throw new RangeError(
    `string-protection rewritten function code length exceeds budget limit ${MAX_STRING_PROTECTION_REWRITTEN_CODE_LENGTH} even for a single protected site`,
  );
}

function collectLogicalBlockCfidEntries(funcIdx, context) {
  const functionMeta = context?.cfg?.getFunctionMetadata?.(funcIdx);
  if (!Array.isArray(functionMeta?.blocks)) return [];
  return functionMeta.blocks
    .filter((block) => Number.isInteger(block.startPc) && Number.isInteger(block.cfid))
    .map((block) => ({ seqPc: block.startPc, cfid: block.cfid }));
}

function copyInstruction(buffer, instruction, code) {
  for (let pc = instruction.seqPc; pc < instruction.endPc; pc++) {
    buffer.emitU8(code[pc]);
  }
}

function emitDynamicOperandInstruction(buffer, instruction, code, rewrite) {
  const operand = instruction.operands[rewrite.operandIndex];
  if (!operand || operand.dynamic || operand.occupiesBytes !== true) {
    throw new TypeError(`Cannot dynamic-rewrite protected const operand for opcode ${instruction.op}`);
  }
  buffer.emitOp(OP.dyn);
  buffer.emitU8(rewrite.operandIndex);
  for (let pc = instruction.seqPc; pc < instruction.endPc; pc++) {
    if (pc === operand.pc) {
      pc = operand.endPc - 1;
      continue;
    }
    buffer.emitU8(code[pc]);
  }
}

function emitPatchedInstruction(buffer, instruction, code, rewrite) {
  const operand = instruction.operands[rewrite.operandIndex];
  if (!operand || operand.dynamic || operand.occupiesBytes !== true || operand.type !== "u16") {
    throw new TypeError(`Cannot patch protected const operand for opcode ${instruction.op}`);
  }
  for (let pc = instruction.seqPc; pc < instruction.endPc; pc++) {
    if (pc === operand.pc) {
      buffer.emitU16(rewrite.constIndex);
      pc = operand.endPc - 1;
      continue;
    }
    buffer.emitU8(code[pc]);
  }
}

function remapRelativeControlFlowOperands(code, layout, pcMap) {
  for (const instruction of layout.instructions) {
    const operandIndex = getRelativeOffsetOperandIndex(instruction);
    if (operandIndex < 0) continue;
    const operand = instruction.operands[operandIndex];
    if (!operand || operand.dynamic || operand.occupiesBytes !== true || operand.type !== "i16") continue;
    const newSeqPc = pcMap.get(instruction.seqPc);
    if (!Number.isInteger(newSeqPc)) continue;
    const originalTarget = operand.endPc + operand.value;
    const newTarget = remapPc(originalTarget, pcMap, layout, code.length, { executableTarget: true });
    const newOperandPc = newSeqPc + (operand.pc - instruction.seqPc);
    writeI16(code, newOperandPc, assertI16(newTarget - (newOperandPc + 2), "string-protection remapped branch offset"));
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

function deriveProtectedSiteCfid(funcIdx, layout, seqPc, context, literals) {
  const logicalCfid = getLogicalSiteCfid(funcIdx, seqPc, context);
  if (Number.isInteger(logicalCfid)) return logicalCfid;
  return null;
}

function assertI16(value, label) {
  if (!Number.isInteger(value) || value < -0x8000 || value > 0x7fff) {
    throw new RangeError(`${label} out of i16 range: ${value}`);
  }
  return value | 0;
}

function getLogicalSiteCfid(funcIdx, seqPc, context) {
  const functionMeta = context?.cfg?.getFunctionMetadata?.(funcIdx);
  if (!functionMeta?.graph || !Array.isArray(functionMeta.blocks)) return null;
  const block = functionMeta.graph.getBlockForPc(seqPc);
  if (!block) return null;
  const blockMeta = (functionMeta.blocks || []).find((candidate) => candidate.blockId === block.blockId) || null;
  return Number.isInteger(blockMeta?.cfid) ? blockMeta.cfid : null;
}

function getProtectedConstUseSites(instruction) {
  const descriptors = [];
  if (instruction.op === OP.push) {
    descriptors.push({ operandIndex: 0, kind: "push", dynamic: false });
  } else if (instruction.op === OP.get_prop || instruction.op === OP.set_prop || instruction.op === OP.call_method) {
    descriptors.push({ operandIndex: 0, kind: "name", dynamic: false });
  } else if (instruction.op === OP.def_prop) {
    if (instruction.operands[0]?.value !== 3) descriptors.push({ operandIndex: 1, kind: "name", dynamic: false });
  } else if (instruction.op === OP.load) {
    const scope = instruction.operands[0]?.value;
    if (scope === 2 || scope === 3) descriptors.push({ operandIndex: 1, kind: "global-name", dynamic: false });
  } else if (instruction.op === OP.del) {
    if (instruction.operands[0]?.value === 0) descriptors.push({ operandIndex: 1, kind: "name", dynamic: false });
  }
  return descriptors;
}

function protectLiteralToPayloadString(plaintext, revealState) {
  const { constIndex, seed, funcIdx, siteMarker, cfid } = revealState;
  const plaintextBytes = textEncoder.encode(plaintext);
  const chunks = splitBytesIntoChunks(plaintextBytes, STRING_PROTECTION_CHUNK_SIZE);
  const protectedChunks = chunks.map((chunkBytes, chunkIndex) => {
    const opKinds = buildSerializableOpKinds({ constIndex, cfid, chunkIndex });
    const ciphertext = applyForwardOpChain(chunkBytes, opKinds, {
      seed: normalizeInlineSeed(seed),
      constIndex,
      funcIdx,
      siteMarker,
      cfid,
      chunkIndex,
    });
    return {
      opKinds,
      ciphertext,
      byteLength: chunkBytes.length,
    };
  });
  return {
    encodedPayload: encodeChunkedPayload(
      PROTECTED_STRING_PAYLOAD_PREFIX,
      protectedChunks.map((chunk) => chunk.ciphertext),
    ),
    originalByteLength: plaintextBytes.length,
    chunks: protectedChunks,
  };
}

function collectFunctionNames(module) {
  const funcs = module.funcs || module.functions || [];
  const literals = module.constPool?.literals || module.constants || [];
  return funcs.map((func) => {
    if (typeof func?.name === "string") return func.name;
    if (Number.isInteger(func?.nameIdx) && func.nameIdx >= 0 && typeof literals[func.nameIdx] === "string") return literals[func.nameIdx];
    return null;
  });
}

function buildSerializableOpKinds({ constIndex, cfid, chunkIndex = 0 }) {
  const baseKinds = buildOpKinds({ constIndex, cfid, chunkIndex });
  return baseKinds.map((kind) => {
    const mapped = SERIALIZABLE_OP_KIND_MAP[kind];
    if (!mapped) throw new RangeError(`string protection generated unsupported op kind: ${kind}`);
    return mapped;
  });
}

function chunkCiphertextOffset(rewrite, chunkIndex) {
  const chunkCount = rewrite.chunks.length;
  let offset = headerLengthForChunkCount(chunkCount);
  for (let index = 0; index < chunkIndex; index++) offset += rewrite.chunks[index].byteLength;
  return offset;
}

function chunkAbsoluteByteOffset(rewrite, chunkIndex) {
  let offset = 0;
  for (let index = 0; index < chunkIndex; index++) offset += rewrite.chunks[index].byteLength;
  return offset;
}

function emitInlineProtectedStringReveal(buffer, rewrite, seed) {
  const helperConstCache = rewrite.helperConstCache || { indices: new Map(), literals: [] };
  const stringConstIndex = ensureHelperConstIndex(helperConstCache, rewrite, "String");
  const fromCharCodeConstIndex = ensureHelperConstIndex(helperConstCache, rewrite, "fromCharCode");
  const applyConstIndex = ensureHelperConstIndex(helperConstCache, rewrite, "apply");
  const charCodeAtConstIndex = ensureHelperConstIndex(helperConstCache, rewrite, "charCodeAt");
  const escapeConstIndex = ensureHelperConstIndex(helperConstCache, rewrite, "escape");
  const decodeURIComponentConstIndex = ensureHelperConstIndex(helperConstCache, rewrite, "decodeURIComponent");

  buffer.emitOp(OP.new_arr);
  buffer.emitU16(rewrite.byteCount);

  for (let chunkIndex = 0; chunkIndex < rewrite.chunks.length; chunkIndex++) {
    const chunk = rewrite.chunks[chunkIndex];
    const payloadOffset = chunkCiphertextOffset(rewrite, chunkIndex);
    const outputOffset = chunkAbsoluteByteOffset(rewrite, chunkIndex);
    for (let byteIndex = 0; byteIndex < chunk.byteLength; byteIndex++) {
      buffer.emitOp(OP.dup);
      buffer.emitOp(OP.push_i);
      buffer.emitI16(outputOffset + byteIndex);
      buffer.emitOp(OP.push);
      buffer.emitU16(rewrite.constIndex);
      buffer.emitOp(OP.push_i);
      buffer.emitI16(payloadOffset + byteIndex);
      buffer.emitOp(OP.get_elem);
      buffer.emitOp(OP.push_i);
      buffer.emitI16(0);
      buffer.emitOp(OP.call_method);
      buffer.emitU16(charCodeAtConstIndex);
      buffer.emitU8(1);
      emitInlineByteReveal(buffer, rewrite, seed, chunkIndex, byteIndex);
      buffer.emitOp(OP.set_elem);
      buffer.emitOp(OP.pop);
    }
  }

  emitGlobalLoad(buffer, stringConstIndex);
  buffer.emitOp(OP.get_prop);
  buffer.emitU16(fromCharCodeConstIndex);
  buffer.emitOp(OP.push_spec);
  buffer.emitU8(1);
  buffer.emitOp(OP.rot3);
  buffer.emitOp(OP.call_method);
  buffer.emitU16(applyConstIndex);
  buffer.emitU8(2);

  emitGlobalLoad(buffer, escapeConstIndex);
  buffer.emitOp(OP.swap);
  buffer.emitOp(OP.call);
  buffer.emitU8(0);
  buffer.emitU8(1);

  emitGlobalLoad(buffer, decodeURIComponentConstIndex);
  buffer.emitOp(OP.swap);
  buffer.emitOp(OP.call);
  buffer.emitU8(0);
  buffer.emitU8(1);
}

function emitInlineByteReveal(buffer, rewrite, seed, chunkIndex, _byteIndex) {
  const chunk = rewrite.chunks[chunkIndex];
  for (let stepIndex = chunk.opKinds.length - 1; stepIndex >= 0; stepIndex--) {
    const kind = chunk.opKinds[stepIndex];
    const param = deriveRevealWord({
      seed: normalizeInlineSeed(seed),
      constIndex: rewrite.constIndex,
      funcIdx: rewrite.funcIdx,
      siteMarker: rewrite.siteMarker,
      cfid: rewrite.cfid,
      chunkIndex,
      stepIndex,
    }) & 0xff;
    emitInverseByteOp(buffer, kind, param);
  }
}

function emitInlineProtectedOperandRewrite(buffer, instruction, code, rewrite, seed) {
  emitInlineProtectedStringReveal(buffer, rewrite, seed);
  emitDynamicOperandInstruction(buffer, instruction, code, rewrite);
}

function emitInverseByteOp(buffer, kind, param) {
  if (kind === "xor") {
    emitPushI16(buffer, param);
    emitBinop(buffer, 8);
    return;
  }
  if (kind === "add") {
    emitPushI16(buffer, param);
    emitBinop(buffer, 1);
    emitMaskByte(buffer);
    return;
  }
  if (kind === "rol") {
    emitInverseRol(buffer, param & 7);
    return;
  }
  if (kind === "mulOdd") {
    emitPushI16(buffer, invertOddByte(param | 1));
    emitBinop(buffer, 2);
    emitMaskByte(buffer);
    return;
  }
  throw new RangeError(`Unsupported inline protected string op kind: ${kind}`);
}

function emitInverseRol(buffer, bits) {
  if ((bits & 7) === 0) return;
  buffer.emitOp(OP.dup);
  emitPushI16(buffer, bits & 7);
  emitBinop(buffer, 11);
  buffer.emitOp(OP.swap);
  emitPushI16(buffer, (8 - (bits & 7)) & 7);
  emitBinop(buffer, 9);
  emitBinop(buffer, 7);
  emitMaskByte(buffer);
}

function emitMaskByte(buffer) {
  emitPushI16(buffer, 0xff);
  emitBinop(buffer, 6);
}

function emitGlobalLoad(buffer, constIndex) {
  buffer.emitOp(OP.load);
  buffer.emitU8(2);
  buffer.emitU16(constIndex);
}

function emitPushI16(buffer, value) {
  buffer.emitOp(OP.push_i);
  buffer.emitI16(value);
}

function emitBinop(buffer, opKind) {
  buffer.emitOp(OP.binop);
  buffer.emitU8(opKind);
}

function ensureHelperConstIndex(helperConstCache, rewrite, value) {
  const cacheKey = `helper:${value}`;
  if (helperConstCache.indices.has(cacheKey)) return helperConstCache.indices.get(cacheKey);
  const resolvedLiterals = helperConstCache.literals || rewritePlanLiterals(rewrite);
  const constIndex = resolvedLiterals.length;
  resolvedLiterals.push(value);
  helperConstCache.indices.set(cacheKey, constIndex);
  return constIndex;
}

function rewritePlanLiterals(rewrite) {
  if (!Array.isArray(rewrite.helperConstCache?.literals)) {
    throw new TypeError("Inline protected string reveal requires literal array access");
  }
  return rewrite.helperConstCache.literals;
}

function invertOddByte(value) {
  const normalized = value & 0xff;
  for (let candidate = 1; candidate <= 0xff; candidate += 2) {
    if ((Math.imul(normalized, candidate) & 0xff) === 1) return candidate;
  }
  throw new RangeError(`No inverse for odd byte ${value}`);
}

function applyForwardOpChain(bytes, opKinds, revealState) {
  let out = Uint8Array.from(bytes);
  for (let stepIndex = 0; stepIndex < opKinds.length; stepIndex++) {
    const kind = opKinds[stepIndex];
    const param = deriveRevealWord({ ...revealState, stepIndex });
    out = applyByteOp(out, kind, param);
  }
  return out;
}

function applyByteOp(bytes, kind, param) {
  const out = new Uint8Array(bytes.length);
  const normalized = param & 0xff;
  for (let index = 0; index < bytes.length; index++) {
    const value = bytes[index];
    if (kind === "xor") out[index] = value ^ normalized;
    else if (kind === "add") out[index] = (value + normalized) & 0xff;
    else if (kind === "mulOdd") out[index] = Math.imul(value, normalized | 1) & 0xff;
    else if (kind === "rol") out[index] = rol8(value, normalized & 7);
    else throw new RangeError(`unsupported serialized op kind: ${kind}`);
  }
  return out;
}

function rol8(value, bits) {
  const amount = bits & 7;
  if (amount === 0) return value & 0xff;
  return (((value << amount) | (value >>> (8 - amount))) & 0xff) >>> 0;
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

function deriveRevealWord({ seed, constIndex, funcIdx, siteMarker, cfid, chunkIndex = 0, stepIndex }) {
  let word = mix32(seed >>> 0);
  word ^= Math.imul((constIndex + 1) >>> 0, 0x45d9f3b);
  word = mix32(word);
  word ^= Math.imul((funcIdx + 1) >>> 0, 0x119de1f3);
  word = mix32(word);
  word ^= Math.imul((siteMarker + 1) >>> 0, 0x27d4eb2d);
  word = mix32(word);
  word ^= Math.imul((chunkIndex + 1) >>> 0, 0x6d2b79f5);
  word = mix32(word);
  word ^= Math.imul((stepIndex + 1) >>> 0, 0x165667b1);
  word = mix32(word ^ (cfid >>> 0));
  return word >>> 0;
}

void headerLengthForChunkCount;

function normalizeInlineSeed(seed) {
  return ((seed >>> 0) & 0x7fff) >>> 0;
}

function deriveInlineWord(text) {
  return ((mix32(hashFlowId(text)) & 0x7fff) || 1) >>> 0;
}

function allocateProtectedPayloadSlot(literals, firstRewriteByConstIndex, originalConstIndex, preserveOriginalSlot) {
  if (preserveOriginalSlot === true) {
    const descriptorConstIndex = literals.length;
    literals.push(undefined);
    return descriptorConstIndex;
  }
  const existingSlot = firstRewriteByConstIndex.get(originalConstIndex);
  if (existingSlot === undefined) {
    firstRewriteByConstIndex.set(originalConstIndex, originalConstIndex);
    return originalConstIndex;
  }
  const descriptorConstIndex = literals.length;
  literals.push(undefined);
  return descriptorConstIndex;
}

function hashFlowId(flowId) {
  if (typeof flowId !== "string") return 0;
  let state = 0x811c9dc5;
  for (let index = 0; index < flowId.length; index++) {
    state ^= flowId.charCodeAt(index);
    state = Math.imul(state, 0x01000193) >>> 0;
  }
  return state >>> 0;
}

function deriveSiteMarker(funcIdx, seqPc, siteIndex, blockId) {
  return mix32(
    ((funcIdx + 1) ^ ((seqPc + 1) << 8) ^ ((siteIndex + 1) << 16) ^ ((blockId + 1) << 24)) >>> 0,
  );
}

module.exports = {
  createStringProtectionTransform,
};
