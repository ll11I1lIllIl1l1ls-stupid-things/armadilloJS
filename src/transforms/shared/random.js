"use strict";

function createSeededRng(seed = 0) {
  let state = seed >>> 0;

  function nextUint32() {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state;
  }

  function nextInt(maxExclusive) {
    if (!Number.isInteger(maxExclusive) || maxExclusive <= 0) {
      throw new RangeError("maxExclusive must be a positive integer");
    }
    return nextUint32() % maxExclusive;
  }

  return { nextUint32, nextInt };
}

module.exports = { createSeededRng };
