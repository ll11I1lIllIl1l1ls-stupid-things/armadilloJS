"use strict";

const { BytecodeBuffer } = require("./context");

class FunctionContext {
  constructor(compiler, node, parent, name, kind) {
    this.compiler = compiler;
    this.node = node;
    this.parent = parent;
    this.name = name || "";
    this.kind = kind || 0;
    this.code = new BytecodeBuffer();
    this.localMap = new Map();
    this.localNames = [];
    this.localInitKinds = [];
    this.params = [];
    this.rest = -1;
    this.argumentsSlot = -1;
    this.selfNameSlot = -1;
    this.upvalues = [];
    this.upvalueMap = new Map();
    this.exTable = [];
    this.loopStack = [];
    this.finallyStack = [];
    this.functionDecls = [];
    this.pendingLabels = [];
    this.residentStackDepth = 0;
    this.iterationWrapper = null;
    this.nextControlId = 1;
  }

  addLocal(name, initKind = "lexical") {
    if (this.localMap.has(name)) return this.localMap.get(name);
    const idx = this.localNames.length;
    this.localMap.set(name, idx);
    this.localNames.push(name);
    this.localInitKinds.push(initKind);
    return idx;
  }

  addInternalLocal(name, initKind = "lexical") {
    const idx = this.localNames.length;
    this.localNames.push(name);
    this.localInitKinds.push(initKind);
    return idx;
  }

  markLocalInitKind(name, initKind) {
    const idx = this.addLocal(name, initKind);
    if (!["param", "rest", "arguments"].includes(this.localInitKinds[idx])) this.localInitKinds[idx] = initKind;
    return idx;
  }

  hasLocal(name) { return this.localMap.has(name); }

  resolve(name) {
    if (this.localMap.has(name)) return { scope: 0, index: this.localMap.get(name) };
    if (!this.parent) return { scope: 2, index: this.compiler.constIndex(name) };
    const parentRef = this.parent.resolveForChild(name);
    if (!parentRef) return { scope: 2, index: this.compiler.constIndex(name) };
    const key = `${parentRef.scope}:${parentRef.index}`;
    if (!this.upvalueMap.has(key)) {
      this.upvalueMap.set(key, this.upvalues.length);
      this.upvalues.push(parentRef);
    }
    return { scope: 1, index: this.upvalueMap.get(key) };
  }

  resolveForChild(name) {
    if (this.localMap.has(name)) return { scope: 0, index: this.localMap.get(name) };
    if (!this.parent) return null;
    const parentRef = this.parent.resolveForChild(name);
    if (!parentRef) return null;
    const key = `${parentRef.scope}:${parentRef.index}`;
    if (!this.upvalueMap.has(key)) {
      this.upvalueMap.set(key, this.upvalues.length);
      this.upvalues.push(parentRef);
    }
    return { scope: 1, index: this.upvalueMap.get(key) };
  }

  resolveArrowSpecial(special) {
    if (!this.parent) return { scope: 2, index: this.compiler.constIndex(special) };
    const parentRef = this.parent.resolveArrowSpecialForChild(special);
    if (!parentRef) return { scope: 2, index: this.compiler.constIndex(special) };
    const key = `special:${special}:${parentRef.scope}:${parentRef.index}`;
    if (!this.upvalueMap.has(key)) {
      this.upvalueMap.set(key, this.upvalues.length);
      this.upvalues.push(parentRef);
    }
    return { scope: 1, index: this.upvalueMap.get(key) };
  }

  resolveArrowSpecialForChild(special) {
    if (this.kind !== 1 && this.arrowSpecials) {
      if (special === "this") return { scope: 0, index: this.arrowSpecials.thisSlot };
      if (special === "arguments") return { scope: 0, index: this.arrowSpecials.argumentsSlot };
      return { scope: 0, index: this.arrowSpecials.newTargetSlot };
    }
    if (!this.parent) return null;
    const parentRef = this.parent.resolveArrowSpecialForChild(special);
    if (!parentRef) return null;
    const key = `special:${special}:${parentRef.scope}:${parentRef.index}`;
    if (!this.upvalueMap.has(key)) {
      this.upvalueMap.set(key, this.upvalues.length);
      this.upvalues.push(parentRef);
    }
    return { scope: 1, index: this.upvalueMap.get(key) };
  }

  emit(op, ...operands) {
    if (this.currentNode && this.currentNode.loc) {
      const { line, column } = this.currentNode.loc.start;
      this.srcMap.push({ pc: this.code.position, line, column });
    }
    this.code.emitOp(op);
    for (const operand of operands) this.code.emitOperand(operand);
  }

  emitDyn(op, dynamicWhich, ...operands) { this.code.emitDynOp(op, dynamicWhich, ...operands); }

  emitLoad(ref) { this.emit(require("../opcodes").OP.load, { kind: "u8", value: ref.scope }, { kind: "u16", value: ref.index }); }
  emitStore(ref) { this.emit(require("../opcodes").OP.store, { kind: "u8", value: ref.scope }, { kind: "u16", value: ref.index }); }

  emitPush(value) {
    const { OP } = require("../opcodes");
    if (Number.isInteger(value) && value >= -32768 && value <= 32767) this.emit(OP.push_i, { kind: "i16", value });
    else this.emit(OP.push, { kind: "u16", value: this.compiler.constIndex(value) });
  }

  jump(op, cond) {
    const { OP } = require("../opcodes");
    this.code.emitOp(op);
    if (op === OP.jmp_if) this.code.emitU8(cond);
    return this.code.emitI16(0);
  }

  patch(pos, target = this.code.position) { this.code.patchI16(pos, target - (pos + 2)); }
}

module.exports = { FunctionContext };
