"use strict";

const { OP, BINOP } = require("../opcodes");
const { CompileError } = require("./errors");

function compileStatements(ctx, statements) { for (const stmt of statements) this.compileStatement(ctx, stmt); }

function compileStatement(ctx, stmt) {
  switch (stmt.type) {
    case "EmptyStatement": break;
    case "BlockStatement": this.compileStatements(ctx, stmt.body); break;
    case "LabeledStatement": this.compileLabeled(ctx, stmt); break;
    case "FunctionDeclaration": if (stmt.async || stmt.generator) throw new CompileError(stmt, "Unsupported function"); break;
    case "ClassDeclaration": this.compileClassDeclaration(ctx, stmt); break;
    case "VariableDeclaration": this.compileVarDecl(ctx, stmt); break;
    case "ExpressionStatement": this.compileExpression(ctx, stmt.expression); ctx.emit(OP.pop); break;
    case "ReturnStatement": this.compileReturn(ctx, stmt); break;
    case "ThrowStatement": this.compileThrow(ctx, stmt); break;
    case "IfStatement": this.compileIf(ctx, stmt); break;
    case "ForStatement": this.compileFor(ctx, stmt); break;
    case "WhileStatement": this.compileWhile(ctx, stmt); break;
    case "DoWhileStatement": this.compileDoWhile(ctx, stmt); break;
    case "ForInStatement": this.compileForIn(ctx, stmt); break;
    case "ForOfStatement": this.compileForOf(ctx, stmt); break;
    case "BreakStatement": this.compileBreak(ctx, stmt); break;
    case "ContinueStatement": this.compileContinue(ctx, stmt); break;
    case "SwitchStatement": this.compileSwitch(ctx, stmt); break;
    case "TryStatement": this.compileTry(ctx, stmt); break;
    default: throw new CompileError(stmt, "Unsupported statement");
  }
}

function compileLabeled(ctx, stmt) {
  if (!["ForStatement", "WhileStatement", "DoWhileStatement", "ForInStatement", "ForOfStatement", "SwitchStatement"].includes(stmt.body.type)) {
    throw new CompileError(stmt, "Unsupported statement");
  }
  stmt.body._labelName = stmt.label.name;
  this.compileStatement(ctx, stmt.body);
}

function createControlRecord(ctx, labelName, iteratorCleanup, breakable = true, continuable = true) {
  return {
    breaks: breakable ? [] : null,
    continues: continuable ? [] : null,
    continueTarget: null,
    finallyOwner: ctx.finallyStack.length ? ctx.finallyStack[ctx.finallyStack.length - 1] : null,
    labelName: labelName || null,
    controlId: ctx.nextControlId++,
    iteratorCleanup: !!iteratorCleanup,
  };
}

function compileIf(ctx, stmt) {
  this.compileExpression(ctx, stmt.test);
  const elseJump = ctx.jump(OP.jmp_if, 1);
  this.compileStatement(ctx, stmt.consequent);
  const endJump = ctx.jump(OP.jmp);
  ctx.patch(elseJump);
  if (stmt.alternate) this.compileStatement(ctx, stmt.alternate);
  ctx.patch(endJump);
}

function compileFor(ctx, stmt) {
  const wrapped = getCapturedForLetNames(stmt);
  if (stmt.init) stmt.init.type === "VariableDeclaration" ? this.compileVarDecl(ctx, stmt.init) : (this.compileExpression(ctx, stmt.init), ctx.emit(OP.pop));
  const start = ctx.code.position;
  let exitJump = null;
  if (stmt.test) { this.compileExpression(ctx, stmt.test); exitJump = ctx.jump(OP.jmp_if, 1); }
  const loop = createControlRecord(ctx, stmt._labelName, false, true, true);
  ctx.loopStack.push(loop);
  if (wrapped.length) this.compileForIterationWrapper(ctx, stmt.body, wrapped, loop);
  else this.compileStatement(ctx, stmt.body);
  loop.continueTarget = ctx.code.position;
  for (const pos of loop.continues) ctx.patch(pos, loop.continueTarget);
  if (stmt.update) { this.compileExpression(ctx, stmt.update); ctx.emit(OP.pop); }
  const back = ctx.jump(OP.jmp); ctx.patch(back, start);
  const end = ctx.code.position;
  if (exitJump !== null) ctx.patch(exitJump, end);
  for (const pos of loop.breaks) ctx.patch(pos, end);
  ctx.loopStack.pop();
}

