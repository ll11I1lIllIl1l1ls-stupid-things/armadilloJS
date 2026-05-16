"use strict";

const OP_KINDS = Object.freeze([
  "xor",
  "add",
  "sub",
  "rol",
  "ror",
  "mulOdd",
]);

const INVERSE_KIND = Object.freeze({
  xor: "xor",
  add: "sub",
  sub: "add",
  rol: "ror",
  ror: "rol",
});

function mix32(value) {
  let state = value >>> 0;
  state ^= state >>> 16;
  state = Math.imul(state, 0x7feb352d) >>> 0;
  state ^= state >>> 15;
  state = Math.imul(state, 0x846ca68b) >>> 0;
  state ^= state >>> 16;
  return state >>> 0;
}

function buildSeed(constIndex, stepIndex, cfid, width, salt, chunkIndex = 0) {
  let state = mix32((constIndex >>> 0) ^ 0x9e3779b9);
  state = mix32(state ^ ((stepIndex >>> 0) * 0x85ebca6b));
  state = mix32(state ^ (cfid >>> 0));
  state = mix32(state ^ ((width >>> 0) * 0xc2b2ae35));
  state = mix32(state ^ ((chunkIndex >>> 0) * 0x27d4eb2d));
  return mix32(state ^ (salt >>> 0));
}

function validateOpKind(kind) {
  if (!OP_KINDS.includes(kind)) {
    throw new RangeError(`unsupported op kind: ${kind}`);
  }
  return kind;
}

function buildOpKinds({ constIndex, cfid, chunkIndex = 0 }) {
  const count = 4 + (buildSeed(constIndex, 0, cfid, 0, 0xa5a5a5a5, chunkIndex) % 7);
  const kinds = [];
  for (let stepIndex = 0; stepIndex < count; stepIndex++) {
    const seed = buildSeed(constIndex, stepIndex, cfid, 0, 0x3c6ef372, chunkIndex);
    kinds.push(OP_KINDS[seed % OP_KINDS.length]);
  }
  return kinds;
}

function deriveOpParam({ kind, constIndex, stepIndex, cfid, width, chunkIndex = 0 }) {
  validateOpKind(kind);
  const normalizedWidth = width >>> 0;
  const seed = buildSeed(constIndex, stepIndex, cfid, normalizedWidth, 0x27d4eb2f, chunkIndex);

  if (kind === "rol" || kind === "ror") {
    return normalizedWidth === 0 ? 0 : seed % normalizedWidth;
  }

  if (kind === "mulOdd") {
    return (seed | 1) >>> 0;
  }

  return seed >>> 0;
}

function invertOpKinds(kinds) {
  return kinds
    .map((kind) => validateOpKind(kind))
    .map((kind) => {
      if (kind === "mulOdd") {
        throw new RangeError("mulOdd inversion requires inverse-parameter support");
      }
      return kind;
    })
    .slice()
    .reverse()
    .map((kind) => INVERSE_KIND[kind]);
}

module.exports = {
  OP_KINDS,
  buildOpKinds,
  deriveOpParam,
  invertOpKinds,
  validateOpKind,
};
