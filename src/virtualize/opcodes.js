"use strict";

const OP = Object.freeze({
  pop: 0x00, dup: 0x01, dup2: 0x02, swap: 0x03, rot3: 0x04,
  push: 0x05, push_i: 0x06, push_spec: 0x07,
  load: 0x08, store: 0x09,
  get_prop: 0x0A, set_prop: 0x0B, get_elem: 0x0C, set_elem: 0x0D, del: 0x0E, get_private: 0x0F, set_private: 0x10,
  unop: 0x11, binop: 0x12,
  jmp: 0x13, jmp_if: 0x14, ret: 0x15, throw: 0x16,
  get_exc: 0x17,
  call: 0x18, call_method: 0x19, call_new: 0x1A,
  new_obj: 0x1B, new_arr: 0x1C, def_prop: 0x1D, spread: 0x1E,
  make_func: 0x1F, make_class: 0x20,
  iter_op: 0x21, call_super: 0x22, mod_op: 0x23, dyn: 0xFF,
});

const BINOP = Object.freeze({
  "+": 0, "-": 1, "*": 2, "/": 3, "%": 4, "**": 5,
  "&": 6, "|": 7, "^": 8, "<<": 9, ">>": 10, ">>>": 11,
  "===": 12, "!==": 13, "==": 14, "!=": 15,
  "<": 16, "<=": 17, ">": 18, ">=": 19, in: 20, instanceof: 21,
});

const UNOP = Object.freeze({ "-": 0, "+": 1, "!": 2, "~": 3, typeof: 4, void: 5, "++": 6, "--": 7 });

const OPERANDS = Object.freeze({
  [OP.pop]: [], [OP.dup]: [], [OP.dup2]: [], [OP.swap]: [], [OP.rot3]: [],
  [OP.push]: ["u16"], [OP.push_i]: ["i16"], [OP.push_spec]: ["u8"],
  [OP.load]: ["u8", "u16"], [OP.store]: ["u8", "u16"],
  [OP.get_prop]: ["u16"], [OP.set_prop]: ["u16"], [OP.get_elem]: [], [OP.set_elem]: [], [OP.del]: ["u8", "u16"],
  [OP.get_private]: ["u16"], [OP.set_private]: ["u16"], [OP.unop]: ["u8"], [OP.binop]: ["u8"],
  [OP.jmp]: ["i16"], [OP.jmp_if]: ["u8", "i16"], [OP.ret]: ["u8"], [OP.throw]: [], [OP.get_exc]: [],
  [OP.call]: ["u8", "u8"], [OP.call_method]: ["u16", "u8"], [OP.call_new]: ["u8"],
  [OP.new_obj]: [], [OP.new_arr]: ["u16"], [OP.def_prop]: ["u8", "u16"], [OP.spread]: ["u8"],
  [OP.make_func]: ["u16"], [OP.make_class]: ["u16"], [OP.iter_op]: ["u8"], [OP.call_super]: ["u8"], [OP.mod_op]: ["u8"], [OP.dyn]: ["u8", "u8"],
});

const OPERAND_SIZE = Object.freeze({ u8: 1, u16: 2, i16: 2 });

function assertDynOperandIndex(which) {
  if (!Number.isInteger(which) || which < 0 || which > 7) {
    throw new RangeError(`Invalid dyn operand index ${which}`);
  }
}

function instrSeqByteLength(code, pc) {
  const start = pc;
  let dynMask = 0;
  let prefixCount = 0;
  while (code[pc] === OP.dyn) {
    if (++prefixCount > 8) throw new RangeError("dyn chain too long");
    const which = code[pc + 1];
    assertDynOperandIndex(which);
    dynMask |= 1 << which;
    pc += 2;
  }
  const operands = OPERANDS[code[pc++]] || [];
  for (let i = 0; i < operands.length; i++) {
    if ((dynMask & (1 << i)) === 0) pc += OPERAND_SIZE[operands[i]];
  }
  return pc - start;
}

module.exports = { OP, BINOP, UNOP, OPERANDS, assertDynOperandIndex, instrSeqByteLength };
