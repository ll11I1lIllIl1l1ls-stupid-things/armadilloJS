"use strict";

const { createSeededRng } = require("./random");

const MAX_LAYOUT_ATTEMPTS_PER_SIZE = 4096;
const MAX_TABLE_SIZE = 0xffff;

function allocateJunkLabels(realLabels, percent, seed = 0) {
  const junkCount = Math.floor(realLabels.length * percent);
  if (junkCount <= 0) return [];

  const blocked = new Set(realLabels);
  const rng = createSeededRng(seed);
  const junkLabels = [];

  while (junkLabels.length < junkCount) {
    const candidate = `__junk_${rng.nextUint32().toString(36)}`;
    if (blocked.has(candidate)) continue;
    blocked.add(candidate);
    junkLabels.push(candidate);
  }

  return junkLabels;
}

function buildTableLayout(entries, options = {}) {
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new RangeError("table layout requires non-empty input");
  }

  const seed = options.seed ?? 0;
  const loadFactor = normalizeLoadFactor(options.loadFactor);
  const hashMode = options.hashMode === "dispatch32" ? "dispatch32" : "default";
  const labels = entries.map((entry) => readLabel(entry));
  assertUniqueLabels(labels);
  const payloads = entries.map((entry) => (Object.prototype.hasOwnProperty.call(entry, "payload") ? entry.payload : entry));
  let tableSize = nextPow2(Math.max(Math.ceil(labels.length / loadFactor), 2));

  assertTableSize(tableSize);

  while (tableSize <= MAX_TABLE_SIZE) {
    for (let attempt = 0; attempt < MAX_LAYOUT_ATTEMPTS_PER_SIZE; attempt++) {
      const layoutSeed = mixSeed(seed, attempt, tableSize);
      const slots = placeLabels(labels, payloads, layoutSeed, tableSize, hashMode);
      if (slots) {
        return {
          kind: "TableLayout",
          labels,
          payloads,
          seed: layoutSeed,
          hashMode,
          tableSize,
          attempts: attempt + 1,
          slots,
          decoySlots: collectDecoySlots(slots),
        };
      }
    }
    tableSize *= 2;
    assertTableSize(tableSize);
  }

  throw new RangeError(`table size exceeds u16 operand capacity: ${tableSize}`);
}

function readLabel(entry) {
  if (entry && Object.prototype.hasOwnProperty.call(entry, "label")) return entry.label;
  if (entry && Object.prototype.hasOwnProperty.call(entry, "key")) return entry.key;
  throw new TypeError("table entries require a label or key");
}

function assertUniqueLabels(labels) {
  const seen = new Set();
  for (const label of labels) {
    const key = stableLabelKey(label);
    if (seen.has(key)) throw new RangeError(`duplicate table label: ${String(label)}`);
    seen.add(key);
  }
}

function placeLabels(labels, payloads, seed, tableSize, hashMode) {
  const slots = Array(tableSize).fill(null);

  for (let index = 0; index < labels.length; index++) {
    const slot = slotForLabel(labels[index], seed, tableSize, hashMode);
    if (slots[slot]) return null;
    slots[slot] = { slot, index, label: labels[index], payload: payloads[index] };
  }

  return slots;
}

function collectDecoySlots(slots) {
  const decoySlots = [];
  for (let slot = 0; slot < slots.length; slot++) {
    if (!slots[slot]) decoySlots.push(slot);
  }
  return decoySlots;
}

function nextPow2(value) {
  if (!Number.isSafeInteger(value) || value < 1) throw new RangeError("nextPow2 requires a positive safe integer");
  let size = 1;
  while (size < value) size *= 2;
  return size;
}

function slotForLabel(label, seed, tableSize, hashMode) {
  if (hashMode === "dispatch32" && typeof label === "number") return computeNumericSlot(label, seed, tableSize);
  const mask = BigInt(tableSize - 1);
  return Number(mix64(hashLabel(label) ^ BigInt(seed)) & mask);
}

function computeNumericSlot(value, seed, tableSize) {
  return computeNumericHash(value, seed) & (tableSize - 1);
}

function computeNumericHash(value, seed = 0) {
  if (!Number.isSafeInteger(value)) throw new RangeError(`dispatch32 label must be a safe integer: ${value}`);
  const mixed = (value ^ seed) | 0;
  return (Math.imul(mixed, 31) ^ (mixed >>> 1)) | 0;
}

function normalizeLoadFactor(loadFactor) {
  if (typeof loadFactor !== "number" || !Number.isFinite(loadFactor) || loadFactor <= 0) {
    return 0.5;
  }
  return loadFactor;
}

function assertTableSize(tableSize) {
  if (!Number.isSafeInteger(tableSize) || tableSize < 1) {
    throw new RangeError(`invalid table size: ${tableSize}`);
  }
  if (tableSize > MAX_TABLE_SIZE) {
    throw new RangeError(`table size exceeds u16 operand capacity: ${tableSize}`);
  }
}

function mixSeed(seed, attempt, tableSize) {
  return Number(mix64(BigInt.asUintN(64, BigInt(seed)) ^ (BigInt(attempt) << 32n) ^ BigInt(tableSize)) & 0xffffffffn);
}

function hashLabel(label) {
  if (typeof label === "number") {
    if (!Number.isSafeInteger(label)) throw new RangeError(`table label must be a safe integer: ${label}`);
    return BigInt.asUintN(64, BigInt(label));
  }
  const text = stableLabelKey(label);
  let hash = 0xcbf29ce484222325n;
  for (let index = 0; index < text.length; index++) {
    hash ^= BigInt(text.charCodeAt(index));
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return hash;
}

function stableLabelKey(label) {
  if (typeof label === "number") {
    if (!Number.isSafeInteger(label)) throw new RangeError(`table label must be a safe integer: ${label}`);
    return Object.is(label, -0) ? "number:-0" : `number:${label}`;
  }
  if (typeof label === "string") return `string:${label}`;
  throw new TypeError(`unsupported table label type: ${typeof label}`);
}

function mix64(value) {
  let mixed = BigInt.asUintN(64, value);
  mixed ^= mixed >> 30n;
  mixed = BigInt.asUintN(64, mixed * 0xbf58476d1ce4e5b9n);
  mixed ^= mixed >> 27n;
  mixed = BigInt.asUintN(64, mixed * 0x94d049bb133111ebn);
  mixed ^= mixed >> 31n;
  return BigInt.asUintN(64, mixed);
}

module.exports = {
  allocateJunkLabels,
  assertTableSize,
  buildTableLayout,
  computeNumericHash,
  computeNumericSlot,
  nextPow2,
};
