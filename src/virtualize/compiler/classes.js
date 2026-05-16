"use strict";

const { OP } = require("../opcodes");
const { CompileError } = require("./errors");

function rejectClass(node) {
  throw new CompileError(node, "Unsupported class syntax");
}

function compileClassDeclaration(ctx, stmt) {
  this.compileClassValue(ctx, stmt);
  ctx.emitStore({ scope: 0, index: ctx.localMap.get(stmt.id.name) });
  ctx.emit(OP.pop);
}

function compileClassExpression(ctx, expr) {
  if (expr.id) rejectClass(expr);
  this.compileClassValue(ctx, expr);
}

function compileClassValue(ctx, node) {
  assertSupportedBaseClass(node);
  const classIdx = this.classes.length;
  this.classes.push(this.buildClassDefinition(ctx, node));
  ctx.emit(OP.push, { kind: "u16", value: 1 });
  ctx.emit(OP.make_class, { kind: "u16", value: classIdx });
}

function buildClassDefinition(ctx, node) {
  const constructorNode = node.body.body.find((element) => element.type === "ClassMethod" && !element.static && element.kind === "constructor");
  const constructor = this.compileFunctionLike(
    constructorNode || createDefaultConstructorNode(),
    ctx,
    "constructor",
    5,
    constructorNode ? constructorNode.params : [],
  );
  const methods = [];
  const statics = [];
  for (const element of node.body.body) {
    if (element.type !== "ClassMethod") rejectClass(node);
    if (!element.static && element.kind === "constructor") continue;
    const target = element.static ? statics : methods;
    target.push(this.compileClassMethodDefinition(ctx, element));
  }
  return {
    nameIdx: node.id ? this.constIndex(node.id.name) : -1,
    constructor,
    methods,
    statics,
    privateSlots: [],
    isDerived: false,
    instanceFields: [],
    staticFields: [],
  };
}

function compileClassMethodDefinition(ctx, method) {
  const key = this.getClassMethodKey(method);
  const funcIdx = this.compileFunctionLike(method, ctx, String(key), 0, method.params);
  return {
    keyKind: 0,
    keyIndex: this.constIndex(key),
    funcIdx,
    kind: 0,
  };
}

function getClassMethodKey(method) {
  const key = method.key;
  if (key.type === "Identifier") return key.name;
  if (key.type === "StringLiteral") return key.value;
  if (key.type === "NumericLiteral") return String(key.value);
  rejectClass(method);
}

function assertSupportedBaseClass(node) {
  if (node.type !== "ClassDeclaration" && node.type !== "ClassExpression") rejectClass(node);
  if (node.superClass) rejectClass(node);
  if (!node.body || !Array.isArray(node.body.body)) rejectClass(node);
  let constructorCount = 0;
  for (const element of node.body.body) {
    if (element.type === "StaticBlock" || element.type === "ClassProperty" || element.type === "ClassPrivateProperty" || element.type === "ClassAccessorProperty" || element.type === "ClassPrivateMethod") rejectClass(node);
    if (element.type !== "ClassMethod") rejectClass(node);
    if (element.computed || element.kind === "get" || element.kind === "set") rejectClass(node);
    if (element.key && element.key.type === "PrivateName") rejectClass(node);
    if (!element.static && element.kind === "constructor" && ++constructorCount > 1) rejectClass(node);
    getClassMethodKey(element);
  }
}

function createDefaultConstructorNode() {
  return {
    type: "FunctionExpression",
    async: false,
    generator: false,
    params: [],
    body: {
      type: "BlockStatement",
      body: [],
    },
  };
}

module.exports = {
  rejectClass,
  compileClassDeclaration,
  compileClassExpression,
  compileClassValue,
  buildClassDefinition,
  compileClassMethodDefinition,
  getClassMethodKey,
};
