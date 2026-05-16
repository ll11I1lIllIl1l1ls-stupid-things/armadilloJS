"use strict";

const { CompileError } = require("./errors");

function rejectModule(node) {
  throw new CompileError(node, "Unsupported module syntax");
}

module.exports = { rejectModule };
