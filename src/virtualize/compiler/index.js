"use strict";

const parser = require("@babel/parser");
const { CompileError } = require("./errors");
const { FunctionContext } = require("./scope");
const functions = require("./functions");
const declarations = require("./declarations");
const patterns = require("./patterns");
const statements = require("./statements");
const expressions = require("./expressions");
const classes = require("./classes");
const emitter = require("./emitter");
const { CURRENT_VM_VERSION } = require("../version");

class Compiler {
  constructor() {
    this.constants = [null, undefined, true, false];
    this.constantMap = new Map(this.constants.map((v, i) => [this.constKey(v), i]));
    this.functions = [];
    this.classes = [];
  }

  constKey(value) { return `${typeof value}:${String(value)}`; }

  constIndex(value) {
    const key = this.constKey(value);
    if (this.constantMap.has(key)) return this.constantMap.get(key);
    const idx = this.constants.length;
    this.constants.push(value);
    this.constantMap.set(key, idx);
    return idx;
  }

  compile(source, filename) {
    this.filename = filename;
    const ast = parser.parse(source, {
      sourceType: "unambiguous",
      createImportExpressions: true,
      plugins: ["classProperties", "classPrivateProperties", "classPrivateMethods"],
    });
    const entry = this.compileFunctionLike(ast.program, null, "entry", 0, []);
    return { version: CURRENT_VM_VERSION, constants: this.constants, functions: this.functions, classes: this.classes, entry };
  }
}

Object.assign(
  Compiler.prototype,
  functions,
  declarations,
  patterns,
  statements,
  expressions,
  classes,
  emitter,
);

function compile(source, filename) { return new Compiler().compile(source, filename); }

module.exports = { CURRENT_VM_VERSION, Compiler, CompileError, FunctionContext, compile };
