"use strict";

const { CURRENT_VM_VERSION } = require("../version");

const CONST_TAG = Object.freeze({
  null: 0,
  undefined: 1,
  boolean: 2,
  number: 3,
  string: 4,
  bigint: 5,
  regexp: 6,
});

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

class ByteWriter {
  constructor() {
    this.bytes = [];
  }

  u8(value) {
    assertIntegerRange(value, 0, 0xff, "u8");
    this.bytes.push(value);
  }

  u16(value) {
    assertIntegerRange(value, 0, 0xffff, "u16");
    this.bytes.push(value & 0xff, (value >>> 8) & 0xff);
  }

  u32(value) {
    assertIntegerRange(value, 0, 0xffffffff, "u32");
    this.bytes.push(value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff);
  }

  i16(value) {
    assertIntegerRange(value, -0x8000, 0x7fff, "i16");
    this.u16(value < 0 ? value + 0x10000 : value);
  }

  i32(value) {
    assertIntegerRange(value, -0x80000000, 0x7fffffff, "i32");
    this.u32(value >>> 0);
  }

  f64(value) {
    const buf = new ArrayBuffer(8);
    new DataView(buf).setFloat64(0, value, true);
    this.raw(new Uint8Array(buf));
  }

  raw(bytes) {
    for (const byte of bytes) this.u8(byte);
  }

  string(value) {
    const bytes = textEncoder.encode(value);
    this.u16(bytes.length);
    this.raw(bytes);
  }

  finish() { return Uint8Array.from(this.bytes); }
}

function assertIntegerRange(value, min, max, label) {
  if (!Number.isInteger(value) || value < min || value > max) throw new RangeError(`${label} out of range: ${value}`);
}

class ByteReader {
  constructor(bytes) {
    this.bytes = bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes);
    this.offset = 0;
  }

  ensure(length) {
    if (this.offset + length > this.bytes.length) throw new RangeError("read past end");
  }

  u8() { this.ensure(1); return this.bytes[this.offset++]; }

  u16() {
    this.ensure(2);
    const value = this.bytes[this.offset] | (this.bytes[this.offset + 1] << 8);
    this.offset += 2;
    return value;
  }

  u32() {
    this.ensure(4);
    const value = (this.bytes[this.offset]
      | (this.bytes[this.offset + 1] << 8)
      | (this.bytes[this.offset + 2] << 16)
      | (this.bytes[this.offset + 3] << 24)) >>> 0;
    this.offset += 4;
    return value;
  }

  i16() {
    const value = this.u16();
    return value >= 0x8000 ? value - 0x10000 : value;
  }

  i32() {
    return this.u32() | 0;
  }

  f64() {
    this.ensure(8);
    const value = new DataView(this.bytes.buffer, this.bytes.byteOffset + this.offset, 8).getFloat64(0, true);
    this.offset += 8;
    return value;
  }

  bytesOf(length) {
    this.ensure(length);
    const out = this.bytes.slice(this.offset, this.offset + length);
    this.offset += length;
    return out;
  }

  string() { return textDecoder.decode(this.bytesOf(this.u16())); }
}

function addConst(literals, constantMap, value) {
  const key = constKey(value);
  if (constantMap.has(key)) return constantMap.get(key);
  const index = literals.length;
  literals.push(value);
  constantMap.set(key, index);
  return index;
}

function constKey(value) {
  if (value instanceof RegExp) return `regexp:${value.source}/${value.flags}`;
  if (typeof value === "number") {
    if (Object.is(value, -0)) return "number:-0";
    if (Number.isNaN(value)) return "number:NaN";
  }
  return `${typeof value}:${String(value)}`;
}

function normalizeModule(module) {
  const literals = Array.from(module.constPool?.literals || module.constants || []);
  while (literals.length < 4) literals.push([null, undefined, true, false][literals.length]);
  literals[0] = null;
  literals[1] = undefined;
  literals[2] = true;
  literals[3] = false;

  const constantMap = new Map(literals.map((value, index) => [constKey(value), index]));
  const funcs = (module.funcs || module.functions || []).map((func) => normalizeFunc(func, literals, constantMap));
  const classes = (module.classes || []).map(normalizeClass);
  return {
    version: module.version ?? CURRENT_VM_VERSION,
    constPool: { literals },
    funcs,
    classes,
    entry: module.entry ?? 0,
  };
}

