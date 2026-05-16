"use strict";

const { OP, BINOP } = require("../../virtualize/opcodes");
const { compile } = require("../../virtualize/compiler");
const { decodeFunctionLayout } = require("../../virtualize/asm/layout");

const PRIMITIVE_SAFE_BINOPS = new Set([
  BINOP["+"],
  BINOP["-"],
  BINOP["*"],
  BINOP["/"],
  BINOP["%"],
  BINOP["**"],
  BINOP["&"],
  BINOP["|"],
  BINOP["^"],
  BINOP["<<"],
  BINOP[">>"],
  BINOP[">>>"],
  BINOP["==="],
  BINOP["!=="],
  BINOP["<"],
  BINOP["<="],
  BINOP[">"],
  BINOP[">="],
]);
const PRIMITIVE_SAFE_UNOPS = new Set([0, 1, 2, 3, 4, 5]);
const EQUALS_RIGHT_KIND_STRING = 0;
const EQUALS_RIGHT_KIND_NUMBER = 1;
const EQUALS_RIGHT_KIND_BOOLEAN = 2;

const HELPER_NAME = "<equals-condition-helper>";
const HELPER_INDEX_KEY = "__equalsConditionHelperIdx";
const HELPER_SOURCE = `
"use strict";
function __armadilloEqualsConditionHelper(left, strHash, numHash, rightKind, strictMode, blockCfid) {
  const type = typeof (0, left);
  if (strictMode) {
    if (rightKind === 0) {
      if (type !== "string" || strHash === false) return false;
      let modulus = blockCfid | 0;
      if (modulus < 0) modulus = -modulus;
      if (modulus === 0) modulus = 1;
      let stableHash = 0x811c9dc5 | 0;
      let modHash = 0;
      for (let index = 0; index < left.length; index++) {
        const code = left.charCodeAt(index);
        modHash = (modHash + (code % modulus)) | 0;
        stableHash ^= code;
        const leftValue = stableHash | 0;
        const rightValue = 0x01000193 | 0;
        const leftHigh = (leftValue >>> 16) & 0xffff;
        const leftLow = leftValue & 0xffff;
        const rightHigh = (rightValue >>> 16) & 0xffff;
        const rightLow = rightValue & 0xffff;
        stableHash = ((leftLow * rightLow) + (((leftHigh * rightLow + leftLow * rightHigh) << 16) >>> 0)) | 0;
      }
      let mixed = modHash | 0;
      let leftValue = stableHash | 0;
      let leftHigh = (leftValue >>> 16) & 0xffff;
      let leftLow = leftValue & 0xffff;
      let rightHigh = (0x9e3779b1 >>> 16) & 0xffff;
      let rightLow = 0x9e3779b1 & 0xffff;
      mixed = (mixed ^ ((leftLow * rightLow) + (((leftHigh * rightLow + leftLow * rightHigh) << 16) >>> 0))) | 0;
      mixed ^= mixed >>> 16;
      leftValue = 0x7feb352d | 0;
      leftHigh = (mixed >>> 16) & 0xffff;
      leftLow = mixed & 0xffff;
      rightHigh = (leftValue >>> 16) & 0xffff;
      rightLow = leftValue & 0xffff;
      mixed = ((leftLow * rightLow) + (((leftHigh * rightLow + leftLow * rightHigh) << 16) >>> 0)) | 0;
      mixed ^= mixed >>> 15;
      leftValue = 0x846ca68b | 0;
      leftHigh = (mixed >>> 16) & 0xffff;
      leftLow = mixed & 0xffff;
      rightHigh = (leftValue >>> 16) & 0xffff;
      rightLow = leftValue & 0xffff;
      mixed = ((leftLow * rightLow) + (((leftHigh * rightLow + leftLow * rightHigh) << 16) >>> 0)) | 0;
      mixed ^= mixed >>> 16;
      return (mixed | 0) === strHash;
    }
    if (rightKind === 1 || rightKind === 2) {
      if (numHash === false) return false;
      if (rightKind === 1 && type !== "number") return false;
      if (rightKind === 2 && type !== "boolean") return false;
    } else {
      return false;
    }
  } else {
    if (left === null) return false;
    if (type === "undefined") return false;
  }
  if (type === "string") {
    if (strHash !== false) {
      let modulus = blockCfid | 0;
      if (modulus < 0) modulus = -modulus;
      if (modulus === 0) modulus = 1;
      let stableHash = 0x811c9dc5 | 0;
      let modHash = 0;
      for (let index = 0; index < left.length; index++) {
        const code = left.charCodeAt(index);
        modHash = (modHash + (code % modulus)) | 0;
        stableHash ^= code;
        const leftValue = stableHash | 0;
        const rightValue = 0x01000193 | 0;
        const leftHigh = (leftValue >>> 16) & 0xffff;
        const leftLow = leftValue & 0xffff;
        const rightHigh = (rightValue >>> 16) & 0xffff;
        const rightLow = rightValue & 0xffff;
        stableHash = ((leftLow * rightLow) + (((leftHigh * rightLow + leftLow * rightHigh) << 16) >>> 0)) | 0;
      }
      let mixed = modHash | 0;
      let leftValue = stableHash | 0;
      let leftHigh = (leftValue >>> 16) & 0xffff;
      let leftLow = leftValue & 0xffff;
      let rightHigh = (0x9e3779b1 >>> 16) & 0xffff;
      let rightLow = 0x9e3779b1 & 0xffff;
      mixed = (mixed ^ ((leftLow * rightLow) + (((leftHigh * rightLow + leftLow * rightHigh) << 16) >>> 0))) | 0;
      mixed ^= mixed >>> 16;
      leftValue = 0x7feb352d | 0;
      leftHigh = (mixed >>> 16) & 0xffff;
      leftLow = mixed & 0xffff;
      rightHigh = (leftValue >>> 16) & 0xffff;
      rightLow = leftValue & 0xffff;
      mixed = ((leftLow * rightLow) + (((leftHigh * rightLow + leftLow * rightHigh) << 16) >>> 0)) | 0;
      mixed ^= mixed >>> 15;
      leftValue = 0x846ca68b | 0;
      leftHigh = (mixed >>> 16) & 0xffff;
      leftLow = mixed & 0xffff;
      rightHigh = (leftValue >>> 16) & 0xffff;
      rightLow = leftValue & 0xffff;
      mixed = ((leftLow * rightLow) + (((leftHigh * rightLow + leftLow * rightHigh) << 16) >>> 0)) | 0;
      mixed ^= mixed >>> 16;
      if ((mixed | 0) === strHash) return true;
    }
    if (numHash === false) return false;
    const numeric = Number(left);
    if (numeric !== numeric) return false;
    let mixed;
    if (numeric === 1 / 0 || numeric === -(1 / 0)) {
      const modVal = numeric > 0 ? blockCfid | 0 : ((blockCfid | 0) + 1) | 0;
      const leftValue = modVal | 0;
      const rightValue = numeric > 0 ? 0x7fffffff : -0x80000000;
      const leftHigh = (rightValue >>> 16) & 0xffff;
      const leftLow = rightValue & 0xffff;
      const rightHigh = (0x9e3779b1 >>> 16) & 0xffff;
      const rightLow = 0x9e3779b1 & 0xffff;
      mixed = (leftValue ^ ((leftLow * rightLow) + (((leftHigh * rightLow + leftLow * rightHigh) << 16) >>> 0))) | 0;
      mixed ^= mixed >>> 16;
      let seed = 0x7feb352d | 0;
      let high = (mixed >>> 16) & 0xffff;
      let low = mixed & 0xffff;
      let seedHigh = (seed >>> 16) & 0xffff;
      let seedLow = seed & 0xffff;
      mixed = ((low * seedLow) + (((high * seedLow + low * seedHigh) << 16) >>> 0)) | 0;
      mixed ^= mixed >>> 15;
      seed = 0x846ca68b | 0;
      high = (mixed >>> 16) & 0xffff;
      low = mixed & 0xffff;
      seedHigh = (seed >>> 16) & 0xffff;
      seedLow = seed & 0xffff;
      mixed = ((low * seedLow) + (((high * seedLow + low * seedHigh) << 16) >>> 0)) | 0;
      mixed ^= mixed >>> 16;
      return (mixed | 0) === numHash;
    }
    let modulus = blockCfid | 0;
    if (modulus < 0) modulus = -modulus;
    if (modulus === 0) modulus = 1;
    const mod = ((numeric % modulus) + modulus) % modulus;
    let numberHash;
    const truncated = (numeric * 0x10000) | 0;
    const hashInput = numeric | 0;
    let hashValue = truncated | 0;
    let hashHigh = (hashValue >>> 16) & 0xffff;
    let hashLow = hashValue & 0xffff;
    let hashSeedHigh = (0x9e3779b1 >>> 16) & 0xffff;
    let hashSeedLow = 0x9e3779b1 & 0xffff;
    numberHash = (hashInput ^ ((hashLow * hashSeedLow) + (((hashHigh * hashSeedLow + hashLow * hashSeedHigh) << 16) >>> 0))) | 0;
    numberHash ^= numberHash >>> 16;
    let seed = 0x7feb352d | 0;
    let high = (numberHash >>> 16) & 0xffff;
    let low = numberHash & 0xffff;
    let seedHigh = (seed >>> 16) & 0xffff;
    let seedLow = seed & 0xffff;
    numberHash = ((low * seedLow) + (((high * seedLow + low * seedHigh) << 16) >>> 0)) | 0;
    numberHash ^= numberHash >>> 15;
    seed = 0x846ca68b | 0;
    high = (numberHash >>> 16) & 0xffff;
    low = numberHash & 0xffff;
    seedHigh = (seed >>> 16) & 0xffff;
    seedLow = seed & 0xffff;
    numberHash = ((low * seedLow) + (((high * seedLow + low * seedHigh) << 16) >>> 0)) | 0;
    numberHash ^= numberHash >>> 16;
    numberHash |= 0;
    const leftValue = mod | 0;
    const rightValue = numberHash | 0;
    const leftHigh = (rightValue >>> 16) & 0xffff;
    const leftLow = rightValue & 0xffff;
    const rightHigh = (0x9e3779b1 >>> 16) & 0xffff;
    const rightLow = 0x9e3779b1 & 0xffff;
    mixed = (leftValue ^ ((leftLow * rightLow) + (((leftHigh * rightLow + leftLow * rightHigh) << 16) >>> 0))) | 0;
    mixed ^= mixed >>> 16;
    seed = 0x7feb352d | 0;
    high = (mixed >>> 16) & 0xffff;
    low = mixed & 0xffff;
    seedHigh = (seed >>> 16) & 0xffff;
    seedLow = seed & 0xffff;
    mixed = ((low * seedLow) + (((high * seedLow + low * seedHigh) << 16) >>> 0)) | 0;
    mixed ^= mixed >>> 15;
    seed = 0x846ca68b | 0;
    high = (mixed >>> 16) & 0xffff;
    low = mixed & 0xffff;
    seedHigh = (seed >>> 16) & 0xffff;
    seedLow = seed & 0xffff;
    mixed = ((low * seedLow) + (((high * seedLow + low * seedHigh) << 16) >>> 0)) | 0;
    mixed ^= mixed >>> 16;
    return (mixed | 0) === numHash;
  }
  if (type === "boolean" || type === "number") {
    if (numHash === false) return false;
    const numeric = type === "boolean" ? (left ? 1 : 0) : left;
    if (numeric !== numeric) return false;
    let mixed;
    if (numeric === 1 / 0 || numeric === -(1 / 0)) {
      const modVal = numeric > 0 ? blockCfid | 0 : ((blockCfid | 0) + 1) | 0;
      const leftValue = modVal | 0;
      const rightValue = numeric > 0 ? 0x7fffffff : -0x80000000;
      const leftHigh = (rightValue >>> 16) & 0xffff;
      const leftLow = rightValue & 0xffff;
      const rightHigh = (0x9e3779b1 >>> 16) & 0xffff;
      const rightLow = 0x9e3779b1 & 0xffff;
      mixed = (leftValue ^ ((leftLow * rightLow) + (((leftHigh * rightLow + leftLow * rightHigh) << 16) >>> 0))) | 0;
      mixed ^= mixed >>> 16;
      let seed = 0x7feb352d | 0;
      let high = (mixed >>> 16) & 0xffff;
      let low = mixed & 0xffff;
      let seedHigh = (seed >>> 16) & 0xffff;
      let seedLow = seed & 0xffff;
      mixed = ((low * seedLow) + (((high * seedLow + low * seedHigh) << 16) >>> 0)) | 0;
      mixed ^= mixed >>> 15;
      seed = 0x846ca68b | 0;
      high = (mixed >>> 16) & 0xffff;
      low = mixed & 0xffff;
      seedHigh = (seed >>> 16) & 0xffff;
      seedLow = seed & 0xffff;
      mixed = ((low * seedLow) + (((high * seedLow + low * seedHigh) << 16) >>> 0)) | 0;
      mixed ^= mixed >>> 16;
      return (mixed | 0) === numHash;
    }
    let modulus = blockCfid | 0;
    if (modulus < 0) modulus = -modulus;
    if (modulus === 0) modulus = 1;
    const mod = ((numeric % modulus) + modulus) % modulus;
    let numberHash;
    const truncated = (numeric * 0x10000) | 0;
    const hashInput = numeric | 0;
    let hashValue = truncated | 0;
    let hashHigh = (hashValue >>> 16) & 0xffff;
    let hashLow = hashValue & 0xffff;
    let hashSeedHigh = (0x9e3779b1 >>> 16) & 0xffff;
    let hashSeedLow = 0x9e3779b1 & 0xffff;
    numberHash = (hashInput ^ ((hashLow * hashSeedLow) + (((hashHigh * hashSeedLow + hashLow * hashSeedHigh) << 16) >>> 0))) | 0;
    numberHash ^= numberHash >>> 16;
    let seed = 0x7feb352d | 0;
    let high = (numberHash >>> 16) & 0xffff;
    let low = numberHash & 0xffff;
    let seedHigh = (seed >>> 16) & 0xffff;
    let seedLow = seed & 0xffff;
    numberHash = ((low * seedLow) + (((high * seedLow + low * seedHigh) << 16) >>> 0)) | 0;
    numberHash ^= numberHash >>> 15;
    seed = 0x846ca68b | 0;
    high = (numberHash >>> 16) & 0xffff;
    low = numberHash & 0xffff;
    seedHigh = (seed >>> 16) & 0xffff;
    seedLow = seed & 0xffff;
    numberHash = ((low * seedLow) + (((high * seedLow + low * seedHigh) << 16) >>> 0)) | 0;
    numberHash ^= numberHash >>> 16;
    numberHash |= 0;
    const leftValue = mod | 0;
    const rightValue = numberHash | 0;
    const leftHigh = (rightValue >>> 16) & 0xffff;
    const leftLow = rightValue & 0xffff;
    const rightHigh = (0x9e3779b1 >>> 16) & 0xffff;
    const rightLow = 0x9e3779b1 & 0xffff;
    mixed = (leftValue ^ ((leftLow * rightLow) + (((leftHigh * rightLow + leftLow * rightHigh) << 16) >>> 0))) | 0;
    mixed ^= mixed >>> 16;
    seed = 0x7feb352d | 0;
    high = (mixed >>> 16) & 0xffff;
    low = mixed & 0xffff;
    seedHigh = (seed >>> 16) & 0xffff;
    seedLow = seed & 0xffff;
    mixed = ((low * seedLow) + (((high * seedLow + low * seedHigh) << 16) >>> 0)) | 0;
    mixed ^= mixed >>> 15;
    seed = 0x846ca68b | 0;
    high = (mixed >>> 16) & 0xffff;
    low = mixed & 0xffff;
    seedHigh = (seed >>> 16) & 0xffff;
    seedLow = seed & 0xffff;
    mixed = ((low * seedLow) + (((high * seedLow + low * seedHigh) << 16) >>> 0)) | 0;
    mixed ^= mixed >>> 16;
    return (mixed | 0) === numHash;
  }
  return false;
}
__armadilloEqualsConditionHelper;
`;
const HELPER_SOURCE_NAME = "<equals-condition-helper-source>";
const HELPER_SOURCE_FUNCTION_NAME = "__armadilloEqualsConditionHelper";