function getCapturedForLetNames(stmt) {
  if (!stmt.init || stmt.init.type !== "VariableDeclaration" || stmt.init.kind !== "let") return [];
  const names = stmt.init.declarations.filter((decl) => decl.id.type === "Identifier").map((decl) => decl.id.name);
  if (!names.length || !containsCapturedName(stmt.body, new Set(names), false)) return [];
  return names;
}

function getCapturedForInOfLetNames(stmt) {
  if (!stmt.left || stmt.left.type !== "VariableDeclaration" || stmt.left.kind !== "let") return [];
  const names = stmt.left.declarations.filter((decl) => decl.id.type === "Identifier").map((decl) => decl.id.name);
  if (!names.length || !containsCapturedName(stmt.body, new Set(names), false)) return [];
  return names;
}

function containsCapturedName(node, names, inFunction) {
  if (!node || typeof node !== "object") return false;
  if (node.type === "Identifier" && inFunction && names.has(node.name)) return true;
  const isFunction = node.type === "FunctionDeclaration" || node.type === "FunctionExpression" || node.type === "ArrowFunctionExpression";
  for (const key of Object.keys(node)) {
    if (key === "loc" || key === "start" || key === "end") continue;
    const value = node[key];
    if (Array.isArray(value)) {
      for (const item of value) if (containsCapturedName(item, names, inFunction || isFunction)) return true;
    } else if (containsCapturedName(value, names, inFunction || isFunction)) return true;
  }
  return false;
}

function compileForIterationWrapper(ctx, body, names, loop) {
  const wrapper = {
    type: "FunctionExpression",
    async: false,
    generator: false,
    id: null,
    params: names.map((name) => ({ type: "Identifier", name })),
    body: body.type === "BlockStatement" ? body : { type: "BlockStatement", body: [body] },
    __iterationWrapper: {
      controlId: loop.controlId,
      labelName: loop.labelName,
      iteratorCleanup: loop.iteratorCleanup,
    },
  };
  const fnIdx = this.compileFunctionLike(wrapper, ctx, "$forIteration", 0, wrapper.params);
  ctx.emit(OP.make_func, { kind: "u16", value: fnIdx });
  for (const name of names) ctx.emitLoad(ctx.resolve(name));
  ctx.emit(OP.call, { kind: "u8", value: 0 }, { kind: "u8", value: names.length });

  const resultSlot = ctx.addInternalLocal(`<iteration result ${ctx.localNames.length}>`, "lexical");
  const kindSlot = ctx.addInternalLocal(`<iteration kind ${ctx.localNames.length}>`, "lexical");
  const valueSlot = ctx.addInternalLocal(`<iteration value ${ctx.localNames.length}>`, "lexical");
  const targetSlot = ctx.addInternalLocal(`<iteration target ${ctx.localNames.length}>`, "lexical");

  ctx.emitStore({ scope: 0, index: resultSlot });
  ctx.emit(OP.pop);
  ctx.emitLoad({ scope: 0, index: resultSlot });
  const normal = ctx.jump(OP.jmp_if, 5);
  ctx.emit(OP.pop);

  ctx.emitLoad({ scope: 0, index: resultSlot });
  ctx.emit(OP.get_prop, { kind: "u16", value: this.constIndex("__vmKind") });
  ctx.emitStore({ scope: 0, index: kindSlot });
  ctx.emit(OP.pop);
  ctx.emitLoad({ scope: 0, index: resultSlot });
  ctx.emit(OP.get_prop, { kind: "u16", value: this.constIndex("__vmValue") });
  ctx.emitStore({ scope: 0, index: valueSlot });
  ctx.emit(OP.pop);
  ctx.emitLoad({ scope: 0, index: resultSlot });
  ctx.emit(OP.get_prop, { kind: "u16", value: this.constIndex("__vmTarget") });
  ctx.emitStore({ scope: 0, index: targetSlot });
  ctx.emit(OP.pop);

  this.emitCompletionDispatch(ctx, { kindSlot, valueSlot, targetSlot });
  ctx.patch(normal);
  ctx.emit(OP.pop);
}