function normalizeParams(func, paramCount) {
  const params = Object.prototype.hasOwnProperty.call(func, "params")
    ? Array.from(func.params || [])
    : Array.from({ length: paramCount }, (_, index) => index);
  if (params.length !== paramCount) throw new RangeError(`params length ${params.length} must equal paramCount ${paramCount}`);
  for (const param of params) assertIntegerRange(param, 0, 0xffff, "params entry");
  return params;
}

function inferArgumentsSlot(func, flags, paramCount, rest) {
  if (Number.isInteger(func.argumentsSlot)) return func.argumentsSlot;
  return (flags & 0x02) !== 0 ? paramCount + (rest >= 0 ? 1 : 0) : -1;
}

function normalizeFunc(func, literals, constantMap) {
  const nameIdx = Number.isInteger(func.nameIdx)
    ? func.nameIdx
    : func.name
      ? addConst(literals, constantMap, func.name)
      : -1;
  const paramCount = Number.isInteger(func.paramCount) ? func.paramCount : (func.params || []).length;
  const params = normalizeParams(func, paramCount);
  const hasRest = Object.prototype.hasOwnProperty.call(func, "hasRest") ? !!func.hasRest : (func.rest ?? -1) >= 0;
  const rest = Number.isInteger(func.rest) ? func.rest : (hasRest ? paramCount : -1);
  const flags = func.flags || 0;
  const argumentsSlot = inferArgumentsSlot(func, flags, paramCount, rest);
  const normalizedFlags = flags | (argumentsSlot >= 0 ? 0x02 : 0);
  const selfNameSlot = Number.isInteger(func.selfNameSlot) ? func.selfNameSlot : -1;
  const localCount = Number.isInteger(func.localCount) ? func.localCount : (func.localNames || []).length;
  assertIntegerRange(paramCount, 0, 0xffff, "paramCount");
  assertIntegerRange(rest, -0x8000, 0x7fff, "rest");
  assertIntegerRange(argumentsSlot, -0x8000, 0x7fff, "argumentsSlot");
  assertIntegerRange(localCount, 0, 0xffff, "localCount");
  assertIntegerRange(selfNameSlot, -0x8000, 0x7fff, "selfNameSlot");
  return {
    nameIdx,
    kind: func.kind ?? 0,
    flags: normalizedFlags,
    paramCount,
    params,
    rest,
    argumentsSlot,
    localCount,
    selfNameSlot,
    upvalues: (func.upvalues || []).map((upvalue) => ({
      fromLocal: Object.prototype.hasOwnProperty.call(upvalue, "fromLocal") ? !!upvalue.fromLocal : upvalue.scope === 0,
      index: upvalue.index,
    })),
    code: func.code instanceof Uint8Array ? func.code : Uint8Array.from(func.code || []),
    exTable: (func.exTable || []).map((entry) => ({
      start: entry.start,
      end: entry.end,
      handler: entry.handler,
      stackDepth: entry.stackDepth || 0,
      isFinal: !!entry.isFinal,
    })),
    srcMap: func.srcMap || [],
  };
}

function normalizeClass(classDef) {
  return {
    nameIdx: Number.isInteger(classDef.nameIdx) ? classDef.nameIdx : -1,
    constructor: classDef.constructor ?? 0,
    methods: classDef.methods || [],
    statics: classDef.statics || [],
    privateSlots: classDef.privateSlots || [],
    isDerived: !!classDef.isDerived,
    instanceFields: classDef.instanceFields || [],
    staticFields: classDef.staticFields || [],
    staticBlock: Object.prototype.hasOwnProperty.call(classDef, "staticBlock") ? classDef.staticBlock : null,
  };
}

function serializeModule(module) {
  const normalized = normalizeModule(module);
  const writer = new ByteWriter();
  writer.u8(normalized.version);
  writeConstPool(writer, normalized.constPool.literals);
  writer.u16(normalized.funcs.length);
  for (const func of normalized.funcs) writeFunc(writer, func);
  writer.u16(normalized.classes.length);
  for (const classDef of normalized.classes) writeClass(writer, classDef);
  writer.u16(normalized.entry);
  return writer.finish();
}

