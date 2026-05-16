"use strict";

const { OP } = require("./opcodes");
const { CURRENT_VM_VERSION } = require("./version");

function createRuntime(OP_LOCAL) {
  const textDecoder = new TextDecoder();
  const TDZ_SENTINEL = Symbol("tdz");
  const hostString = globalThis.String;
  const hostEscape = globalThis.escape;
  const hostDecodeURIComponent = globalThis.decodeURIComponent;
  function Reader(bytes) { this.bytes = bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes); this.offset = 0; }
  Reader.prototype.ensure = function ensure(length) { if (this.offset + length > this.bytes.length) throw new RangeError("read past end"); };
  Reader.prototype.u8 = function u8() { this.ensure(1); return this.bytes[this.offset++]; };
  Reader.prototype.u16 = function u16() { this.ensure(2); const value = this.bytes[this.offset] | (this.bytes[this.offset + 1] << 8); this.offset += 2; return value; };
  Reader.prototype.u32 = function u32() { this.ensure(4); const value = (this.bytes[this.offset] | (this.bytes[this.offset + 1] << 8) | (this.bytes[this.offset + 2] << 16) | (this.bytes[this.offset + 3] << 24)) >>> 0; this.offset += 4; return value; };
  Reader.prototype.i16 = function i16() { const value = this.u16(); return value >= 0x8000 ? value - 0x10000 : value; };
  Reader.prototype.i32 = function i32() { return this.u32() | 0; };
  Reader.prototype.f64 = function f64() { this.ensure(8); const value = new DataView(this.bytes.buffer, this.bytes.byteOffset + this.offset, 8).getFloat64(0, true); this.offset += 8; return value; };
  Reader.prototype.bytesOf = function bytesOf(length) { this.ensure(length); const out = this.bytes.slice(this.offset, this.offset + length); this.offset += length; return out; };
  Reader.prototype.string = function string() { return textDecoder.decode(this.bytesOf(this.u16())); };
  function readItems(reader, readItem) { const count = reader.u16(); const items = []; for (let i = 0; i < count; i++) items.push(readItem()); return items; }
  function readConst(reader) {
    const tag = reader.u8();
    if (tag === 0) return null;
    if (tag === 1) return undefined;
    if (tag === 2) return reader.u8() !== 0;
    if (tag === 3) return reader.f64();
    if (tag === 4) return reader.string();
    if (tag === 5) return BigInt(reader.string());
    if (tag === 6) return new RegExp(reader.string(), reader.string());
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
    const code = reader.bytesOf(reader.u16());
    const exTable = readItems(reader, () => ({ start: reader.u16(), end: reader.u16(), handler: reader.u16(), stackDepth: reader.u16(), isFinal: reader.u8() !== 0 }));
    const srcMap = readItems(reader, () => ({ pc: reader.u16(), line: reader.u16(), column: reader.u16() }));
    const out = { nameIdx, kind, flags, paramCount, params, rest, argumentsSlot, localCount, selfNameSlot, upvalues, code, exTable, srcMap };
    return out;
  }
  function readMethodEntries(reader) { return readItems(reader, () => ({ keyKind: reader.u8(), keyIndex: reader.u16(), funcIdx: reader.u16(), kind: reader.u8() })); }
  function readPrivateSlot(reader) {
    const slotKind = reader.u8(); const slotIndex = reader.u16(); const nameIdx = reader.u16();
    if (slotKind === 1) return { slotKind, slotIndex, nameIdx, funcIdx: reader.u16() };
    if (slotKind === 2) { const hasGetter = reader.u8() !== 0; const getterIdx = hasGetter ? reader.u16() : undefined; const hasSetter = reader.u8() !== 0; const setterIdx = hasSetter ? reader.u16() : undefined; const out = { slotKind, slotIndex, nameIdx, hasGetter, hasSetter }; if (hasGetter) out.getterIdx = getterIdx; if (hasSetter) out.setterIdx = setterIdx; return out; }
    return { slotKind, slotIndex, nameIdx };
  }
  function readFieldEntries(reader) { return readItems(reader, () => ({ keyKind: reader.u8(), keyIndex: reader.u16(), funcIdx: reader.u16() })); }
  function readClass(reader) {
    const nameIdx = reader.i16(); const constructor = reader.u16(); const methods = readMethodEntries(reader); const statics = readMethodEntries(reader); const privateSlots = readItems(reader, () => readPrivateSlot(reader)); const isDerived = reader.u8() !== 0; const instanceFields = readFieldEntries(reader); const staticFields = readFieldEntries(reader); const staticBlock = reader.u8() !== 0 ? reader.u16() : null; const out = { nameIdx, constructor, methods, statics, privateSlots, isDerived, instanceFields, staticFields }; if (staticBlock !== null) out.staticBlock = staticBlock; return out;
  }
  function deserialize(bytes) {
    const reader = new Reader(bytes);
    const version = reader.u8();
    const constants = readItems(reader, () => readConst(reader));
    const functions = readItems(reader, () => readFunc(reader)).map((func) => {
      return {
        nameIdx: func.nameIdx,
        kind: func.kind,
        flags: func.flags,
        params: func.params,
        rest: func.rest,
        argumentsSlot: func.argumentsSlot,
        selfNameSlot: func.selfNameSlot,
        localNames: Array.from({ length: func.localCount }, (_, i) => String(i)),
        upvalues: func.upvalues.map((upvalue) => ({ scope: upvalue.fromLocal ? 0 : 1, index: upvalue.index })),
        code: func.code,
        exTable: func.exTable,
        srcMap: func.srcMap,
      };
    });
    const classes = readItems(reader, () => readClass(reader));
    const entry = reader.u16();
    const mod = { version, constPool: { literals: constants }, funcs: functions, classes, entry };
    mod.constants = constants;
    mod.functions = functions;
    return mod;
  }
  function vmBoot(bytes, hostGlobal, entryFrameOptions) {
    const mod = deserialize(bytes);
    const runtimeState = { callstack: [], pendingCrash: null };
    try {
      return execute(createFrame(mod, mod.entry, undefined, [], hostGlobal || globalThis, [], { ...entryFrameOptions, runtimeState }));
    } catch (error) {
      if (runtimeState.pendingCrash && runtimeState.pendingCrash.error === error) {
        console.error(runtimeState.pendingCrash.text);
        runtimeState.pendingCrash = null;
      }
      throw error;
    }
  }
  function run(bytes, hostGlobal, entryFrameOptions) { return vmBoot(bytes, hostGlobal, entryFrameOptions); }
  function makeCell(value) { return { value }; }
  function readI16(code, pc) { const value = code[pc] | (code[pc + 1] << 8); return value & 0x8000 ? value - 0x10000 : value; }
  function readU16(code, pc) { return code[pc] | (code[pc + 1] << 8); }
  function assertDynOperandIndex(which) { if (!Number.isInteger(which) || which < 0 || which > 7) throw new RangeError(`Invalid dyn operand index ${which}`); }
  function readRuntimeConstant(frame, index) {
    return frame.mod.constants[index];
  }
  function readRuntimeName(frame, index) {
    if (!Number.isInteger(index)) return index;
    return readRuntimeConstant(frame, index);
  }
  function readRuntimeBuiltin(name) {
    if (name === "String") return hostString;
    if (name === "escape") return hostEscape;
    if (name === "decodeURIComponent") return hostDecodeURIComponent;
    return undefined;
  }
  function toArray(args) { return Array.prototype.slice.call(args); }
  function flattenArgs(args) {
    const out = [];
    for (const arg of args) {
      if (arg && arg.__vmSpread === true) out.push(...arg.values);
      else out.push(arg);
    }
    return out;
  }
  function mkArguments(frame) {
    if (frame.argumentsObject) return frame.argumentsObject;
    const args = frame.args.slice();
    const obj = { length: args.length };
    for (let i = 0; i < args.length; i++) obj[i] = args[i];
    Object.defineProperty(obj, Symbol.iterator, {
      value: Array.prototype[Symbol.iterator],
      enumerable: false,
      configurable: true,
      writable: true,
    });
    Object.defineProperty(obj, Symbol.toStringTag, {
      value: "Arguments",
      enumerable: false,
      configurable: false,
      writable: false,
    });
    const strictThrower = function strictThrower() {
      throw new TypeError("'caller', 'callee', and 'arguments' may not be accessed in strict mode");
    };
    Object.defineProperty(obj, "callee", {
      get: strictThrower,
      set: strictThrower,
      enumerable: false,
      configurable: false,
    });
    Object.defineProperty(obj, "caller", {
      get: strictThrower,
      set: strictThrower,
      enumerable: false,
      configurable: false,
    });
    frame.argumentsObject = obj;
    return obj;
  }
  function createForInIter(value) {
    if (value == null) {
      return {
        next() {
          return { value: undefined, done: true };
        },
      };
    }
    const keys = [];
    for (const key in Object(value)) keys.push(key);
    let index = 0;
    return {
      next() {
        if (index < keys.length) return { value: keys[index++], done: false };
        return { value: undefined, done: true };
      },
    };
  }
  function findHandler(exTable, pc) {
    let best = null;
    for (let i = exTable.length - 1; i >= 0; i--) {
      const entry = exTable[i];
      if (pc < entry.start || pc >= entry.end) continue;
      if (!best || (entry.end - entry.start) < (best.end - best.start) || ((entry.end - entry.start) === (best.end - best.start) && entry.isFinal && !best.isFinal)) best = entry;
    }
    return best;
  }
  function createFrame(mod, funcIdx, thisVal, args, hostGlobal, closureUpvals, frameOptions) {
    const func = mod.functions[funcIdx];
    const locals = func.localNames.map(() => makeCell(TDZ_SENTINEL));
    const upvals = closureUpvals || [];
    for (let i = 0; i < func.params.length; i++) locals[func.params[i]].value = i < args.length ? args[i] : undefined;
    if (func.rest >= 0) locals[func.rest].value = args.slice(func.params.length);
    if (func.argumentsSlot >= 0) locals[func.argumentsSlot].value = args.slice();
    frameOptions = frameOptions || {};
    if (func.selfNameSlot >= 0) locals[func.selfNameSlot].value = frameOptions.selfFn;
    const runtimeState = frameOptions.runtimeState || { callstack: [], pendingCrash: null };
    return {
      mod,
      funcIdx,
      func,
      code: func.code,
      stack: [],
      locals,
      upvals,
      thisVal,
      args,
      hostGlobal,
      pc: 0,
      currentException: undefined,
      newTarget: frameOptions.newTarget,
      homeClass: frameOptions.homeClass,
      superClass: frameOptions.superClass,
      argumentsObject: undefined,
      parent: frameOptions.parent,
      runtimeState,
    };
  }
  function materializeFunction(mod, funcIdx, closureUpvals, hostGlobal, frameOptions) {
    if (!Number.isInteger(funcIdx) || funcIdx < 0 || funcIdx >= mod.functions.length) {
      throw new TypeError(`funcIdx out of bounds: ${funcIdx}`);
    }
    const proto = mod.functions[funcIdx];
    const upvalCount = proto.upvalues ? proto.upvalues.length : 0;
    if ((!closureUpvals || closureUpvals.length === 0) && upvalCount > 0) {
      throw new TypeError(`Cannot materialize function with upvalues (upvalCount=${upvalCount})`);
    }
    const fn = function vmFunction() {
      const callFrame = createFrame(mod, funcIdx, this, toArray(arguments), hostGlobal, closureUpvals, {
        ...frameOptions,
        newTarget: new.target,
        selfFn: fn,
        parent: frameOptions && frameOptions.currentFrame,
        runtimeState: frameOptions && frameOptions.runtimeState,
      });
      return execute(callFrame);
    };
    fn.__vmFunc = true;
    fn.__vmFuncIdx = funcIdx;
    return fn;
  }
  function preventConstruction(fn, label) {
    return new Proxy(fn, {
      construct() {
        throw new TypeError(`${label} is not a constructor`);
      },
    });
  }
  function captureUpvalues(mod, funcIdx, locals, upvals) {
    const proto = mod.functions[funcIdx];
    return proto.upvalues.map((u) => u.scope === 0 ? locals[u.index] : upvals[u.index]);
  }
  function makeClassMethod(mod, funcIdx, captured, hostGlobal, homeClass) {
    const method = materializeFunction(mod, funcIdx, captured, hostGlobal, { homeClass });
    const label = mod.constants[mod.functions[funcIdx].nameIdx] || "Class method";
    return preventConstruction(method, label);
  }
  function resolveClassKey(mod, entry) {
    if (entry.keyKind === 0) return mod.constants[entry.keyIndex];
    if (entry.keyKind === 1) return Symbol.for(String(mod.constants[entry.keyIndex]));
    return mod.constants[entry.keyIndex];
  }
  function installClassMethod(mod, target, entry, captured, hostGlobal, homeClass) {
    const key = resolveClassKey(mod, entry);
    const method = makeClassMethod(mod, entry.funcIdx, captured, hostGlobal, homeClass);
    if (entry.kind === 1) Object.defineProperty(target, key, { get: method, enumerable: false, configurable: true });
    else if (entry.kind === 2) Object.defineProperty(target, key, { set: method, enumerable: false, configurable: true });
    else Object.defineProperty(target, key, { value: method, writable: true, enumerable: false, configurable: true });
  }
  function makeSuperProxy(homeClass, receiver) {
    if (typeof homeClass !== "function") throw new TypeError("push_spec super requires a home class");
    const superProto = Object.getPrototypeOf(homeClass.prototype);
    if (!superProto) throw new TypeError("push_spec super requires a super prototype");
    return new Proxy({}, {
      get(_target, prop) { return Reflect.get(superProto, prop, receiver); },
      set(_target, prop, value) { return Reflect.set(superProto, prop, value, receiver); },
    });
  }
  function buildClass(mod, classIdx, hostGlobal, locals, upvals, stack, runtimeState) {
    const classDef = mod.classes[classIdx];
    if (!classDef) throw new RangeError(`Class index out of range: ${classIdx}`);
    const superCls = stack.pop();
    if (superCls !== undefined && superCls !== null && typeof superCls !== "function") throw new TypeError("make_class requires a super class, null, or undefined");
    const constructorUpvals = captureUpvalues(mod, classDef.constructor, locals, upvals);
    const className = Number.isInteger(classDef.nameIdx) && classDef.nameIdx >= 0 ? String(mod.constants[classDef.nameIdx]) : "<anonymous>";
    function VMClass() {
      if (new.target === undefined) throw new TypeError(`Class constructor ${className} cannot be invoked without 'new'`);
      const newTarget = new.target;
      const receiver = superCls !== undefined && superCls !== null ? undefined : this;
      const frame = createFrame(mod, classDef.constructor, receiver, toArray(arguments), hostGlobal, constructorUpvals, { newTarget, homeClass: VMClass, superClass: superCls, runtimeState });
      const result = execute(frame);
      if ((typeof result === "object" && result !== null) || typeof result === "function") return result;
      if (superCls !== undefined && superCls !== null && frame.thisVal !== undefined) return frame.thisVal;
      return result === undefined ? this : result;
    }
    Object.defineProperty(VMClass, "__superCls", { value: superCls, configurable: true });
    if (Number.isInteger(classDef.nameIdx) && classDef.nameIdx >= 0) Object.defineProperty(VMClass, "name", { value: String(mod.constants[classDef.nameIdx]), configurable: true });
    if (superCls === null) {
      Object.setPrototypeOf(VMClass.prototype, null);
    } else if (superCls !== undefined) {
      Object.setPrototypeOf(VMClass.prototype, superCls.prototype);
      Object.setPrototypeOf(VMClass, superCls);
    }
    Object.defineProperty(VMClass.prototype, "constructor", { value: VMClass, writable: true, configurable: true });
    for (const entry of classDef.methods || []) installClassMethod(mod, VMClass.prototype, entry, captureUpvalues(mod, entry.funcIdx, locals, upvals), hostGlobal, VMClass);
    for (const entry of classDef.statics || []) installClassMethod(mod, VMClass, entry, captureUpvalues(mod, entry.funcIdx, locals, upvals), hostGlobal, VMClass);
    return VMClass;
  }
  function makeModuleHandle(module, moduleHostGlobal) {
    return { __vmModuleHandle: true, module, hostGlobal: moduleHostGlobal };
  }
  function expectModuleHandle(value) {
    if (!value || value.__vmModuleHandle !== true) throw new TypeError("mod_op requires a VMModuleHandle");
    return value;
  }
  function applyBin(op, a, b) {
    switch (op) {
      case 0: return a + b; case 1: return a - b; case 2: return a * b; case 3: return a / b; case 4: return a % b; case 5: return a ** b;
      case 6: return a & b; case 7: return a | b; case 8: return a ^ b; case 9: return a << b; case 10: return a >> b; case 11: return a >>> b;
      case 12: return a === b; case 13: return a !== b; case 14: return a == b; case 15: return a != b;
      case 16: return a < b; case 17: return a <= b; case 18: return a > b; case 19: return a >= b; case 20: return a in b; case 21: return a instanceof b;
      default: throw new Error(`Unsupported binop ${op}`);
    }
  }
  function applyUn(op, a) {
    switch (op) {
      case 0: return -a; case 1: return +a; case 2: return !a; case 3: return ~a; case 4: return typeof a; case 5: return undefined; case 6: return a + 1; case 7: return a - 1;
      default: throw new Error(`Unsupported unop ${op}`);
    }
  }
  function opName(op) {
    for (const key of Object.keys(OP_LOCAL)) if (OP_LOCAL[key] === op) return key;
    return `op_${op}`;
  }
  function findSource(srcMap, pc) {
    let best = null;
    for (const entry of srcMap || []) {
      if (entry.pc > pc) continue;
      if (!best || entry.pc > best.pc) best = entry;
    }
    return best;
  }
  function funcName(frame) {
    const idx = frame.func.nameIdx;
    if (Number.isInteger(idx) && idx >= 0) return String(frame.mod.constants[idx]);
    return `<anonymous>`;
  }
  function shortValue(value) {
    if (value === TDZ_SENTINEL) return "<tdz>";
    if (value === undefined) return "undefined";
    if (value === null) return "null";
    if (typeof value === "string") return JSON.stringify(value.length > 40 ? `${value.slice(0, 37)}...` : value);
    if (typeof value === "function") return `[Function ${value.name || "anonymous"}]`;
    if (typeof value === "object") return Array.isArray(value) ? `[Array(${value.length})]` : "[Object]";
    return String(value);
  }
  function formatVmCrash(error, frame, seqPc, op) {
    const lines = ["ArmadilloJS VM crash", `${error && error.stack ? error.stack : String(error)}`, "VM callstack"];
    const frames = frame.runtimeState && frame.runtimeState.callstack.length > 0 ? frame.runtimeState.callstack.slice() : [frame];
    for (let i = frames.length - 1, outIndex = 0; i >= 0; i--, outIndex++) {
      const current = frames[i];
      const pc = current === frame ? seqPc : Math.max(0, current.pc - 1);
      const source = findSource(current.func.srcMap, pc);
      const sourceText = source ? ` src=${source.line}:${source.column}` : "";
      const opText = current === frame ? ` op=${opName(op)}` : "";
      lines.push(`#${outIndex} func ${current.funcIdx} ${funcName(current)} pc=${pc}${opText}${sourceText} stackDepth=${current.stack.length}`);
      lines.push(`    stackTop=[${current.stack.slice(-5).map(shortValue).join(", ")}]`);
      lines.push(`    locals=[${current.locals.slice(0, 8).map((cell, index) => `${index}:${shortValue(cell.value)}`).join(", ")}]`);
    }
    return lines.join("\n");
  }
  function execute(frame) {
    const mod = frame.mod;
    const func = frame.func;
    const code = frame.code;
    const stack = frame.stack;
    const locals = frame.locals;
    const upvals = frame.upvals;
    const args = frame.args;
    const hostGlobal = frame.hostGlobal;
    const runtimeState = frame.runtimeState || { callstack: [], pendingCrash: null };
    runtimeState.callstack.push(frame);
    let returned = false;
    let currentOp = undefined;
    function load(scope, idx) {
      if (scope === 0) {
        const value = locals[idx].value;
        if (value === TDZ_SENTINEL) throw new ReferenceError(`${func.localNames[idx] || `local${idx}`} is not defined before initialization`);
        return value;
      }
      if (scope === 1) return upvals[idx].value;
      const name = readRuntimeName(frame, idx);
      if (scope === 3 && !(name in hostGlobal)) return undefined;
      const runtimeBuiltin = readRuntimeBuiltin(name);
      if (runtimeBuiltin !== undefined) return runtimeBuiltin;
      if (scope === 2 && !(name in hostGlobal)) throw new ReferenceError(`${name} is not defined`);
      return hostGlobal[name];
    }
    function store(scope, idx, value) {
      if (scope === 0) locals[idx].value = value;
      else if (scope === 1) upvals[idx].value = value;
      else hostGlobal[readRuntimeName(frame, idx)] = value;
      return value;
    }
    try {
    while (true) {
      const seqPc = frame.pc;
      try {
        let dynMask = 0;
        let prefixCount = 0;
        let op = code[frame.pc++];
        while (op === OP_LOCAL.dyn) {
          if (++prefixCount > 8) throw new RangeError("dyn chain too long");
          const which = code[frame.pc++];
          assertDynOperandIndex(which);
          dynMask |= 1 << which;
          op = code[frame.pc++];
        }
        currentOp = op;
        let operandIdx = 0;
        function readOperand(readImmediate) {
          const idx = operandIdx++;
          if ((dynMask & (1 << idx)) !== 0) {
            return stack.pop();
          }
          return readImmediate();
        }
        const readU8Operand = () => readOperand(() => code[frame.pc++]);
        const readU16Operand = () => readOperand(() => { const value = readU16(code, frame.pc); frame.pc += 2; return value; });
        const readI16Operand = () => readOperand(() => { const value = readI16(code, frame.pc); frame.pc += 2; return value; });
        switch (op) {
          case OP_LOCAL.pop: stack.pop(); break;
          case OP_LOCAL.dup: stack.push(stack[stack.length - 1]); break;
          case OP_LOCAL.dup2: stack.push(stack[stack.length - 2], stack[stack.length - 1]); break;
          case OP_LOCAL.swap: { const b = stack.pop(); const a = stack.pop(); stack.push(b, a); break; }
          case OP_LOCAL.rot3: { const c = stack.pop(); const b = stack.pop(); const a = stack.pop(); stack.push(b, c, a); break; }
          case OP_LOCAL.push: { const index = readU16Operand(); stack.push(readRuntimeConstant(frame, index)); break; }
          case OP_LOCAL.push_i: stack.push(readI16Operand()); break;
          case OP_LOCAL.push_spec: { const kind = readU8Operand(); if (kind === 0) stack.push(frame.thisVal); else if (kind === 1) stack.push(frame.newTarget); else if (kind === 2) stack.push(mkArguments(frame)); else if (kind === 3) stack.push(makeSuperProxy(frame.homeClass, frame.thisVal)); else throw new Error(`Unsupported push_spec ${kind}`); break; }
          case OP_LOCAL.load: { const scope = readU8Operand(); const idx = readU16Operand(); stack.push(load(scope, idx)); break; }
          case OP_LOCAL.store: { const scope = readU8Operand(); const idx = readU16Operand(); stack.push(store(scope, idx, stack.pop())); break; }
          case OP_LOCAL.get_prop: { const name = readRuntimeName(frame, readU16Operand()); stack.push(stack.pop()[name]); break; }
          case OP_LOCAL.set_prop: { const name = readRuntimeName(frame, readU16Operand()); const value = stack.pop(); const obj = stack.pop(); obj[name] = value; stack.push(value); break; }
          case OP_LOCAL.get_elem: { const key = stack.pop(); const obj = stack.pop(); stack.push(obj[key]); break; }
          case OP_LOCAL.set_elem: { const value = stack.pop(); const key = stack.pop(); const obj = stack.pop(); obj[key] = value; stack.push(value); break; }
          case OP_LOCAL.del: { const flags = readU8Operand(); const nameIdx = readU16Operand(); if (flags === 0) { const obj = stack.pop(); stack.push(delete obj[readRuntimeName(frame, nameIdx)]); } else { const key = stack.pop(); const obj = stack.pop(); stack.push(delete obj[key]); } break; }
          case OP_LOCAL.get_private: { const slotIdx = readU16Operand(); const brand = stack.pop(); const obj = stack.pop(); if (!(brand instanceof WeakMap) || !brand.has(obj)) throw new TypeError("Private field brand check failed"); stack.push(brand.get(obj)[slotIdx]); break; }
          case OP_LOCAL.set_private: { const slotIdx = readU16Operand(); const value = stack.pop(); const brand = stack.pop(); const obj = stack.pop(); if (!(brand instanceof WeakMap) || !brand.has(obj)) throw new TypeError("Private field brand check failed"); brand.get(obj)[slotIdx] = value; break; }
          case OP_LOCAL.unop: stack.push(applyUn(readU8Operand(), stack.pop())); break;
          case OP_LOCAL.binop: { const opKind = readU8Operand(); const b = stack.pop(); const a = stack.pop(); stack.push(applyBin(opKind, a, b)); break; }
          case OP_LOCAL.mod_op: {
            const sub = readU8Operand();
            if (sub === 0) {
              stack.push(makeModuleHandle(deserialize(stack.pop()), hostGlobal));
            } else if (sub === 1) {
              const handle = expectModuleHandle(stack.pop());
              stack.push(execute(createFrame(handle.module, handle.module.entry, undefined, [], handle.hostGlobal, [])));
            } else if (sub === 2) {
              const funcIdx = stack.pop();
              const handle = expectModuleHandle(stack.pop());
              stack.push(materializeFunction(handle.module, funcIdx, [], handle.hostGlobal));
            } else if (sub === 3) {
              stack.push(vmBoot(stack.pop(), hostGlobal));
            } else {
              throw new Error(`Unsupported mod_op ${sub}`);
            }
            break;
          }
          case OP_LOCAL.jmp: { const off = readI16Operand(); frame.pc += off; break; }
          case OP_LOCAL.jmp_if: { const cond = readU8Operand(); const off = readI16Operand(); const top = stack[stack.length - 1]; let jump = false; if (cond === 0) jump = !!stack.pop(); else if (cond === 1) jump = !stack.pop(); else if (cond === 2) jump = !top; else if (cond === 3) jump = !!top; else if (cond === 4) jump = top !== null && top !== undefined; else if (cond === 5) { jump = top == null; if (jump) { stack.pop(); stack.push(undefined); } } if (jump) frame.pc += off; break; }
          case OP_LOCAL.ret: { const hasVal = readU8Operand(); returned = true; return hasVal ? stack.pop() : undefined; }
          case OP_LOCAL.throw: throw stack.pop();
          case OP_LOCAL.get_exc: stack.push(frame.currentException); break;
          case OP_LOCAL.call: { const flags = readU8Operand(); const argc = readU8Operand(); const rawArgs = stack.splice(stack.length - argc, argc); const callArgs = flattenArgs(rawArgs); const callee = stack.pop(); const recv = (flags & 1) ? stack.pop() : undefined; const result = callee.apply(recv, callArgs); stack.push(result); break; }
          case OP_LOCAL.call_method: { const name = readRuntimeName(frame, readU16Operand()); const argc = readU8Operand(); const rawArgs = stack.splice(stack.length - argc, argc); const obj = stack.pop(); const result = obj[name].apply(obj, flattenArgs(rawArgs)); stack.push(result); break; }
          case OP_LOCAL.call_new: { const argc = readU8Operand(); const rawArgs = stack.splice(stack.length - argc, argc); const ctor = stack.pop(); stack.push(new ctor(...flattenArgs(rawArgs))); break; }
          case OP_LOCAL.call_super: { const argc = readU8Operand(); const rawArgs = stack.splice(stack.length - argc, argc); if (typeof frame.superClass !== "function") throw new TypeError("call_super requires a super class"); const constructed = Reflect.construct(frame.superClass, flattenArgs(rawArgs), frame.newTarget || frame.superClass); frame.thisVal = constructed; break; }
          case OP_LOCAL.new_obj: stack.push({}); break;
          case OP_LOCAL.new_arr: { const size = readU16Operand(); stack.push(new Array(size)); break; }
          case OP_LOCAL.def_prop: {
            const flags = readU8Operand();
            const nameIdx = readU16Operand();
            if (flags === 3) {
              const target = stack[stack.length - 3];
              const value = stack.pop();
              const key = stack.pop();
              target[key] = value;
            } else if (flags === 1) {
              const target = stack[stack.length - 2];
              const getter = stack.pop();
              Object.defineProperty(target, readRuntimeName(frame, nameIdx), { get: getter, enumerable: true, configurable: true });
            } else if (flags === 2) {
              const target = stack[stack.length - 2];
              const setter = stack.pop();
              Object.defineProperty(target, readRuntimeName(frame, nameIdx), { set: setter, enumerable: true, configurable: true });
            } else {
              const target = stack[stack.length - 2];
              const value = stack.pop();
              target[readRuntimeName(frame, nameIdx)] = value;
            }
            break;
          }
          case OP_LOCAL.spread: { const target = readU8Operand(); const value = stack.pop(); if (target === 0) stack[stack.length - 1].push(...value); else if (target === 1) Object.assign(stack[stack.length - 1], value); else stack.push({ __vmSpread: true, values: Array.from(value) }); break; }
          case OP_LOCAL.make_func: { const idx = readU16Operand(); stack.push(materializeFunction(mod, idx, captureUpvalues(mod, idx, locals, upvals), hostGlobal, { currentFrame: frame, runtimeState })); break; }
          case OP_LOCAL.make_class: { const classIdx = readU16Operand(); stack.push(buildClass(mod, classIdx, hostGlobal, locals, upvals, stack, runtimeState)); break; }
          case OP_LOCAL.iter_op: { const kind = readU8Operand(); if (kind === 0) { stack.push(createForInIter(stack.pop())); } else if (kind === 1) { const off = readI16Operand(); const it = stack[stack.length - 1]; const step = it.next(); if (step.done) { stack.pop(); frame.pc += off; } else stack.push(step.value); } else if (kind === 2) stack.push(stack.pop()[Symbol.iterator]()); else if (kind === 3) stack.push(stack.pop().next()); else if (kind === 4) { const off = readI16Operand(); const r = stack.pop(); if (r.done) frame.pc += off; else stack.push(r.value); } else if (kind === 5) { const it = stack.pop(); if (it && typeof it.return === "function") it.return(); } else throw new Error(`Unsupported iter_op ${kind}`); break; }
          default: throw new Error(`Unsupported opcode ${op}`);
        }
      } catch (error) {
        const handler = findHandler(func.exTable || [], seqPc);
        if (!handler) {
          if (!runtimeState.pendingCrash || runtimeState.pendingCrash.error !== error) {
            runtimeState.pendingCrash = { error, text: formatVmCrash(error, frame, seqPc, currentOp) };
          }
          throw error;
        }
        if (runtimeState.pendingCrash && runtimeState.pendingCrash.error === error) runtimeState.pendingCrash = null;
        stack.length = handler.stackDepth;
        frame.currentException = error;
        frame.pc = handler.handler;
      }
    }
    } finally {
      if (returned || runtimeState.callstack[runtimeState.callstack.length - 1] === frame) runtimeState.callstack.pop();
    }
  }
  return { run, vmBoot };
}

function runVM(bytes, hostGlobal, entryFrameOptions) { return createRuntime(OP).run(bytes, hostGlobal, entryFrameOptions); }

const runtimeSource = `(${createRuntime.toString()})(${JSON.stringify(OP)}).run`;

module.exports = { CURRENT_VM_VERSION, runVM, runtimeSource };