function compileWhile(ctx, stmt) {
  const start = ctx.code.position;
  this.compileExpression(ctx, stmt.test);
  const exitJump = ctx.jump(OP.jmp_if, 1);
  const loop = createControlRecord(ctx, stmt._labelName, false, true, true);
  loop.continueTarget = start;
  ctx.loopStack.push(loop);
  this.compileStatement(ctx, stmt.body);
  for (const pos of loop.continues) ctx.patch(pos, start);
  const back = ctx.jump(OP.jmp);
  ctx.patch(back, start);
  const end = ctx.code.position;
  ctx.patch(exitJump, end);
  for (const pos of loop.breaks) ctx.patch(pos, end);
  ctx.loopStack.pop();
}

function compileDoWhile(ctx, stmt) {
  const start = ctx.code.position;
  const loop = createControlRecord(ctx, stmt._labelName, false, true, true);
  ctx.loopStack.push(loop);
  this.compileStatement(ctx, stmt.body);
  loop.continueTarget = ctx.code.position;
  for (const pos of loop.continues) ctx.patch(pos, loop.continueTarget);
  this.compileExpression(ctx, stmt.test);
  const done = ctx.jump(OP.jmp_if, 1);
  const back = ctx.jump(OP.jmp);
  ctx.patch(back, start);
  const end = ctx.code.position;
  ctx.patch(done, end);
  for (const pos of loop.breaks) ctx.patch(pos, end);
  ctx.loopStack.pop();
}

function compileForIn(ctx, stmt) {
  const wrapped = getCapturedForInOfLetNames(stmt);
  this.compileExpression(ctx, stmt.right);
  ctx.emit(OP.iter_op, { kind: "u8", value: 0 });
  ctx.residentStackDepth++;
  const start = ctx.code.position;
  ctx.code.emitOp(OP.iter_op);
  ctx.code.emitU8(1);
  const exitPos = ctx.code.emitI16(0);
  const loop = createControlRecord(ctx, stmt._labelName, false, true, true);
  loop.continueTarget = start;
  ctx.loopStack.push(loop);
  this.storeLoopLeft(ctx, stmt.left);
  if (wrapped.length) this.compileForIterationWrapper(ctx, stmt.body, wrapped, loop);
  else this.compileStatement(ctx, stmt.body);
  for (const pos of loop.continues) ctx.patch(pos, start);
  const back = ctx.jump(OP.jmp);
  ctx.patch(back, start);
  const end = ctx.code.position;
  ctx.patch(exitPos, end);
  for (const pos of loop.breaks) ctx.patch(pos, end);
  ctx.loopStack.pop();
  ctx.residentStackDepth--;
}

function compileForOf(ctx, stmt) {
  const wrapped = getCapturedForInOfLetNames(stmt);
  this.compileExpression(ctx, stmt.right);
  ctx.emit(OP.iter_op, { kind: "u8", value: 2 });
  ctx.residentStackDepth++;
  const start = ctx.code.position;
  ctx.emit(OP.dup);
  ctx.emit(OP.iter_op, { kind: "u8", value: 3 });
  ctx.code.emitOp(OP.iter_op);
  ctx.code.emitU8(4);
  const exitPos = ctx.code.emitI16(0);
  const loop = createControlRecord(ctx, stmt._labelName, true, true, true);
  loop.continueTarget = start;
  ctx.loopStack.push(loop);
  this.storeLoopLeft(ctx, stmt.left);
  if (wrapped.length) this.compileForIterationWrapper(ctx, stmt.body, wrapped, loop);
  else this.compileStatement(ctx, stmt.body);
  for (const pos of loop.continues) ctx.patch(pos, start);
  const back = ctx.jump(OP.jmp);
  ctx.patch(back, start);
  const doneCleanup = ctx.code.position;
  ctx.emit(OP.pop);
  const doneJump = ctx.jump(OP.jmp);
  const breakCleanup = ctx.code.position;
  ctx.emit(OP.iter_op, { kind: "u8", value: 5 });
  const end = ctx.code.position;
  ctx.patch(exitPos, doneCleanup);
  ctx.patch(doneJump, end);
  for (const pos of loop.breaks) ctx.patch(pos, breakCleanup);
  ctx.loopStack.pop();
  ctx.residentStackDepth--;
}

function storeLoopLeft(ctx, left) {
  if (left.type === "VariableDeclaration") {
    const pattern = left.declarations[0].id;
    if (pattern.type === "Identifier") {
      ctx.emitStore(ctx.resolve(pattern.name));
      ctx.emit(OP.pop);
      return;
    }
    if (pattern.type === "ObjectPattern") {
      this.compileBindingPattern(ctx, pattern);
      return;
    }
  } else if (left.type === "Identifier") {
    ctx.emitStore(ctx.resolve(left.name));
    ctx.emit(OP.pop);
    return;
  }
  throw new CompileError(left, "Unsupported loop left");
}