function writeConstPool(writer, literals) {
  writer.u16(literals.length);
  for (const literal of literals) writeConst(writer, literal);
}

function writeConst(writer, literal) {
  if (literal === null) { writer.u8(CONST_TAG.null); return; }
  if (literal === undefined) { writer.u8(CONST_TAG.undefined); return; }
  if (typeof literal === "boolean") { writer.u8(CONST_TAG.boolean); writer.u8(literal ? 1 : 0); return; }
  if (typeof literal === "number") { writer.u8(CONST_TAG.number); writer.f64(literal); return; }
  if (typeof literal === "string") { writer.u8(CONST_TAG.string); writer.string(literal); return; }
  if (typeof literal === "bigint") { writer.u8(CONST_TAG.bigint); writer.string(literal.toString()); return; }
  if (literal instanceof RegExp) {
    writer.u8(CONST_TAG.regexp);
    writer.string(literal.source);
    writer.string(literal.flags);
    return;
  }
  throw new TypeError(`Unsupported constant type: ${typeof literal}`);
}

function writeFunc(writer, func) {
  writer.i16(func.nameIdx);
  writer.u8(func.kind);
  writer.u8(func.flags);
  writer.u16(func.paramCount);
  for (const param of func.params) writer.u16(param);
  writer.i16(func.rest);
  writer.i16(func.argumentsSlot);
  writer.u16(func.localCount);
  writer.i16(func.selfNameSlot);
  writer.u16(func.upvalues.length);
  for (const upvalue of func.upvalues) {
    writer.u8(upvalue.fromLocal ? 1 : 0);
    writer.u16(upvalue.index);
  }
  writer.u16(func.code.length);
  writer.raw(func.code);
  writer.u16(func.exTable.length);
  for (const entry of func.exTable) {
    writer.u16(entry.start);
    writer.u16(entry.end);
    writer.u16(entry.handler);
    writer.u16(entry.stackDepth);
    writer.u8(entry.isFinal ? 1 : 0);
  }
  writer.u16(func.srcMap.length);
  for (const entry of func.srcMap) {
    writer.u16(entry.pc);
    writer.u16(entry.line);
    writer.u16(entry.column);
  }
}

function writeClass(writer, classDef) {
  writer.i16(classDef.nameIdx);
  writer.u16(classDef.constructor);
  writeMethodEntries(writer, classDef.methods);
  writeMethodEntries(writer, classDef.statics);
  writer.u16(classDef.privateSlots.length);
  for (const slot of classDef.privateSlots) writePrivateSlot(writer, slot);
  writer.u8(classDef.isDerived ? 1 : 0);
  writeFieldEntries(writer, classDef.instanceFields);
  writeFieldEntries(writer, classDef.staticFields);
  writer.u8(classDef.staticBlock === null ? 0 : 1);
  if (classDef.staticBlock !== null) writer.u16(classDef.staticBlock);
}

function writeMethodEntries(writer, entries) {
  writer.u16(entries.length);
  for (const entry of entries) {
    writer.u8(entry.keyKind);
    writer.u16(entry.keyIndex);
    writer.u16(entry.funcIdx);
    writer.u8(entry.kind);
  }
}

function writePrivateSlot(writer, slot) {
  writer.u8(slot.slotKind);
  writer.u16(slot.slotIndex);
  writer.u16(slot.nameIdx);
  if (slot.slotKind === 1) writer.u16(slot.funcIdx);
  else if (slot.slotKind === 2) {
    writer.u8(slot.hasGetter ? 1 : 0);
    if (slot.hasGetter) writer.u16(slot.getterIdx);
    writer.u8(slot.hasSetter ? 1 : 0);
    if (slot.hasSetter) writer.u16(slot.setterIdx);
  }
}

function writeFieldEntries(writer, entries) {
  writer.u16(entries.length);
  for (const entry of entries) {
    writer.u8(entry.keyKind);
    writer.u16(entry.keyIndex);
    writer.u16(entry.funcIdx);
  }
}

function deserializeModule(bytes) {
  const reader = new ByteReader(bytes);
  const version = reader.u8();
  const constPool = { literals: readConstPool(reader) };
  const funcs = readItems(reader, () => readFunc(reader));
  const classes = readItems(reader, () => readClass(reader));
  const entry = reader.u16();
  return { version, constPool, funcs, classes, entry };
}

