"use strict";

class CompileError extends Error {
  constructor(node, message) {
    super(`${message} at ${node && node.type ? node.type : "unknown"}`);
  }
}

module.exports = { CompileError };
