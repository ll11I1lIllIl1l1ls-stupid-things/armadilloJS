"use strict";

const { OP } = require("../opcodes");
const { CompileError } = require("./errors");

function collectBindings(ctx, node) {
  const body = node.type === "Program" ? node.body : node.body && node.body.type === "BlockStatement" ? node.body.body : [];
  for (const stmt of body) this.collectStatementBindings(ctx, stmt);
}

function collectStatementBindings(ctx, stmt) {
  if (!stmt) return;
  if (stmt.type === "LabeledStatement") { this.collectStatementBindings(ctx, stmt.body); return; }
  if (stmt.type === "FunctionDeclaration") { ctx.markLocalInitKind(stmt.id.name, "var"); ctx.functionDecls.push(stmt); return; }
  if (stmt.type === "ClassDeclaration") { ctx.markLocalInitKind(stmt.id.name, "lexical"); return; }
  if (stmt.type === "VariableDeclaration") for (const d of stmt.declarations) this.collectPatternBindings(ctx, d.id, stmt.kind === "var" ? "var" : "lexical");
  if (stmt.type === "BlockStatement") for (const s of stmt.body) this.collectStatementBindings(ctx, s);
   if (stmt.type === "IfStatement") {
     this.collectStatementBindings(ctx, stmt.consequent);
     if (stmt.alternate) this.collectStatementBindings(ctx, stmt.alternate);
   }
   if (stmt.type === "ForStatement") {
     if (stmt.init && stmt.init.type === "VariableDeclaration") {
       for (const d of stmt.init.declarations) this.collectPatternBindings(ctx, d.id, stmt.init.kind === "var" ? "var" : "lexical");
     }
     this.collectStatementBindings(ctx, stmt.body);
   }
   if (stmt.type === "WhileStatement" || stmt.type === "DoWhileStatement") {
     this.collectStatementBindings(ctx, stmt.body);
   }
   if (stmt.type === "ForInStatement" || stmt.type === "ForOfStatement") {
     if (stmt.left.type === "VariableDeclaration") {
       for (const d of stmt.left.declarations) this.collectPatternBindings(ctx, d.id, stmt.left.kind === "var" ? "var" : "lexical");
     }
     this.collectStatementBindings(ctx, stmt.body);
   }
   if (stmt.type === "SwitchStatement") {
     for (const switchCase of stmt.cases) {
       for (const consequent of switchCase.consequent) this.collectStatementBindings(ctx, consequent);
     }
   }
   if (stmt.type === "TryStatement") {
     this.collectStatementBindings(ctx, stmt.block);
     if (stmt.handler && stmt.handler.param) this.collectPatternBindings(ctx, stmt.handler.param, "lexical");
     if (stmt.handler) this.collectStatementBindings(ctx, stmt.handler.body);
     if (stmt.finalizer) this.collectStatementBindings(ctx, stmt.finalizer);
  }
}

function compileVarDecl(ctx, stmt) {
  for (const d of stmt.declarations) {
    if (d.init) this.compileExpression(ctx, d.init); else ctx.emit(OP.push, { kind: "u16", value: 1 });
    if (d.id.type === "Identifier") {
      const ref = { scope: 0, index: ctx.localMap.get(d.id.name) };
      ctx.emitStore(ref);
      ctx.emit(OP.pop);
      continue;
    }
    if (d.id.type === "ObjectPattern") {
      this.compileBindingPattern(ctx, d.id);
      continue;
    }
    throw new CompileError(d.id, "Unsupported variable pattern");
  }
}

module.exports = { collectBindings, collectStatementBindings, compileVarDecl };
