"use strict";

const { OP, OPERANDS, assertDynOperandIndex } = require("../opcodes");

function decodeFunctionLayout(code) {
  const bytes = normalizeCode(code);
  const instructions = [];
  const bySeqPc = new Map();
  const sequenceStarts = new Set();

  let pc = 0;
  while (pc < bytes.length) {
    const instruction = decodeInstruction(bytes, pc);
    instructions.push(instruction);
    bySeqPc.set(instruction.seqPc, instruction);
    sequenceStarts.add(instruction.seqPc);
    pc = instruction.endPc;
  }

  return { code: bytes, instructions, bySeqPc, sequenceStarts };
}

function decodeInstruction(code, seqPc) {
  const bytes = normalizeCode(code);
  if (!Number.isInteger(seqPc) || seqPc < 0 || seqPc >= bytes.length) {
    throw new RangeError(`Invalid instruction sequence PC ${seqPc}`);
  }

  let pc = seqPc;
  let dynMask = 0;
  let prefixCount = 0;
  const prefixes = [];

  while (bytes[pc] === OP.dyn) {
    if (++prefixCount > 8) throw new RangeError("dyn chain too long");
    requireBytes(bytes, pc, 2, "dyn prefix");
    const which = bytes[pc + 1];
    assertDynOperandIndex(which);
    prefixes.push({ pc, which });
    dynMask |= 1 << which;
    pc += 2;
  }

  requireBytes(bytes, pc, 1, "opcode");
  const opPc = pc;
  const op = bytes[pc++];
  const operandTypes = OPERANDS[op];
  if (!operandTypes || op === OP.dyn) throw new TypeError(`Unsupported opcode ${op}`);

  const operands = [];
  for (let index = 0; index < operandTypes.length; index++) {
    const result = decodeOperand(bytes, pc, index, operandTypes[index], dynMask);
    pc = result.nextPc;
    operands.push(result.operand);
  }

  const iterKind = operands[0] && operands[0].value;
  if (op === OP.iter_op && (iterKind === undefined || iterKind === 1 || iterKind === 4)) {
    const result = decodeOperand(bytes, pc, operands.length, "i16", dynMask);
    pc = result.nextPc;
    operands.push(result.operand);
  }

  return {
    seqPc,
    opPc,
    endPc: pc,
    length: pc - seqPc,
    op,
    dynMask,
    prefixCount,
    prefixes,
    operands,
  };
}

function decodeOperand(code, pc, index, type, dynMask) {
  const dynamic = (dynMask & (1 << index)) !== 0;
  if (dynamic) {
    return {
      nextPc: pc,
      operand: { index, type, dynamic: true, occupiesBytes: false, pc: null, endPc: null, value: undefined },
    };
  }

  const size = operandSize(type);
  requireBytes(code, pc, size, `${type} operand`);
  const nextPc = pc + size;
  return {
    nextPc,
    operand: { index, type, dynamic: false, occupiesBytes: true, pc, endPc: nextPc, value: readOperand(code, pc, type) },
  };
}

function readOperand(code, pc, type) {
  const bytes = normalizeCode(code);
  if (type === "u8") return bytes[pc];
  if (type === "u16") return bytes[pc] | (bytes[pc + 1] << 8);
  if (type === "i16") {
    const value = bytes[pc] | (bytes[pc + 1] << 8);
    return value >= 0x8000 ? value - 0x10000 : value;
  }
  throw new TypeError(`Unsupported operand type ${type}`);
}

function operandSize(type) {
  if (type === "u8") return 1;
  if (type === "u16" || type === "i16") return 2;
  throw new TypeError(`Unsupported operand type ${type}`);
}

function requireBytes(code, pc, size, label) {
  if (pc + size > code.length) throw new RangeError(`Truncated ${label} at pc ${pc}`);
}

function normalizeCode(code) {
  if (code instanceof Uint8Array) return code;
  if (Array.isArray(code)) return Uint8Array.from(code);
  throw new TypeError("code must be a Uint8Array or byte array");
}

module.exports = { decodeFunctionLayout, decodeInstruction, operandSize, readOperand };
