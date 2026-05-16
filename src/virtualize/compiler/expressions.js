"use strict";

const { OP, BINOP, UNOP } = require("../opcodes");
const { CompileError } = require("./errors");

function compileExpression(ctx, expr) {
  switch (expr.type) {
    case "NumericLiteral": case "StringLiteral": case "BooleanLiteral": this.emitLiteral(ctx, expr.value); break;
    case "BigIntLiteral": this.emitLiteral(ctx, BigInt(expr.value)); break;
    case "RegExpLiteral": this.emitLiteral(ctx, new RegExp(expr.pattern, expr.flags)); break;
    case "NullLiteral": ctx.emit(OP.push, { kind: "u16", value: 0 }); break;
    case "Identifier": if (expr.name === "arguments" && ctx.kind === 1) this.compileArrowSpecial(ctx, "arguments"); else ctx.emitLoad(ctx.resolve(expr.name)); break;
    case "ThisExpression": if (ctx.kind === 1) this.compileArrowSpecial(ctx, "this"); else ctx.emit(OP.push_spec, { kind: "u8", value: 0 }); break;
    case "FunctionExpression": case "ArrowFunctionExpression": {
      const fnIdx = this.compileFunctionLike(expr, ctx, expr.id ? expr.id.name : "", expr.type === "ArrowFunctionExpression" ? 1 : 0, expr.params);
      ctx.emit(OP.make_func, { kind: "u16", value: fnIdx });
      break;
    }
    case "ClassExpression": this.compileClassExpression(ctx, expr); break;
    case "BinaryExpression": this.compileExpression(ctx, expr.left); this.compileExpression(ctx, expr.right); ctx.emit(OP.binop, { kind: "u8", value: BINOP[expr.operator] }); break;
    case "UnaryExpression":
      if (expr.operator === "typeof" && expr.argument.type === "Identifier") {
        const localRef = resolveTypeofIdentifier(ctx, expr.argument.name, this.constIndex.bind(this));
        ctx.emitLoad(localRef);
      } else {
        this.compileExpression(ctx, expr.argument);
      }
      ctx.emit(OP.unop, { kind: "u8", value: UNOP[expr.operator] });
      break;
    case "UpdateExpression": this.compileUpdate(ctx, expr); break;
    case "AssignmentExpression": this.compileAssignment(ctx, expr); break;
    case "LogicalExpression": this.compileLogical(ctx, expr); break;
    case "ConditionalExpression": this.compileConditional(ctx, expr); break;
    case "SequenceExpression": this.compileSequence(ctx, expr); break;
    case "ParenthesizedExpression": this.compileExpression(ctx, expr.expression); break;
    case "MetaProperty":
      if (expr.meta.name === "new" && expr.property.name === "target") {
        if (ctx.kind === 1) this.compileArrowSpecial(ctx, "new.target");
        else ctx.emit(OP.push_spec, { kind: "u8", value: 1 });
        break;
      }
      if (expr.meta.name === "import" && expr.property.name === "meta") {
        throw new CompileError(expr, "Unsupported expression");
      }
      throw new CompileError(expr, "Unsupported expression");
    case "MemberExpression": this.compileMemberRead(ctx, expr); break;
    case "OptionalMemberExpression": this.compileOptionalMember(ctx, expr); break;
    case "CallExpression": this.compileCall(ctx, expr); break;
    case "OptionalCallExpression": this.compileOptionalCall(ctx, expr); break;
    case "NewExpression": this.compileNew(ctx, expr); break;
    case "ObjectExpression": this.compileObject(ctx, expr); break;
    case "ArrayExpression": this.compileArray(ctx, expr); break;
    case "TemplateLiteral": this.compileTemplate(ctx, expr); break;
    case "ImportExpression": throw new CompileError(expr, "Unsupported expression");
    default: throw new CompileError(expr, "Unsupported expression");
  }
}

function compileArrowSpecial(ctx, special) {
  const ref = ctx.resolveArrowSpecial(special);
  ctx.emitLoad(ref);
}

function resolveTypeofIdentifier(ctx, name, constIndex) {
  if (ctx.hasLocal(name)) return { scope: 0, index: ctx.localMap.get(name) };
  if (ctx.parent) {
    const parentRef = ctx.parent.resolveForChild(name);
    if (parentRef) {
      const key = `${parentRef.scope}:${parentRef.index}`;
      if (!ctx.upvalueMap.has(key)) {
        ctx.upvalueMap.set(key, ctx.upvalues.length);
        ctx.upvalues.push(parentRef);
      }
      return { scope: 1, index: ctx.upvalueMap.get(key) };
    }
  }
  return { scope: 3, index: constIndex(name) };
}