function resolveBreakTarget(ctx, labelName) {
  if (labelName) {
    for (let i = ctx.loopStack.length - 1; i >= 0; i--) {
      const record = ctx.loopStack[i];
      if (record.labelName === labelName && record.breaks) return { kind: "local", record };
    }
    if (ctx.iterationWrapper && ctx.iterationWrapper.labelName === labelName) return { kind: "wrapper", record: ctx.iterationWrapper };
    return null;
  }
  for (let i = ctx.loopStack.length - 1; i >= 0; i--) {
    if (ctx.loopStack[i].breaks) return { kind: "local", record: ctx.loopStack[i] };
  }
  if (ctx.iterationWrapper) return { kind: "wrapper", record: ctx.iterationWrapper };
  return null;
}

function resolveContinueTarget(ctx, labelName) {
  if (labelName) {
    for (let i = ctx.loopStack.length - 1; i >= 0; i--) {
      const record = ctx.loopStack[i];
      if (record.labelName === labelName && record.continues) return { kind: "local", record };
    }
    if (ctx.iterationWrapper && ctx.iterationWrapper.labelName === labelName) return { kind: "wrapper", record: ctx.iterationWrapper };
    return null;
  }
  for (let i = ctx.loopStack.length - 1; i >= 0; i--) {
    if (ctx.loopStack[i].continues) return { kind: "local", record: ctx.loopStack[i] };
  }
  if (ctx.iterationWrapper) return { kind: "wrapper", record: ctx.iterationWrapper };
  return null;
}

function compileBreak(ctx, stmt) {
  const target = resolveBreakTarget(ctx, stmt && stmt.label ? stmt.label.name : null);
  if (!target) throw new Error("break outside loop");
  if (ctx.finallyStack.length && target.record.finallyOwner !== ctx.finallyStack[ctx.finallyStack.length - 1]) {
    this.emitCompletion(ctx, "break", target.record.controlId);
    return;
  }
  if (target.kind === "wrapper") { this.emitWrapperCompletion(ctx, 3, false, target.record.controlId); return; }
  if (target.record.iteratorCleanup) ctx.emit(OP.iter_op, { kind: "u8", value: 5 });
  target.record.breaks.push(ctx.jump(OP.jmp));
}

function compileContinue(ctx, stmt) {
  const target = resolveContinueTarget(ctx, stmt && stmt.label ? stmt.label.name : null);
  if (!target) throw new Error("continue outside loop");
  if (ctx.finallyStack.length && target.record.finallyOwner !== ctx.finallyStack[ctx.finallyStack.length - 1]) {
    this.emitCompletion(ctx, "continue", target.record.controlId);
    return;
  }
  if (target.kind === "wrapper") { this.emitWrapperCompletion(ctx, 4, false, target.record.controlId); return; }
  target.record.continues.push(ctx.jump(OP.jmp));
}

function compileReturn(ctx, stmt) {
  if (!ctx.finallyStack.length) {
    if (ctx.iterationWrapper) {
      if (stmt.argument) this.compileExpression(ctx, stmt.argument);
      this.emitWrapperCompletion(ctx, 2, !!stmt.argument, null);
      return;
    }
    if (stmt.argument) {
      this.compileExpression(ctx, stmt.argument);
      const valueSlot = ctx.addInternalLocal(`<return value ${ctx.localNames.length}>`, "lexical");
      ctx.emitStore({ scope: 0, index: valueSlot });
      ctx.emit(OP.pop);
      this.emitActiveIteratorCleanup(ctx);
      ctx.emitLoad({ scope: 0, index: valueSlot });
      ctx.emit(OP.ret, { kind: "u8", value: 1 });
    } else {
      this.emitActiveIteratorCleanup(ctx);
      ctx.emit(OP.ret, { kind: "u8", value: 0 });
    }
    return;
  }
  const top = ctx.finallyStack[ctx.finallyStack.length - 1];
  if (stmt.argument) this.compileExpression(ctx, stmt.argument); else ctx.emit(OP.push, { kind: "u16", value: 1 });
  ctx.emitStore({ scope: 0, index: top.valueSlot });
  ctx.emit(OP.pop);
  ctx.emitPush(2);
  ctx.emitStore({ scope: 0, index: top.kindSlot });
  ctx.emit(OP.pop);
  ctx.emitPush(0);
  ctx.emitStore({ scope: 0, index: top.targetSlot });
  ctx.emit(OP.pop);
  top.exits.push(ctx.jump(OP.jmp));
}