function createEqualsConditionTransformer() {
  return {
    match({ module, layout, branchInstruction }) {
      if (!layout || !branchInstruction || branchInstruction.op !== OP.jmp_if) return null;
      const instructions = layout.instructions;
      const branchIndex = instructions.findIndex((instruction) => instruction.seqPc === branchInstruction.seqPc);
      if (branchIndex < 3) return null;
      const compare = instructions[branchIndex - 1];
      const literal = instructions[branchIndex - 2];
      if (!compare || compare.op !== OP.binop) return null;
      const opKind = compare.operands[0]?.value;
      if (opKind !== BINOP["=="] && opKind !== BINOP["!="] && opKind !== BINOP["==="] && opKind !== BINOP["!=="]) return null;
      const literalValue = readInstructionLiteral(module, literal);
      if (!isPrimitiveEqualityRight(literalValue)) return null;
      if (!isPrimitiveSafeLeftProducer(module, instructions, branchIndex - 3)) return null;
      return {
        compareOpKind: opKind,
        literalIndex: literal.operands[0]?.value,
        rightString: typeof literalValue === "string" ? literalValue : undefined,
        rightValue: literalValue,
        strict: opKind === BINOP["==="] || opKind === BINOP["!=="],
        suppressedSeqPcs: [literal.seqPc, compare.seqPc],
      };
    },

    matches(args) {
      return this.match(args) !== null;
    },

    emit(buffer, module, emitI32Push, match, blockCfid) {
      const helperIdx = ensureHelperFunction(module);
      buffer.emitOp(OP.make_func);
      buffer.emitU16(helperIdx);
      buffer.emitOp(OP.swap);
      const payload = precomputeEqualsRight(match.rightValue, blockCfid | 0);
      emitPayloadValue(buffer, module, emitI32Push, payload.strHash);
      emitPayloadValue(buffer, module, emitI32Push, payload.numHash);
      emitI32Push(buffer, module, payload.rightKind | 0);
      emitI32Push(buffer, module, match.strict ? 1 : 0);
      emitI32Push(buffer, module, blockCfid | 0);
      buffer.emitOp(OP.call);
      buffer.emitU8(0);
      buffer.emitU8(6);
      if (match.compareOpKind === BINOP["!="] || match.compareOpKind === BINOP["!=="]) {
        buffer.emitOp(OP.unop);
        buffer.emitU8(2);
      }
    },
  };
}

