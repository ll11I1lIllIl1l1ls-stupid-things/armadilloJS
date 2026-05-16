"use strict";

const { OP } = require("../../virtualize/opcodes");
const { decodeFunctionLayout } = require("../../virtualize/asm/layout");

function reserveHiddenCfidLocal(func, options = {}) {
  const shifted = cloneValue(func);
  shifted.localCount = readLocalCount(func) + 1;
  shifted.params = shiftSlotList(func.params);
  shifted.rest = shiftSlot(func.rest);
  shifted.argumentsSlot = shiftSlot(func.argumentsSlot);
  shifted.selfNameSlot = shiftSlot(func.selfNameSlot);
  shifted.upvalues = shiftUpvalues(func.upvalues || [], options.shiftLocalUpvalues !== false);
  shifted.code = shiftLocalBytecode(func.code || []);
  return shifted;
}

function readLocalCount(func) {
  if (Number.isInteger(func.localCount)) return func.localCount;
  if (Array.isArray(func.localNames)) return func.localNames.length;
  return 0;
}

function shiftSlotList(slots) {
  if (!Array.isArray(slots)) return slots;
  return slots.map(shiftSlot);
}

function shiftSlot(slot) {
  return Number.isInteger(slot) && slot >= 0 ? slot + 1 : slot;
}

function shiftUpvalues(upvalues, shiftLocalUpvalues) {
  return upvalues.map((upvalue) => {
    const shifted = cloneValue(upvalue);
    if (shifted && shiftLocalUpvalues && (shifted.fromLocal === true || shifted.scope === 0)) shifted.index = shiftSlot(shifted.index);
    return shifted;
  });
}

function shiftLocalBytecode(code) {
  const bytes = code instanceof Uint8Array ? Uint8Array.from(code) : Uint8Array.from(code);
  const layout = decodeFunctionLayout(bytes);

  for (const instruction of layout.instructions) {
    if (instruction.op !== OP.load && instruction.op !== OP.store) continue;
    const scope = instruction.operands[0];
    const index = instruction.operands[1];
    if (scope.dynamic) {
      throw new Error(`control-flow hidden CFID local reservation cannot shift dynamic load/store scope operand at pc ${instruction.seqPc}`);
    }
    if (scope.value !== 0) continue;
    if (index.dynamic) {
      throw new Error(`control-flow hidden CFID local reservation cannot shift dynamic load/store local index operand at pc ${instruction.seqPc}`);
    }
    writeU16(bytes, index.pc, index.value + 1);
  }

  return bytes;
}

function writeU16(bytes, pc, value) {
  if (!Number.isInteger(value) || value < 0 || value > 0xffff) throw new RangeError(`local index out of u16 range: ${value}`);
  bytes[pc] = value & 0xff;
  bytes[pc + 1] = (value >> 8) & 0xff;
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

module.exports = { reserveHiddenCfidLocal };