function compileThrow(ctx, stmt) {
  if (!ctx.finallyStack.length || !ctx.finallyStack[ctx.finallyStack.length - 1].captureThrow) {
    this.compileExpression(ctx, stmt.argument);
    if (ctx.iterationWrapper) {
      this.emitWrapperCompletion(ctx, 1, true, null);
      return;
    }
    const valueSlot = ctx.addInternalLocal(`<throw value ${ctx.localNames.length}>`, "lexical");
    ctx.emitStore({ scope: 0, index: valueSlot });
    ctx.emit(OP.pop);
    this.emitActiveIteratorCleanup(ctx);
    ctx.emitLoad({ scope: 0, index: valueSlot });
    ctx.emit(OP.throw);
    return;
  }
  const top = ctx.finallyStack[ctx.finallyStack.length - 1];
  this.compileExpression(ctx, stmt.argument);
  ctx.emitStore({ scope: 0, index: top.valueSlot });
  ctx.emit(OP.pop);
  ctx.emitPush(1);
  ctx.emitStore({ scope: 0, index: top.kindSlot });
  ctx.emit(OP.pop);
  ctx.emitPush(0);
  ctx.emitStore({ scope: 0, index: top.targetSlot });
  ctx.emit(OP.pop);
  top.exits.push(ctx.jump(OP.jmp));
}

function emitActiveIteratorCleanup(ctx) {
  for (let i = ctx.loopStack.length - 1; i >= 0; i--) {
    if (ctx.loopStack[i].iteratorCleanup) ctx.emit(OP.iter_op, { kind: "u8", value: 5 });
  }
}

function emitCompletion(ctx, type, targetId) {
  const top = ctx.finallyStack[ctx.finallyStack.length - 1];
  ctx.emitPush(type === "break" ? 3 : 4);
  ctx.emitStore({ scope: 0, index: top.kindSlot });
  ctx.emit(OP.pop);
  ctx.emit(OP.push, { kind: "u16", value: 1 });
  ctx.emitStore({ scope: 0, index: top.valueSlot });
  ctx.emit(OP.pop);
  ctx.emitPush(targetId || 0);
  ctx.emitStore({ scope: 0, index: top.targetSlot });
  ctx.emit(OP.pop);
  top.exits.push(ctx.jump(OP.jmp));
}

function emitWrapperCompletion(ctx, kind, hasValue, targetId) {
  let valueSlot = -1;
  if (hasValue) {
    valueSlot = ctx.addInternalLocal(`<wrapper value ${ctx.localNames.length}>`, "lexical");
    ctx.emitStore({ scope: 0, index: valueSlot });
    ctx.emit(OP.pop);
  }
  ctx.emit(OP.new_obj);
  ctx.emitPush(kind);
  ctx.emit(OP.def_prop, { kind: "u8", value: 0 }, { kind: "u16", value: this.constIndex("__vmKind") });
  if (hasValue) ctx.emitLoad({ scope: 0, index: valueSlot });
  else ctx.emit(OP.push, { kind: "u16", value: 1 });
  ctx.emit(OP.def_prop, { kind: "u8", value: 0 }, { kind: "u16", value: this.constIndex("__vmValue") });
  if (targetId == null) ctx.emit(OP.push, { kind: "u16", value: 1 });
  else ctx.emitPush(targetId);
  ctx.emit(OP.def_prop, { kind: "u8", value: 0 }, { kind: "u16", value: this.constIndex("__vmTarget") });
  ctx.emit(OP.ret, { kind: "u8", value: 1 });
}