function ensureHelperFunction(module) {
  if (Number.isInteger(module[HELPER_INDEX_KEY])) return module[HELPER_INDEX_KEY];
  const funcs = module.funcs || module.functions || [];
  const existingIndex = funcs.findIndex((func) => func && func.name === HELPER_NAME);
  if (existingIndex >= 0) {
    module[HELPER_INDEX_KEY] = existingIndex;
    return existingIndex;
  }

  const helperIndex = createHelperFunction(module);
  module[HELPER_INDEX_KEY] = helperIndex;
  return helperIndex;
}

function createHelperFunction(module) {
  const helperModule = compile(HELPER_SOURCE, HELPER_SOURCE_NAME);
  const helperFuncs = helperModule.functions || helperModule.funcs || [];
  const sourceHelperIndex = helperFuncs.findIndex((func) => func && func.name === HELPER_SOURCE_FUNCTION_NAME);
  if (sourceHelperIndex < 0) throw new Error("compiled string equality helper function not found");

  const targetFuncs = module.funcs || module.functions || [];
  const functionIndexMap = new Map();
  for (let index = 0; index < helperFuncs.length; index++) {
    functionIndexMap.set(index, targetFuncs.length + index);
  }

  const relocated = helperFuncs.map((func, index) => relocateHelperFunction(module, helperModule, func, functionIndexMap, index === sourceHelperIndex));
  for (const func of relocated) targetFuncs.push(func);
  module.funcs = targetFuncs;
  module.functions = targetFuncs;
  return functionIndexMap.get(sourceHelperIndex);
}

