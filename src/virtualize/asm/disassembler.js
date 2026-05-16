"use strict";

const { deserializeModule } = require("../codegen/serializer");
const { decodeFunctionLayout } = require("./layout");
const { OP, BINOP, UNOP } = require("../opcodes");

const OP_NAMES = invert(OP);
const BINOP_NAMES = invert(BINOP);
const UNOP_NAMES = invert(UNOP);

function disassembleModule(bytesOrModule) {
  const module = bytesOrModule instanceof Uint8Array || Array.isArray(bytesOrModule)
    ? deserializeModule(bytesOrModule)
    : bytesOrModule;
  const constants = module.constPool?.literals || module.constants || [];
  const funcs = module.funcs || module.functions || [];
  const lines = [];

  lines.push(`VM Module v${module.version ?? "?"} entry=${module.entry ?? 0}`);
  lines.push("Constants");
  constants.forEach((value, index) => lines.push(`  [${index}] ${formatConstantEntry(value)}`));
  lines.push("Functions");
  funcs.forEach((func, index) => {
    const name = functionName(func, constants);
    lines.push(`Function #${index} ${name}`);
    lines.push(`  locals=${func.localCount ?? func.localNames?.length ?? 0} params=${(func.params || []).join(",") || "-"} rest=${func.rest ?? -1} args=${func.argumentsSlot ?? -1}`);
    if ((func.upvalues || []).length > 0) lines.push(`  upvalues=${JSON.stringify(func.upvalues)}`);
    if ((func.exTable || []).length > 0) lines.push(`  exTable=${JSON.stringify(func.exTable)}`);
    for (const instruction of decodeFunctionLayout(func.code || []).instructions) {
      lines.push(`  ${formatAddress(instruction.seqPc)}: ${formatInstruction(instruction, constants)}${formatSource(func.srcMap || [], instruction.seqPc)}`);
    }
  });

  return `${lines.join("\n")}\n`;
}

function formatInstruction(instruction, constants) {
  const parts = [];
  for (const prefix of instruction.prefixes) parts.push(`dyn ${prefix.which};`);
  const name = OP_NAMES[instruction.op] || `op_${instruction.op}`;
  const operands = instruction.operands.map((operand) => formatOperand(name, operand, constants));
  parts.push([name, ...operands].join(" "));
  return parts.join(" ");
}

function formatOperand(opName, operand, constants) {
  if (operand.dynamic) return `$dyn${operand.index}:${operand.type}`;
  if (opName === "push" && operand.index === 0) return `#${operand.value} ${formatConstantValue(constants[operand.value])}`;
  if (["get_prop", "set_prop", "call_method"].includes(opName) && operand.index === 0) return `#${operand.value} ${formatConstantValue(constants[operand.value])}`;
  if (opName === "binop" && operand.index === 0) return BINOP_NAMES[operand.value] || String(operand.value);
  if (opName === "unop" && operand.index === 0) return UNOP_NAMES[operand.value] || String(operand.value);
  if ((opName === "jmp" && operand.index === 0) || (opName === "jmp_if" && operand.index === 1)) return `${operand.value} -> ${formatAddress(operand.endPc + operand.value)}`;
  return String(operand.value);
}

function formatSource(srcMap, pc) {
  const entry = findSource(srcMap, pc);
  return entry ? ` ; src ${entry.line}:${entry.column}` : "";
}

function findSource(srcMap, pc) {
  let best = null;
  for (const entry of srcMap || []) {
    if (entry.pc > pc) continue;
    if (!best || entry.pc > best.pc) best = entry;
  }
  return best;
}

function functionName(func, constants) {
  if (func.name) return func.name;
  if (Number.isInteger(func.nameIdx) && func.nameIdx >= 0) return String(constants[func.nameIdx]);
  return "<anonymous>";
}

function formatConstantEntry(value) {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (value instanceof RegExp) return `regexp ${value.toString()}`;
  return `${typeof value} ${formatConstantValue(value)}`;
}

function formatConstantValue(value) {
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "bigint") return `${value}n`;
  if (value instanceof RegExp) return value.toString();
  return String(value);
}

function formatAddress(pc) {
  return pc.toString().padStart(4, "0");
}

function invert(object) {
  const out = {};
  for (const [key, value] of Object.entries(object)) out[value] = key;
  return out;
}

module.exports = { disassembleModule };