function emitLoopControlDispatch(ctx, targetSlot, kind) {
  const doneJumps = [];
  for (let i = ctx.loopStack.length - 1; i >= 0; i--) {
    const record = ctx.loopStack[i];
    if (kind === 3 && !record.breaks) continue;
    if (kind === 4 && !record.continues) continue;
    ctx.emitLoad({ scope: 0, index: targetSlot });
    ctx.emitPush(record.controlId);
    ctx.emit(OP.binop, { kind: "u8", value: BINOP["==="] });
    const next = ctx.jump(OP.jmp_if, 1);
    if (kind === 3 && record.iteratorCleanup) ctx.emit(OP.iter_op, { kind: "u8", value: 5 });
    (kind === 3 ? record.breaks : record.continues).push(ctx.jump(OP.jmp));
    doneJumps.push(ctx.jump(OP.jmp));
    ctx.patch(next);
  }
  if (ctx.iterationWrapper) {
    ctx.emitLoad({ scope: 0, index: targetSlot });
    ctx.emitPush(ctx.iterationWrapper.controlId);
    ctx.emit(OP.binop, { kind: "u8", value: BINOP["==="] });
    const next = ctx.jump(OP.jmp_if, 1);
    this.emitWrapperCompletion(ctx, kind, false, ctx.iterationWrapper.controlId);
    ctx.patch(next);
  }
  const end = ctx.code.position;
  for (const pos of doneJumps) ctx.patch(pos, end);
}

function emitCompletionDispatch(ctx, slots) {
  ctx.emitLoad({ scope: 0, index: slots.kindSlot });
  ctx.emitPush(1);
  ctx.emit(OP.binop, { kind: "u8", value: BINOP["==="] });
  const notThrow = ctx.jump(OP.jmp_if, 1);
  ctx.emitLoad({ scope: 0, index: slots.valueSlot });
  if (ctx.finallyStack.length && ctx.finallyStack[ctx.finallyStack.length - 1].captureThrow) {
    const top = ctx.finallyStack[ctx.finallyStack.length - 1];
    ctx.emitStore({ scope: 0, index: top.valueSlot }); ctx.emit(OP.pop);
    ctx.emitPush(1); ctx.emitStore({ scope: 0, index: top.kindSlot }); ctx.emit(OP.pop);
    ctx.emitPush(0); ctx.emitStore({ scope: 0, index: top.targetSlot }); ctx.emit(OP.pop);
    top.exits.push(ctx.jump(OP.jmp));
  } else {
    this.emitActiveIteratorCleanup(ctx);
    ctx.emit(OP.throw);
  }
  ctx.patch(notThrow);

  ctx.emitLoad({ scope: 0, index: slots.kindSlot });
  ctx.emitPush(2);
  ctx.emit(OP.binop, { kind: "u8", value: BINOP["==="] });
  const notReturn = ctx.jump(OP.jmp_if, 1);
  ctx.emitLoad({ scope: 0, index: slots.valueSlot });
  if (ctx.finallyStack.length) {
    const top = ctx.finallyStack[ctx.finallyStack.length - 1];
    ctx.emitStore({ scope: 0, index: top.valueSlot }); ctx.emit(OP.pop);
    ctx.emitPush(2); ctx.emitStore({ scope: 0, index: top.kindSlot }); ctx.emit(OP.pop);
    ctx.emitPush(0); ctx.emitStore({ scope: 0, index: top.targetSlot }); ctx.emit(OP.pop);
    top.exits.push(ctx.jump(OP.jmp));
  } else {
    this.emitActiveIteratorCleanup(ctx);
    ctx.emit(OP.ret, { kind: "u8", value: 1 });
  }
  ctx.patch(notReturn);

  ctx.emitLoad({ scope: 0, index: slots.kindSlot });
  ctx.emitPush(3);
  ctx.emit(OP.binop, { kind: "u8", value: BINOP["==="] });
  const notBreak = ctx.jump(OP.jmp_if, 1);
  if (ctx.finallyStack.length) {
    const top = ctx.finallyStack[ctx.finallyStack.length - 1];
    ctx.emitPush(3); ctx.emitStore({ scope: 0, index: top.kindSlot }); ctx.emit(OP.pop);
    ctx.emit(OP.push, { kind: "u16", value: 1 }); ctx.emitStore({ scope: 0, index: top.valueSlot }); ctx.emit(OP.pop);
    ctx.emitLoad({ scope: 0, index: slots.targetSlot }); ctx.emitStore({ scope: 0, index: top.targetSlot }); ctx.emit(OP.pop);
    top.exits.push(ctx.jump(OP.jmp));
  } else {
    this.emitLoopControlDispatch(ctx, slots.targetSlot, 3);
  }
  ctx.patch(notBreak);

  if (ctx.finallyStack.length) {
    const top = ctx.finallyStack[ctx.finallyStack.length - 1];
    ctx.emitPush(4); ctx.emitStore({ scope: 0, index: top.kindSlot }); ctx.emit(OP.pop);
    ctx.emit(OP.push, { kind: "u16", value: 1 }); ctx.emitStore({ scope: 0, index: top.valueSlot }); ctx.emit(OP.pop);
    ctx.emitLoad({ scope: 0, index: slots.targetSlot }); ctx.emitStore({ scope: 0, index: top.targetSlot }); ctx.emit(OP.pop);
    top.exits.push(ctx.jump(OP.jmp));
  } else {
    this.emitLoopControlDispatch(ctx, slots.targetSlot, 4);
  }
}

