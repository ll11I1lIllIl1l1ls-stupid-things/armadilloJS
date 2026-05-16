"use strict";

const { OP, assertDynOperandIndex } = require("../opcodes");

class BytecodeBuffer {
  constructor() { this.bytes = []; }
  get position() { return this.bytes.length; }
  emitU8(value) { this.bytes.push(value & 0xFF); return this.position - 1; }
  emitU16(value) { this.bytes.push(value & 0xFF, (value >> 8) & 0xFF); return this.position - 2; }
  emitI16(value) { return this.emitU16(value < 0 ? value + 0x10000 : value); }
  emitOp(op) { return this.emitU8(op); }
  emitOperand(operand) {
    if (operand.kind === "u8") this.emitU8(operand.value);
    else if (operand.kind === "u16") this.emitU16(operand.value);
    else if (operand.kind === "i16") this.emitI16(operand.value);
  }
  emitDynOp(op, dynamicWhich, ...operands) {
    const dynamicSet = new Set(dynamicWhich);
    for (const which of dynamicSet) {
      assertDynOperandIndex(which);
      this.emitOp(OP.dyn);
      this.emitU8(which);
    }
    this.emitOp(op);
    for (let i = 0; i < operands.length; i++) {
      if (!dynamicSet.has(i)) this.emitOperand(operands[i]);
    }
  }
  patchI16(position, value) {
    const encoded = value < 0 ? value + 0x10000 : value;
    this.bytes[position] = encoded & 0xFF;
    this.bytes[position + 1] = (encoded >> 8) & 0xFF;
  }
  toUint8Array() { return Uint8Array.from(this.bytes); }
}

module.exports = { BytecodeBuffer };
