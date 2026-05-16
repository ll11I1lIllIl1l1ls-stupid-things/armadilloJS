"use strict";

const { buildBranchCfg } = require("../../virtualize/asm/cfg");
const { buildBlockPlan } = require("./plan");

class CfTrackerContext {
  constructor() {
    this.metadata = null;
  }

  hasMetadata() {
    return this.metadata !== null;
  }

  preprocessModule(module, options = {}) {
    if (!isVMModuleArtifact(module)) {
      this.metadata = null;
      return null;
    }
    if (this.metadata && this.metadata.module === module) return this.metadata;

    const seed = options.seed ?? 0;
    const funcs = module.funcs || module.functions || [];
    const functions = funcs.map((func, funcIdx) => {
      if (!func) return null;
      const branchCfg = buildBranchCfg(func.code || [], func.exTable || []);
      const cfgMeta = options.cfg?.getFunctionMetadata?.(funcIdx) || null;
      const preassignedCfids = createPreassignedCfids(branchCfg.blocks || [], cfgMeta?.blocks || []);
      const blockPlan = buildBlockPlan(branchCfg, seed, funcIdx, { preassignedCfids });
      return {
        functionId: funcIdx,
        graph: branchCfg,
        blocks: blockPlan.blocks,
        pcToBlock: blockPlan.pcToBlock,
        blockCfids: blockPlan.blockCfids,
        entryCfid: blockPlan.entryCfid,
        getCfid: blockPlan.getCfid,
      };
    });
    const functionsById = new Map(functions.filter(Boolean).map((entry) => [entry.functionId, entry]));
    this.metadata = { module, functions, functionsById, seed };
    return this.metadata;
  }

  getFunctionMetadata(functionId) {
    if (!this.metadata) return null;
    return this.metadata.functionsById.get(functionId) || null;
  }

  getBlockCfid(functionId, blockId) {
    const functionMeta = this.getFunctionMetadata(functionId);
    if (!functionMeta) return null;
    return functionMeta.getCfid ? functionMeta.getCfid(blockId) : null;
  }

  getEntryCfid(functionId) {
    return this.getFunctionMetadata(functionId)?.entryCfid ?? null;
  }
}

class CfTrackerTransformer {
  constructor(options = {}) {
    this.seed = options.seed ?? 0;
  }

  run(module, context) {
    if (!isVMModuleArtifact(module)) return module;
    if (context && context.cftracker instanceof CfTrackerContext) {
      context.cftracker.preprocessModule(module, { seed: this.seed, cfg: context.cfg });
    }
    return module;
  }
}

function createCfTrackerContext() {
  return new CfTrackerContext();
}

function createCfTrackerTransform(options = {}) {
  if (options.enabled !== true) {
    return { run(module) { return module; } };
  }
  return new CfTrackerTransformer(options);
}

function isVMModuleArtifact(value) {
  return !!value
    && typeof value === "object"
    && typeof value.entry === "number"
    && (Array.isArray(value.functions) || Array.isArray(value.funcs));
}

function getBlockId(block) {
  return Object.prototype.hasOwnProperty.call(block, "blockId") ? block.blockId : block.id;
}

function createPreassignedCfids(targetBlocks, sourceBlocks) {
  const preassigned = new Map();
  for (const targetBlock of targetBlocks) {
    const targetStart = getBlockStart(targetBlock);
    const targetEnd = getBlockEnd(targetBlock);
    const sourceBlock = findLogicalSourceBlock(sourceBlocks, targetStart, targetEnd);
    if (!sourceBlock || !Number.isInteger(sourceBlock.cfid)) continue;
    preassigned.set(getBlockId(targetBlock), sourceBlock.cfid);
  }
  return preassigned;
}

function findLogicalSourceBlock(sourceBlocks, targetStart, targetEnd) {
  return sourceBlocks.find((block) => block.startPc === targetStart && block.endPc === targetEnd)
    || sourceBlocks.find((block) => block.startPc === targetStart)
    || sourceBlocks.find((block) => block.startPc <= targetStart && targetEnd <= block.endPc)
    || null;
}

function getBlockStart(block) {
  return Number.isInteger(block.startPc) ? block.startPc : block.start;
}

function getBlockEnd(block) {
  return Number.isInteger(block.endPc) ? block.endPc : block.end;
}

module.exports = { createCfTrackerContext, createCfTrackerTransform, CfTrackerContext, CfTrackerTransformer };