function compileSwitch(ctx, stmt) {
  const discTmp = ctx.addLocal(`$switch${ctx.localNames.length}`);
  this.compileExpression(ctx, stmt.discriminant);
  ctx.emitStore({ scope: 0, index: discTmp });
  ctx.emit(OP.pop);
  const endBreaks = [];
  const tests = [];
  for (const c of stmt.cases) {
    if (!c.test) continue;
    ctx.emitLoad({ scope: 0, index: discTmp });
    this.compileExpression(ctx, c.test);
    ctx.emit(OP.binop, { kind: "u8", value: BINOP["==="] });
    tests.push({ c, pos: ctx.jump(OP.jmp_if, 0) });
  }
  const defaultCase = stmt.cases.find((c) => !c.test);
  const defaultJump = ctx.jump(OP.jmp);
  const caseStarts = new Map();
  for (const c of stmt.cases) {
    caseStarts.set(c, ctx.code.position);
    const record = createControlRecord(ctx, stmt._labelName, false, true, false);
    record.breaks = endBreaks;
    ctx.loopStack.push(record);
    this.compileStatements(ctx, c.consequent);
    ctx.loopStack.pop();
  }
  const end = ctx.code.position;
  for (const t of tests) ctx.patch(t.pos, caseStarts.get(t.c));
  ctx.patch(defaultJump, defaultCase ? caseStarts.get(defaultCase) : end);
  for (const pos of endBreaks) ctx.patch(pos, end);
}

function compileTry(ctx, stmt) {
  if (stmt.finalizer) { this.compileTryFinally(ctx, stmt); return; }
  const exTableBase = ctx.exTable.length;
  const start = ctx.code.position;
  const stackDepth = ctx.residentStackDepth;
  this.compileStatement(ctx, stmt.block);
  const endTry = ctx.code.position;
  const after = ctx.jump(OP.jmp);
  const handler = ctx.code.position;
  if (stmt.handler) {
    if (stmt.handler.param) {
      ctx.emit(OP.get_exc);
      this.compileBindingPattern(ctx, stmt.handler.param);
    }
    this.compileStatement(ctx, stmt.handler.body);
  }
  ctx.patch(after);
  ctx.exTable.splice(exTableBase, 0, { start, end: endTry, handler, stackDepth, isFinal: false });
}