function relocateHelperFunction(targetModule, helperModule, func, functionIndexMap, isEntryHelper) {
  const out = cloneValue(func);
  out.name = isEntryHelper ? HELPER_NAME : func.name;
  out.code = relocateHelperCode(targetModule, helperModule, func.code || [], functionIndexMap);
  return out;
}

function relocateHelperCode(targetModule, helperModule, code, functionIndexMap) {
  const bytes = Array.from(code || []);
  const layout = decodeFunctionLayout(Uint8Array.from(bytes));
  const helperLiterals = helperModule.constPool?.literals || helperModule.constants || [];
  for (const instruction of layout.instructions) {
    if (instruction.prefixes.length > 0) throw new Error("compiled string equality helper must not contain dyn prefixes");
    if (instruction.op === OP.push) {
      const operand = instruction.operands[0];
      const literal = helperLiterals[operand.value];
      const relocatedIndex = ensureLiteral(targetModule, literal);
      writeU16(bytes, operand.pc, relocatedIndex);
    } else if ((instruction.op === OP.load || instruction.op === OP.store) && instruction.operands[0]?.value >= 2) {
      const operand = instruction.operands[1];
      const literal = helperLiterals[operand.value];
      const relocatedIndex = ensureLiteral(targetModule, literal);
      writeU16(bytes, operand.pc, relocatedIndex);
    } else if (
      instruction.op === OP.get_prop
      || instruction.op === OP.set_prop
      || instruction.op === OP.del
      || instruction.op === OP.get_private
      || instruction.op === OP.set_private
      || instruction.op === OP.call_method
      || instruction.op === OP.def_prop
      || instruction.op === OP.make_class
    ) {
      const operand = instruction.operands.find((item) => item.type === "u16");
      const literal = helperLiterals[operand.value];
      const relocatedIndex = ensureLiteral(targetModule, literal);
      writeU16(bytes, operand.pc, relocatedIndex);
    } else if (instruction.op === OP.make_func) {
      const operand = instruction.operands[0];
      const relocatedIndex = functionIndexMap.get(operand.value);
      if (!Number.isInteger(relocatedIndex)) throw new Error(`missing relocated helper function index ${operand.value}`);
      writeU16(bytes, operand.pc, relocatedIndex);
    }
  }
  return Uint8Array.from(bytes);
}