function readItems(reader, readItem) {
  const count = reader.u16();
  const items = [];
  for (let i = 0; i < count; i++) items.push(readItem());
  return items;
}

function readConstPool(reader) { return readItems(reader, () => readConst(reader)); }

function readConst(reader) {
  const tag = reader.u8();
  if (tag === CONST_TAG.null) return null;
  if (tag === CONST_TAG.undefined) return undefined;
  if (tag === CONST_TAG.boolean) return reader.u8() !== 0;
  if (tag === CONST_TAG.number) return reader.f64();
  if (tag === CONST_TAG.encryptedString) return readEncryptedString(reader);
  if (tag === CONST_TAG.protectedNumber) return readProtectedNumber(reader);
  if (tag === CONST_TAG.string) return reader.string();
  if (tag === CONST_TAG.bigint) return BigInt(reader.string());
  if (tag === CONST_TAG.regexp) return new RegExp(reader.string(), reader.string());
  throw new TypeError(`Unsupported constant tag ${tag}`);
}

function readFunc(reader) {
  const nameIdx = reader.i16();
  const kind = reader.u8();
  const flags = reader.u8();
  const paramCount = reader.u16();
  const params = [];
  for (let i = 0; i < paramCount; i++) params.push(reader.u16());
  const rest = reader.i16();
  const argumentsSlot = reader.i16();
  const localCount = reader.u16();
  const selfNameSlot = reader.i16();
  const upvalues = readItems(reader, () => ({ fromLocal: reader.u8() !== 0, index: reader.u16() }));
  const upvalCount = upvalues.length;
  const code = reader.bytesOf(reader.u16());
  const exTable = readItems(reader, () => ({
    start: reader.u16(),
    end: reader.u16(),
    handler: reader.u16(),
    stackDepth: reader.u16(),
    isFinal: reader.u8() !== 0,
  }));
  const srcMap = readItems(reader, () => ({ pc: reader.u16(), line: reader.u16(), column: reader.u16() }));
  const out = { nameIdx, kind, flags, paramCount, params, rest, argumentsSlot, localCount, selfNameSlot, upvalCount, upvalues, code, exTable, srcMap };
  return out;
}

function readClass(reader) {
  const nameIdx = reader.i16();
  const constructor = reader.u16();
  const methods = readMethodEntries(reader);
  const statics = readMethodEntries(reader);
  const privateSlots = readItems(reader, () => readPrivateSlot(reader));
  const isDerived = reader.u8() !== 0;
  const instanceFields = readFieldEntries(reader);
  const staticFields = readFieldEntries(reader);
  const staticBlock = reader.u8() !== 0 ? reader.u16() : null;
  const out = { nameIdx, constructor, methods, statics, privateSlots, isDerived, instanceFields, staticFields };
  if (staticBlock !== null) out.staticBlock = staticBlock;
  return out;
}

function readMethodEntries(reader) {
  return readItems(reader, () => ({ keyKind: reader.u8(), keyIndex: reader.u16(), funcIdx: reader.u16(), kind: reader.u8() }));
}

function readPrivateSlot(reader) {
  const slotKind = reader.u8();
  const slotIndex = reader.u16();
  const nameIdx = reader.u16();
  if (slotKind === 1) return { slotKind, slotIndex, nameIdx, funcIdx: reader.u16() };
  if (slotKind === 2) {
    const hasGetter = reader.u8() !== 0;
    const getterIdx = hasGetter ? reader.u16() : undefined;
    const hasSetter = reader.u8() !== 0;
    const setterIdx = hasSetter ? reader.u16() : undefined;
    const out = { slotKind, slotIndex, nameIdx, hasGetter, hasSetter };
    if (hasGetter) out.getterIdx = getterIdx;
    if (hasSetter) out.setterIdx = setterIdx;
    return out;
  }
  return { slotKind, slotIndex, nameIdx };
}

function readFieldEntries(reader) {
  return readItems(reader, () => ({ keyKind: reader.u8(), keyIndex: reader.u16(), funcIdx: reader.u16() }));
}

module.exports = { CURRENT_VM_VERSION, serializeModule, deserializeModule };