function compileTryFinally(ctx, stmt) {
  const kindSlot = ctx.addLocal(`$finallyKind${ctx.localNames.length}`, "lexical");
  const valueSlot = ctx.addLocal(`$finallyValue${ctx.localNames.length}`, "lexical");
  const targetSlot = ctx.addInternalLocal(`<finally target ${ctx.localNames.length}>`, "lexical");
  const state = { kindSlot, valueSlot, targetSlot, exits: [], captureThrow: !stmt.handler };
  const exTableBase = ctx.exTable.length;
  const start = ctx.code.position;
  const stackDepth = ctx.residentStackDepth;
  ctx.finallyStack.push(state);
  this.compileStatement(ctx, stmt.block);
  ctx.finallyStack.pop();
  const endTry = ctx.code.position;
  ctx.emitPush(0); ctx.emitStore({ scope: 0, index: kindSlot }); ctx.emit(OP.pop);
  ctx.emit(OP.push, { kind: "u16", value: 1 }); ctx.emitStore({ scope: 0, index: valueSlot }); ctx.emit(OP.pop);
  ctx.emitPush(0); ctx.emitStore({ scope: 0, index: targetSlot }); ctx.emit(OP.pop);
  state.exits.push(ctx.jump(OP.jmp));

  const catchHandler = stmt.handler ? ctx.code.position : -1;
  let afterCatch = null;
  if (stmt.handler) {
    if (stmt.handler.param) {
      ctx.emit(OP.get_exc);
      this.compileBindingPattern(ctx, stmt.handler.param);
    }
    state.captureThrow = true;
    ctx.finallyStack.push(state);
    this.compileStatement(ctx, stmt.handler.body);
    ctx.finallyStack.pop();
    state.captureThrow = false;
    ctx.emitPush(0); ctx.emitStore({ scope: 0, index: kindSlot }); ctx.emit(OP.pop);
    ctx.emit(OP.push, { kind: "u16", value: 1 }); ctx.emitStore({ scope: 0, index: valueSlot }); ctx.emit(OP.pop);
    ctx.emitPush(0); ctx.emitStore({ scope: 0, index: targetSlot }); ctx.emit(OP.pop);
    afterCatch = ctx.jump(OP.jmp);
  }

  const finallyHandler = ctx.code.position;
  ctx.emit(OP.get_exc); ctx.emitStore({ scope: 0, index: valueSlot }); ctx.emit(OP.pop);
  ctx.emitPush(1); ctx.emitStore({ scope: 0, index: kindSlot }); ctx.emit(OP.pop);
  ctx.emitPush(0); ctx.emitStore({ scope: 0, index: targetSlot }); ctx.emit(OP.pop);

  const finallyBody = ctx.code.position;
  for (const pos of state.exits) ctx.patch(pos, finallyBody);
  if (afterCatch !== null) ctx.patch(afterCatch, finallyBody);
  this.compileStatement(ctx, stmt.finalizer);
  this.emitFinallyEpilogue(ctx, state);
  const entries = [{ start, end: finallyHandler, handler: finallyHandler, stackDepth, isFinal: true }];
  if (stmt.handler) entries.push({ start, end: endTry, handler: catchHandler, stackDepth, isFinal: false });
  ctx.exTable.splice(exTableBase, 0, ...entries);
}

function emitFinallyEpilogue(ctx, state) {
  ctx.emitLoad({ scope: 0, index: state.kindSlot });
  const normal = ctx.jump(OP.jmp_if, 1);
  ctx.emitLoad({ scope: 0, index: state.kindSlot }); ctx.emitPush(1); ctx.emit(OP.binop, { kind: "u8", value: BINOP["==="] });
  const notThrow = ctx.jump(OP.jmp_if, 1);
  ctx.emitLoad({ scope: 0, index: state.valueSlot });
  if (ctx.iterationWrapper) this.emitWrapperCompletion(ctx, 1, true, null);
  else ctx.emit(OP.throw);
  ctx.patch(notThrow);

  ctx.emitLoad({ scope: 0, index: state.kindSlot }); ctx.emitPush(2); ctx.emit(OP.binop, { kind: "u8", value: BINOP["==="] });
  const notReturn = ctx.jump(OP.jmp_if, 1);
  ctx.emitLoad({ scope: 0, index: state.valueSlot });
  if (ctx.iterationWrapper) this.emitWrapperCompletion(ctx, 2, true, null);
  else ctx.emit(OP.ret, { kind: "u8", value: 1 });
  ctx.patch(notReturn);

  ctx.emitLoad({ scope: 0, index: state.kindSlot }); ctx.emitPush(3); ctx.emit(OP.binop, { kind: "u8", value: BINOP["==="] });
  const notBreak = ctx.jump(OP.jmp_if, 1);
  this.emitLoopControlDispatch(ctx, state.targetSlot, 3);
  ctx.patch(notBreak);
  this.emitLoopControlDispatch(ctx, state.targetSlot, 4);
  ctx.patch(normal);
}

module.exports = {
  compileStatements,
  compileStatement,
  compileLabeled,
  createControlRecord,
  compileIf,
  compileFor,
  getCapturedForLetNames,
  getCapturedForInOfLetNames,
  containsCapturedName,
  compileForIterationWrapper,
  compileWhile,
  compileDoWhile,
  compileForIn,
  compileForOf,
  storeLoopLeft,
  resolveBreakTarget,
  resolveContinueTarget,
  compileBreak,
  compileContinue,
  compileReturn,
  compileThrow,
  emitActiveIteratorCleanup,
  emitCompletion,
  emitWrapperCompletion,
  emitLoopControlDispatch,
  emitCompletionDispatch,
  compileSwitch,
  compileTry,
  compileTryFinally,
  emitFinallyEpilogue,
};