function compileAssignment(ctx, expr) {
  if (expr.operator === "??=" || expr.operator === "&&=" || expr.operator === "||=") {
    if (expr.left.type === "MemberExpression") {
      this.compileLogicalAssignmentMember(ctx, expr);
      return;
    }
    this.compileLValueRead(ctx, expr.left);
    const cond = expr.operator === "??=" ? 4 : expr.operator === "&&=" ? 2 : 3;
    const done = ctx.jump(OP.jmp_if, cond);
    ctx.emit(OP.pop);
    this.compileAssignment(ctx, { type: "AssignmentExpression", operator: "=", left: expr.left, right: expr.right });
    ctx.patch(done);
    return;
  }
  if (expr.operator !== "=") { this.compileLValueRead(ctx, expr.left); this.compileExpression(ctx, expr.right); ctx.emit(OP.binop, { kind: "u8", value: BINOP[expr.operator.slice(0, -1)] }); }
  else this.compileExpression(ctx, expr.right);
  this.compileLValueStore(ctx, expr.left);
}

function compileLogicalAssignmentMember(ctx, expr) {
  const objTmp = ctx.addLocal(`$obj${ctx.localNames.length}`);
  let keyTmp = -1;
  this.compileExpression(ctx, expr.left.object);
  ctx.emitStore({ scope: 0, index: objTmp });
  ctx.emit(OP.pop);
  if (expr.left.computed) {
    keyTmp = ctx.addLocal(`$key${ctx.localNames.length}`);
    this.compileExpression(ctx, expr.left.property);
    ctx.emitStore({ scope: 0, index: keyTmp });
    ctx.emit(OP.pop);
    ctx.emitLoad({ scope: 0, index: objTmp });
    ctx.emitLoad({ scope: 0, index: keyTmp });
    ctx.emit(OP.get_elem);
  } else {
    ctx.emitLoad({ scope: 0, index: objTmp });
    ctx.emit(OP.get_prop, { kind: "u16", value: this.constIndex(expr.left.property.name) });
  }
  const cond = expr.operator === "??=" ? 4 : expr.operator === "&&=" ? 2 : 3;
  const done = ctx.jump(OP.jmp_if, cond);
  ctx.emit(OP.pop);
  if (expr.left.computed) {
    ctx.emitLoad({ scope: 0, index: objTmp });
    ctx.emitLoad({ scope: 0, index: keyTmp });
    this.compileExpression(ctx, expr.right);
    ctx.emit(OP.set_elem);
  } else {
    ctx.emitLoad({ scope: 0, index: objTmp });
    this.compileExpression(ctx, expr.right);
    ctx.emit(OP.set_prop, { kind: "u16", value: this.constIndex(expr.left.property.name) });
  }
  ctx.patch(done);
}

function compileLValueRead(ctx, left) {
  if (left.type === "Identifier") ctx.emitLoad(ctx.resolve(left.name));
  else if (left.type === "MemberExpression") this.compileMemberRead(ctx, left);
  else throw new CompileError(left, "Unsupported assignment target");
}

function compileLValueStore(ctx, left) {
  if (left.type === "Identifier") ctx.emitStore(ctx.resolve(left.name));
  else if (left.type === "MemberExpression") {
    const valueTmp = ctx.addLocal(`$val${ctx.localNames.length}`); ctx.emitStore({ scope: 0, index: valueTmp }); ctx.emit(OP.pop);
    this.compileMemberObjectKey(ctx, left); ctx.emitLoad({ scope: 0, index: valueTmp });
    if (left.computed) ctx.emit(OP.set_elem); else ctx.emit(OP.set_prop, { kind: "u16", value: this.constIndex(left.property.name) });
  } else throw new CompileError(left, "Unsupported assignment target");
}

