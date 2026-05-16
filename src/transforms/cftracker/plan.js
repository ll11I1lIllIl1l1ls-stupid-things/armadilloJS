"use strict";

const { createSeededRng } = require("../shared/random");

function buildBlockPlan(branchCfg, seed, funcIdx, options = {}) {
  const rng = createSeededRng(seed ^ Math.imul(funcIdx + 1, 0x9e3779b1));
  const usedCfids = new Set();
  const cfidCache = new Map();
  const preassignedCfids = options.preassignedCfids instanceof Map ? options.preassignedCfids : new Map();

  function getCfid(blockId) {
    if (!isValidBlockId(blockId)) throw new TypeError(`Invalid block id ${blockId}`);
    if (cfidCache.has(blockId)) return cfidCache.get(blockId);
    const preassigned = preassignedCfids.get(blockId);
    if (Number.isInteger(preassigned)) {
      usedCfids.add(preassigned);
      cfidCache.set(blockId, preassigned);
      return preassigned;
    }
    let cfid = 0;
    do {
      cfid = rng.nextUint32() | 0;
    } while (usedCfids.has(cfid));
    usedCfids.add(cfid);
    cfidCache.set(blockId, cfid);
    return cfid;
  }

  const blocks = (branchCfg.blocks || []).map((block) => ({
    ...block,
    cfid: getCfid(getBlockId(block)),
  }));
  const entryCfid = blocks[0]?.cfid ?? deriveEntryCfid(seed, funcIdx);
  if (Number.isInteger(entryCfid) && !usedCfids.has(entryCfid)) {
    usedCfids.add(entryCfid);
  }
  return {
    blocks,
    pcToBlock: { ...(branchCfg.pcToBlock || {}) },
    blockCfids: blocks.map((block) => block.cfid),
    entryCfid,
    getCfid,
  };
}

function getBlockId(block) {
  return Object.prototype.hasOwnProperty.call(block, "id") ? block.id : block.blockId;
}

function isValidBlockId(blockId) {
  return Number.isInteger(blockId) || typeof blockId === "string";
}

function deriveEntryCfid(seed, funcIdx) {
  return mix32(seed ^ Math.imul(funcIdx + 1, 0x9e3779b1));
}

function mix32(value) {
  let state = value >>> 0;
  state ^= state >>> 16;
  state = Math.imul(state, 0x7feb352d) >>> 0;
  state ^= state >>> 15;
  state = Math.imul(state, 0x846ca68b) >>> 0;
  state ^= state >>> 16;
  return state >>> 0;
}

module.exports = { buildBlockPlan, deriveEntryCfid };
