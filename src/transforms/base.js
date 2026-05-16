"use strict";

class Transformer {
  /* eslint-disable class-methods-use-this */
  run() { throw new Error("Transformer.run must be implemented by bytecode-native transforms"); }
}

module.exports = { Transformer };