function compileUpdate(ctx, expr) {
  const opKind = expr.operator === "++" ? BINOP["+"] : BINOP["-"];

  if (expr.prefix) {
    this.compileLValueRead(ctx, expr.argument);
    ctx.emitPush(1);
    ctx.emit(OP.binop, { kind: "u8", value: opKind });
    this.compileLValueStore(ctx, expr.argument);
    return;
  }

  if (expr.argument.type === "Identifier") {
    const oldValueSlot = ctx.addInternalLocal(`<update old ${ctx.localNames.length}>`, "lexical");
    const newValueSlot = ctx.addInternalLocal(`<update new ${ctx.localNames.length}>`, "lexical");

    this.compileLValueRead(ctx, expr.argument);
    ctx.emitStore({ scope: 0, index: oldValueSlot });
    ctx.emit(OP.pop);

    ctx.emitLoad({ scope: 0, index: oldValueSlot });
    ctx.emitPush(1);
    ctx.emit(OP.binop, { kind: "u8", value: opKind });
    ctx.emitStore({ scope: 0, index: newValueSlot });
    ctx.emit(OP.pop);

    ctx.emitLoad({ scope: 0, index: newValueSlot });
    this.compileLValueStore(ctx, expr.argument);
    ctx.emit(OP.pop);
    ctx.emitLoad({ scope: 0, index: oldValueSlot });
    return;
  }

  this.compileLValueRead(ctx, expr.argument);
  ctx.emitPush(1);
  ctx.emit(OP.binop, { kind: "u8", value: opKind });
  this.compileLValueStore(ctx, expr.argument);
}
function compileLogical(ctx, expr) { this.compileExpression(ctx, expr.left); const cond = expr.operator === "&&" ? 2 : expr.operator === "||" ? 3 : 4; const done = ctx.jump(OP.jmp_if, cond); ctx.emit(OP.pop); this.compileExpression(ctx, expr.right); ctx.patch(done); }
function compileConditional(ctx, expr) { this.compileExpression(ctx, expr.test); const alt = ctx.jump(OP.jmp_if, 1); this.compileExpression(ctx, expr.consequent); const done = ctx.jump(OP.jmp); ctx.patch(alt); this.compileExpression(ctx, expr.alternate); ctx.patch(done); }
function compileSequence(ctx, expr) { for (let i = 0; i < expr.expressions.length; i++) { this.compileExpression(ctx, expr.expressions[i]); if (i !== expr.expressions.length - 1) ctx.emit(OP.pop); } }
function compileOptionalMember(ctx, expr) {
  this.compileExpression(ctx, expr.object);
  ctx.emit(OP.dup);
  const nullish = ctx.jump(OP.jmp_if, 5);
  ctx.emit(OP.pop);
  if (expr.computed) {
    this.compileExpression(ctx, expr.property);
    ctx.emit(OP.get_elem);
  } else {
    ctx.emit(OP.get_prop, { kind: "u16", value: this.constIndex(expr.property.name) });
  }
  const done = ctx.jump(OP.jmp);
  ctx.patch(nullish);
  ctx.emit(OP.swap);
  ctx.emit(OP.pop);
  ctx.patch(done);
}
function compileOptionalCall(ctx, expr) {
  if (expr.callee.type === "MemberExpression" || expr.callee.type === "OptionalMemberExpression") {
    const objTmp = ctx.addLocal(`$obj${ctx.localNames.length}`);
    const calleeTmp = ctx.addLocal(`$callee${ctx.localNames.length}`);
    let keyTmp = -1;
    this.compileExpression(ctx, expr.callee.object);
    ctx.emitStore({ scope: 0, index: objTmp });
    ctx.emit(OP.pop);
    ctx.emitLoad({ scope: 0, index: objTmp });
    const objectNullish = ctx.jump(OP.jmp_if, 5);
    ctx.emit(OP.pop);
    if (expr.callee.computed) {
      keyTmp = ctx.addLocal(`$key${ctx.localNames.length}`);
      this.compileExpression(ctx, expr.callee.property);
      ctx.emitStore({ scope: 0, index: keyTmp });
      ctx.emit(OP.pop);
      ctx.emitLoad({ scope: 0, index: objTmp });
      ctx.emitLoad({ scope: 0, index: keyTmp });
      ctx.emit(OP.get_elem);
    } else {
      ctx.emitLoad({ scope: 0, index: objTmp });
      ctx.emit(OP.get_prop, { kind: "u16", value: this.constIndex(expr.callee.property.name) });
    }
    ctx.emitStore({ scope: 0, index: calleeTmp });
    ctx.emit(OP.pop);
    ctx.emitLoad({ scope: 0, index: calleeTmp });
    const calleeNullish = ctx.jump(OP.jmp_if, 5);
    ctx.emit(OP.pop);
    ctx.emitLoad({ scope: 0, index: objTmp });
    ctx.emitLoad({ scope: 0, index: calleeTmp });
    this.compileArgs(ctx, expr.arguments);
    ctx.emit(OP.call, { kind: "u8", value: 1 }, { kind: "u8", value: expr.arguments.length });
    const done = ctx.jump(OP.jmp);
    const end = ctx.code.position;
    ctx.patch(objectNullish, end);
    ctx.patch(calleeNullish, end);
    ctx.patch(done, end);
    return;
  }

  const calleeTmp = ctx.addLocal(`$callee${ctx.localNames.length}`);
  this.compileExpression(ctx, expr.callee);
  ctx.emitStore({ scope: 0, index: calleeTmp });
  ctx.emit(OP.pop);
  ctx.emitLoad({ scope: 0, index: calleeTmp });
  const nullish = ctx.jump(OP.jmp_if, 5);
  ctx.emit(OP.pop);
  ctx.emitLoad({ scope: 0, index: calleeTmp });
  this.compileArgs(ctx, expr.arguments);
  ctx.emit(OP.call, { kind: "u8", value: 0 }, { kind: "u8", value: expr.arguments.length });
  const done = ctx.jump(OP.jmp);
  const end = ctx.code.position;
  ctx.patch(nullish, end);
  ctx.patch(done, end);
}
function compileCall(ctx, expr) {
  if (expr.callee.type === "MemberExpression" && !expr.callee.computed) { this.compileExpression(ctx, expr.callee.object); this.compileArgs(ctx, expr.arguments); ctx.emit(OP.call_method, { kind: "u16", value: this.constIndex(expr.callee.property.name) }, { kind: "u8", value: expr.arguments.length }); return; }
  if (expr.callee.type === "MemberExpression") { this.compileExpression(ctx, expr.callee.object); ctx.emit(OP.dup); this.compileExpression(ctx, expr.callee.property); ctx.emit(OP.get_elem); this.compileArgs(ctx, expr.arguments); ctx.emit(OP.call, { kind: "u8", value: 1 }, { kind: "u8", value: expr.arguments.length }); return; }
  this.compileExpression(ctx, expr.callee); this.compileArgs(ctx, expr.arguments); ctx.emit(OP.call, { kind: "u8", value: 0 }, { kind: "u8", value: expr.arguments.length });
}
function compileArgs(ctx, args) { for (const a of args) { if (a.type === "SpreadElement") { this.compileExpression(ctx, a.argument); ctx.emit(OP.spread, { kind: "u8", value: 2 }); } else this.compileExpression(ctx, a); } }
function compileNew(ctx, expr) { this.compileExpression(ctx, expr.callee); this.compileArgs(ctx, expr.arguments); ctx.emit(OP.call_new, { kind: "u8", value: expr.arguments.length }); }
function compileObject(ctx, expr) { ctx.emit(OP.new_obj); for (const p of expr.properties) { if (p.type === "SpreadElement") { this.compileExpression(ctx, p.argument); ctx.emit(OP.spread, { kind: "u8", value: 1 }); continue; } if (p.computed) { this.compileExpression(ctx, p.key); this.compileExpression(ctx, p.value); ctx.emit(OP.def_prop, { kind: "u8", value: 3 }, { kind: "u16", value: 0 }); } else { this.compileExpression(ctx, p.value); const key = p.key.type === "Identifier" ? p.key.name : p.key.value; ctx.emit(OP.def_prop, { kind: "u8", value: 0 }, { kind: "u16", value: this.constIndex(key) }); } } }
function compileArray(ctx, expr) {
  const arrayTmp = ctx.addLocal(`$arr${ctx.localNames.length}`);
  ctx.emit(OP.new_arr, { kind: "u16", value: 0 });
  ctx.emitStore({ scope: 0, index: arrayTmp });
  ctx.emit(OP.pop);
  let idx = 0;
  let hasSpread = false;
  for (const e of expr.elements) {
    if (!e) {
      idx++;
      continue;
    }
    if (e.type === "SpreadElement") {
      ctx.emitLoad({ scope: 0, index: arrayTmp });
      this.compileExpression(ctx, e.argument);
      ctx.emit(OP.spread, { kind: "u8", value: 0 });
      ctx.emit(OP.pop);
      hasSpread = true;
      continue;
    }
    ctx.emitLoad({ scope: 0, index: arrayTmp });
    if (hasSpread) {
      ctx.emit(OP.dup);
      ctx.emit(OP.get_prop, { kind: "u16", value: this.constIndex("length") });
    } else {
      ctx.emitPush(idx++);
    }
    this.compileExpression(ctx, e);
    ctx.emit(OP.set_elem);
    ctx.emit(OP.pop);
  }
  ctx.emitLoad({ scope: 0, index: arrayTmp });
}
function compileTemplate(ctx, expr) { expr.quasis.forEach((q, i) => { this.emitLiteral(ctx, q.value.cooked || ""); if (i > 0) ctx.emit(OP.binop, { kind: "u8", value: BINOP["+"] }); if (expr.expressions[i]) { this.compileExpression(ctx, expr.expressions[i]); ctx.emit(OP.binop, { kind: "u8", value: BINOP["+"] }); } }); }

module.exports = { compileExpression, compileArrowSpecial, compileAssignment, compileLogicalAssignmentMember, compileLValueRead, compileLValueStore, compileUpdate, compileLogical, compileConditional, compileSequence, compileOptionalMember, compileOptionalCall, compileCall, compileArgs, compileNew, compileObject, compileArray, compileTemplate, resolveTypeofIdentifier };
