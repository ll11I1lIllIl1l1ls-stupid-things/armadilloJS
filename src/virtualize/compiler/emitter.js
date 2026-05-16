"use strict";

const { OP } = require("../opcodes");

function emitLiteral(ctx, value) {
  if (typeof value === "number") ctx.emitPush(value);
  else ctx.emit(OP.push, { kind: "u16", value: this.constIndex(value) });
}

function compileMemberObjectKey(ctx, member) {
  this.compileExpression(ctx, member.object);
  if (member.computed) this.compileExpression(ctx, member.property);
}

function compileMemberRead(ctx, member) {
  if (
    member.object &&
    member.object.type === "MetaProperty" &&
    member.object.meta.name === "import" &&
    member.object.property.name === "meta" &&
    !member.computed &&
    member.property &&
    member.property.type === "Identifier" &&
    member.property.name === "url"
  ) {
    this.emitLiteral(ctx, this.filename || "");
    return;
  }
  this.compileMemberObjectKey(ctx, member);
  if (member.computed) ctx.emit(OP.get_elem);
  else ctx.emit(OP.get_prop, { kind: "u16", value: this.constIndex(member.property.name) });
}

module.exports = { emitLiteral, compileMemberObjectKey, compileMemberRead };
