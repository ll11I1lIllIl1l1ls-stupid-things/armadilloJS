"use strict";

const { OP } = require("../opcodes");
const { FunctionContext } = require("./scope");
const { CompileError } = require("./errors");

function assertSupportedFunction(node) {
  if (node.async || node.generator) throw new CompileError(node, "Unsupported function");
}

function compileFunctionLike(node, parent, name, kind, params) {
  assertSupportedFunction(node);
  const usage = scanFrameUsage(node);
  const ctx = new FunctionContext(this, node, parent, name, kind);
  if (node.__iterationWrapper) ctx.iterationWrapper = node.__iterationWrapper;
  const idx = this.functions.length;
  this.functions.push(null);
  if (params) this.initParams(ctx, params);
  if (node.type === "FunctionExpression" && node.id && node.id.name) {
    ctx.selfNameSlot = ctx.addLocal(node.id.name, "lexical");
  }
  if (kind !== 1 && node.type !== "Program") {
    ctx.arrowSpecials = {
      thisSlot: ctx.addInternalLocal("<arrow this>", "lexical"),
      argumentsSlot: ctx.addInternalLocal("<arrow arguments>", "lexical"),
      newTargetSlot: ctx.addInternalLocal("<arrow new.target>", "lexical"),
    };
  }
  if (usage.hasArguments && node.type !== "Program" && kind !== 1) ctx.argumentsSlot = ctx.addLocal("arguments", "arguments");
  this.collectBindings(ctx, node);
  this.emitVarHoists(ctx);
  this.emitHoistedFunctions(ctx);
  this.emitDefaultParams(ctx);
  if (kind !== 1 && node.type !== "Program") {
    ctx.emit(OP.push_spec, { kind: "u8", value: 0 }); ctx.emitStore({ scope: 0, index: ctx.arrowSpecials.thisSlot }); ctx.emit(OP.pop);
    ctx.emit(OP.push_spec, { kind: "u8", value: 2 }); ctx.emitStore({ scope: 0, index: ctx.arrowSpecials.argumentsSlot }); ctx.emit(OP.pop);
    ctx.emit(OP.push_spec, { kind: "u8", value: 1 }); ctx.emitStore({ scope: 0, index: ctx.arrowSpecials.newTargetSlot }); ctx.emit(OP.pop);
  }
  if (node.type === "Program") this.compileStatements(ctx, node.body);
  else if (node.body.type === "BlockStatement") this.compileStatements(ctx, node.body.body);
  else { this.compileExpression(ctx, node.body); ctx.emit(OP.ret, { kind: "u8", value: 1 }); }
  ctx.emit(OP.ret, { kind: "u8", value: 0 });
  this.functions[idx] = {
    name,
    kind,
    flags: (usage.hasThis ? 1 : 0) | (ctx.argumentsSlot >= 0 ? 2 : 0),
    params: ctx.params,
    rest: ctx.rest,
    argumentsSlot: ctx.argumentsSlot,
    selfNameSlot: ctx.selfNameSlot,
    localNames: ctx.localNames,
    localInitKinds: ctx.localInitKinds,
    upvalues: ctx.upvalues,
    code: ctx.code.toUint8Array(),
    exTable: ctx.exTable,
  };
  return idx;
}

function emitVarHoists(ctx) {
  for (let index = 0; index < ctx.localInitKinds.length; index++) {
    if (ctx.localInitKinds[index] !== "var") continue;
    ctx.emitPush(undefined);
    ctx.emitStore({ scope: 0, index });
    ctx.emit(OP.pop);
  }
}

function emitDefaultParams(ctx) {
  for (const param of ctx.defaultParams || []) {
    ctx.emitLoad({ scope: 0, index: param.slot });
    const skip = ctx.jump(OP.jmp_if, 4);
    ctx.emit(OP.pop);
    this.compileExpression(ctx, param.right);
    ctx.emitStore({ scope: 0, index: param.slot });
    ctx.emit(OP.pop);
    ctx.patch(skip);
  }
}

function scanFrameUsage(node) {
  const usage = { hasThis: false, hasArguments: false };
  scanNode(node, usage, true);
  return usage;
}

function scanNode(node, usage, isRoot) {
  if (!node || typeof node !== "object") return;
  if (!isRoot && isFunctionNode(node)) return;
  if (node.type === "ThisExpression") usage.hasThis = true;
  if (node.type === "Identifier" && node.name === "arguments") usage.hasArguments = true;
  for (const key of Object.keys(node)) {
    if (key === "loc" || key === "start" || key === "end") continue;
    const value = node[key];
    if (Array.isArray(value)) {
      for (const item of value) scanNode(item, usage, false);
    } else scanNode(value, usage, false);
  }
}

function isFunctionNode(node) {
  return node.type === "FunctionDeclaration" || node.type === "FunctionExpression" || node.type === "ArrowFunctionExpression" || node.type === "ObjectMethod" || node.type === "ClassMethod" || node.type === "ClassPrivateMethod";
}

function emitHoistedFunctions(ctx) {
  for (const decl of ctx.functionDecls) {
    const fnIdx = this.compileFunctionLike(decl, ctx, decl.id.name, 0, decl.params);
    ctx.emit(OP.make_func, { kind: "u16", value: fnIdx });
    ctx.emitStore({ scope: 0, index: ctx.localMap.get(decl.id.name) });
    ctx.emit(OP.pop);
  }
}

module.exports = { compileFunctionLike, emitHoistedFunctions, emitVarHoists, emitDefaultParams };
