"use strict";

const { OP, BINOP } = require("../opcodes");
const { CompileError } = require("./errors");

function collectPatternBindings(ctx, pattern, initKind = "lexical") {
  if (pattern.type === "Identifier") ctx.markLocalInitKind(pattern.name, initKind);
  else if (pattern.type === "RestElement") this.collectPatternBindings(ctx, pattern.argument, initKind);
  else if (pattern.type === "AssignmentPattern") this.collectPatternBindings(ctx, pattern.left, initKind);
  else if (pattern.type === "ObjectPattern") {
    for (const property of pattern.properties) {
      if (property.type === "RestElement") throw new CompileError(property, "Unsupported binding pattern");
      this.collectPatternBindings(ctx, property.value, initKind);
    }
  }
  else throw new CompileError(pattern, "Unsupported binding pattern");
}

function compileBindingPattern(ctx, pattern) {
  if (pattern.type === "Identifier") {
    ctx.emitStore(ctx.resolve(pattern.name));
    ctx.emit(OP.pop);
    return;
  }

  if (pattern.type === "AssignmentPattern") {
    this.emitPatternDefault(ctx, pattern.right);
    this.compileBindingPattern(ctx, pattern.left);
    return;
  }

  if (pattern.type === "ObjectPattern") {
    const sourceSlot = ctx.addInternalLocal(`<object pattern ${ctx.localNames.length}>`, "lexical");
    ctx.emitStore({ scope: 0, index: sourceSlot });
    ctx.emit(OP.pop);
    for (const property of pattern.properties) {
      if (property.type === "RestElement") throw new CompileError(property, "Unsupported binding pattern");
      ctx.emitLoad({ scope: 0, index: sourceSlot });
      if (property.computed) {
        this.compileExpression(ctx, property.key);
        ctx.emit(OP.get_elem);
      } else {
        ctx.emit(OP.get_prop, { kind: "u16", value: this.constIndex(this.getPatternPropertyKey(property.key)) });
      }
      this.compileBindingPattern(ctx, property.value);
    }
    return;
  }

  throw new CompileError(pattern, "Unsupported binding pattern");
}

function emitPatternDefault(ctx, right) {
  ctx.emit(OP.dup);
  ctx.emit(OP.push, { kind: "u16", value: 1 });
  ctx.emit(OP.binop, { kind: "u8", value: BINOP["==="] });
  const skip = ctx.jump(OP.jmp_if, 1);
  ctx.emit(OP.pop);
  this.compileExpression(ctx, right);
  ctx.patch(skip);
}

function getPatternPropertyKey(key) {
  if (key.type === "Identifier") return key.name;
  if (Object.prototype.hasOwnProperty.call(key, "value")) return key.value;
  throw new CompileError(key, "Unsupported binding pattern");
}

function initParams(ctx, params) {
  ctx.defaultParams = [];
  for (const p of params) {
    if (p.type === "Identifier") {
      ctx.params.push(ctx.addLocal(p.name, "param"));
    } else if (p.type === "AssignmentPattern" && p.left.type === "Identifier") {
      const slot = ctx.addLocal(p.left.name, "param");
      ctx.params.push(slot);
      ctx.defaultParams.push({ slot, right: p.right });
    } else if (p.type === "RestElement" && p.argument.type === "Identifier") {
      ctx.rest = ctx.addLocal(p.argument.name, "rest");
    } else {
      throw new CompileError(p, "Unsupported function parameter");
    }
  }
}

module.exports = { collectPatternBindings, compileBindingPattern, emitPatternDefault, getPatternPropertyKey, initParams };