function writeU16(bytes, position, value) {
  if (!Number.isInteger(value) || value < 0 || value > 0xffff) throw new RangeError(`u16 out of range: ${value}`);
  bytes[position] = value & 0xff;
  bytes[position + 1] = (value >>> 8) & 0xff;
}

function ensureLiteral(module, value) {
  const literals = module.constPool?.literals || module.constants || [];
  const index = literals.findIndex((literal) => Object.is(literal, value));
  if (index >= 0) return index;
  if (literals.length >= 0xffff) throw new RangeError("string equality literal pool index out of u16 range");
  literals.push(value);
  if (module.constPool) module.constPool.literals = literals;
  module.constants = literals;
  return literals.length - 1;
}

function emitPayloadValue(buffer, module, emitI32Push, value) {
  if (value === false) {
    buffer.emitOp(OP.push);
    buffer.emitU16(ensureLiteral(module, false));
    return;
  }
  emitI32Push(buffer, module, value | 0);
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

function readLiteral(module, index) {
  if (!Number.isInteger(index)) return undefined;
  const literals = module.constPool?.literals || module.constants || [];
  return literals[index];
}

function readInstructionLiteral(module, instruction) {
  if (!instruction) return undefined;
  if (instruction.op === OP.push_i) return instruction.operands[0]?.value;
  if (instruction.op === OP.push) return readLiteral(module, instruction.operands[0]?.value);
  return undefined;
}

function isPrimitiveEqualityRight(value) {
  return typeof value === "string"
    || typeof value === "number"
    || typeof value === "boolean";
}

function isPrimitiveSafeLeftProducer(module, instructions, index) {
  const instruction = instructions[index];
  if (!instruction) return false;
  if (instruction.op === OP.push_i) return true;
  if (instruction.op === OP.push) {
    const value = readLiteral(module, instruction.operands[0]?.value);
    return value === null
      || value === undefined
      || typeof value === "string"
      || typeof value === "number"
      || typeof value === "boolean";
  }
  if (instruction.op === OP.binop) {
    if (!PRIMITIVE_SAFE_BINOPS.has(instruction.operands[0]?.value)) return false;
    const rightStart = findExpressionStart(instructions, index - 1);
    if (rightStart < 0) return false;
    const leftStart = findExpressionStart(instructions, rightStart - 1);
    if (leftStart < 0) return false;
    return isPrimitiveSafeLeftProducer(module, instructions, leftStart)
      && isPrimitiveSafeLeftProducer(module, instructions, rightStart);
  }
  if (instruction.op === OP.unop) {
    if (!PRIMITIVE_SAFE_UNOPS.has(instruction.operands[0]?.value)) return false;
    const operandStart = findExpressionStart(instructions, index - 1);
    if (operandStart < 0) return false;
    return isPrimitiveSafeLeftProducer(module, instructions, operandStart);
  }
  return false;
}

function findExpressionStart(instructions, endIndex) {
  let needed = 1;
  for (let index = endIndex; index >= 0; index--) {
    const instruction = instructions[index];
    needed -= producedValueCount(instruction);
    if (needed <= 0) return index;
    needed += consumedValueCount(instruction);
  }
  return -1;
}

function producedValueCount(instruction) {
  if (!instruction) return 0;
  if (instruction.op === OP.pop || instruction.op === OP.store || instruction.op === OP.set_prop || instruction.op === OP.set_elem || instruction.op === OP.throw) return 0;
  if (instruction.op === OP.jmp || instruction.op === OP.jmp_if || instruction.op === OP.ret) return 0;
  return 1;
}

function consumedValueCount(instruction) {
  if (!instruction) return 0;
  if (instruction.op === OP.binop) return 2;
  if (instruction.op === OP.unop) return 1;
  return 0;
}

function precomputeEqualsRight(value, blockCfid) {
  if (typeof value === "string") {
    const strHash = mixStringForFlow(value, blockCfid);
    const numberValue = Number(value);
    const numHash = Number.isNaN(numberValue) ? false : numMixVal(numberValue, blockCfid);
    return { strHash, numHash, rightKind: EQUALS_RIGHT_KIND_STRING };
  }
  if (typeof value === "boolean") {
    return { strHash: false, numHash: numMixVal(value ? 1 : 0, blockCfid), rightKind: EQUALS_RIGHT_KIND_BOOLEAN };
  }
  if (typeof value === "number") {
    return {
      strHash: false,
      numHash: Number.isNaN(value) ? false : numMixVal(value, blockCfid),
      rightKind: EQUALS_RIGHT_KIND_NUMBER,
    };
  }
  return { strHash: false, numHash: false, rightKind: EQUALS_RIGHT_KIND_STRING };
}

function mixStringForFlow(value, blockCfid) {
  const text = String(value);
  return mix32(forEachModString(text, blockCfid), stableStringHash(text));
}

function forEachModString(text, blockCfid) {
  const modulus = normalizeModulus(blockCfid);
  let acc = 0;
  for (let index = 0; index < text.length; index++) {
    acc = (acc + (text.charCodeAt(index) % modulus)) | 0;
  }
  return acc | 0;
}

function numMixVal(value, blockCfid) {
  if (Number.isNaN(value)) return null;
  if (!Number.isFinite(value)) {
    const modVal = value > 0 ? blockCfid | 0 : ((blockCfid | 0) + 1) | 0;
    return mix32(modVal, value > 0 ? 0x7fffffff : -0x80000000);
  }
  const modulus = normalizeModulus(blockCfid);
  const mod = ((value % modulus) + modulus) % modulus;
  return mix32(mod | 0, numberHash(value));
}

function normalizeModulus(blockCfid) {
  const value = Math.abs(blockCfid | 0);
  return value === 0 ? 1 : value;
}

function stableStringHash(text) {
  let hash = 0x811c9dc5 | 0;
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index);
    hash = imul32(hash, 0x01000193) | 0;
  }
  return hash | 0;
}

function numberHash(value) {
  return mix32(value | 0, (value * 0x10000) | 0);
}

function mix32(left, right) {
  let mixed = (left | 0) ^ imul32(right | 0, 0x9e3779b1);
  mixed ^= mixed >>> 16;
  mixed = imul32(mixed, 0x7feb352d) | 0;
  mixed ^= mixed >>> 15;
  mixed = imul32(mixed, 0x846ca68b) | 0;
  mixed ^= mixed >>> 16;
  return mixed | 0;
}

function imul32(left, right) {
  const leftValue = left | 0;
  const rightValue = right | 0;
  const leftHigh = (leftValue >>> 16) & 0xffff;
  const leftLow = leftValue & 0xffff;
  const rightHigh = (rightValue >>> 16) & 0xffff;
  const rightLow = rightValue & 0xffff;
  return ((leftLow * rightLow) + (((leftHigh * rightLow + leftLow * rightHigh) << 16) >>> 0)) | 0;
}

module.exports = {
  createEqualsConditionTransformer,
  mixStringForFlow,
  numMixVal,
  precomputeEqualsRight,
};
