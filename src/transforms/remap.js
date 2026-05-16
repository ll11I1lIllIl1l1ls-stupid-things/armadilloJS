"use strict";

const { OP, OPERANDS } = require("../virtualize/opcodes");
const { matchesExempt } = require("./shared/match");

function createRemapTransform(options = {}) {
  return {
    run(module) {
      const clone = cloneModule(module);
      const usage = analyzeConstantUsage(clone);
      applyMetadataModes(clone, usage, options);
      return clone;
    },
  };
}

function cloneModule(value) {
  if (value instanceof Uint8Array) return Uint8Array.from(value);
  if (value instanceof RegExp) return new RegExp(value.source, value.flags);
  if (Array.isArray(value)) return value.map(cloneModule);
  if (value && typeof value === "object") {
    const out = {};
    for (const [key, child] of Object.entries(value)) out[key] = cloneModule(child);
    return out;
  }
  return value;
}

function analyzeConstantUsage(module) {
  const usage = new Map();
  const funcs = module.funcs || module.functions || [];
  const classes = module.classes || [];
  const literals = getLiterals(module);

  funcs.forEach((func, funcIdx) => {
    addMetadataRef(usage, getFunctionNameRefIndex(func, literals), { kind: "functionName", funcIdx });
    scanFunctionCode(func.code || [], (constIdx, ref) => addRuntimeRef(usage, constIdx, { funcIdx, ...ref }));
  });

  classes.forEach((classDef, classIdx) => {
    addMetadataRef(usage, getClassNameRefIndex(classDef, literals), { kind: "className", classIdx });
    for (const [slotIdx, slot] of getPrivateSlots(classDef).entries()) {
      addMetadataRef(usage, getPrivateSlotRefIndex(slot, literals), { kind: "privateSlotName", classIdx, slotIdx });
    }
    addClassKeyRefs(usage, classDef.methods, "methodKey", classIdx);
    addClassKeyRefs(usage, classDef.statics, "staticKey", classIdx);
    addClassKeyRefs(usage, classDef.instanceFields, "instanceFieldKey", classIdx);
    addClassKeyRefs(usage, classDef.staticFields, "staticFieldKey", classIdx);
  });

  return usage;
}

function addClassKeyRefs(usage, entries = [], kind, classIdx) {
  entries.forEach((entry, entryIdx) => {
    addRuntimeRef(usage, entry.keyIndex, { kind, classIdx, entryIdx });
  });
}

function addMetadataRef(usage, constIdx, ref) {
  if (!isConstIndex(constIdx)) return;
  getUsageRecord(usage, constIdx).metadataNameRefs.push(ref);
}

function addRuntimeRef(usage, constIdx, ref) {
  if (!isConstIndex(constIdx)) return;
  getUsageRecord(usage, constIdx).runtimeRefs.push(ref);
}

function getUsageRecord(usage, constIdx) {
  let record = usage.get(constIdx);
  if (!record) {
    record = { metadataNameRefs: [], runtimeRefs: [] };
    usage.set(constIdx, record);
  }
  return record;
}

function isConstIndex(value) {
  return Number.isInteger(value) && value >= 0;
}

function scanFunctionCode(code, visitConstIndex) {
  let pc = 0;
  while (pc < code.length) {
    let dynMask = 0;
    let prefixCount = 0;
    while (code[pc] === OP.dyn) {
      if (++prefixCount > 8) throw new RangeError("dyn chain too long");
      const which = code[pc + 1];
      if (!Number.isInteger(which) || which < 0 || which > 7) throw new RangeError(`Invalid dyn operand index ${which}`);
      dynMask |= 1 << which;
      pc += 2;
    }

    const opPc = pc;
    const op = code[pc++];
    const operandTypes = OPERANDS[op];
    if (!operandTypes) throw new TypeError(`Unsupported opcode ${op}`);

    const decodedOperands = [];
    const immediateOperands = [];
    for (let operandIndex = 0; operandIndex < operandTypes.length; operandIndex++) {
      if ((dynMask & (1 << operandIndex)) !== 0) {
        decodedOperands[operandIndex] = undefined;
        immediateOperands[operandIndex] = false;
        continue;
      }
      decodedOperands[operandIndex] = readOperand(code, pc, operandTypes[operandIndex]);
      immediateOperands[operandIndex] = true;
      pc += operandSize(operandTypes[operandIndex]);
    }

    if (op === OP.iter_op && (decodedOperands[0] === undefined || decodedOperands[0] === 1 || decodedOperands[0] === 4)) {
      pc += operandSize("i16");
    }

    for (let operandIndex = 0; operandIndex < decodedOperands.length; operandIndex++) {
      if (!immediateOperands[operandIndex]) continue;
      if (classifyConstOperand(op, operandIndex, decodedOperands) === "runtime") {
        visitConstIndex(decodedOperands[operandIndex], { kind: "bytecode", op, opPc, operandIndex });
      }
    }
  }
}

function readOperand(code, pc, type) {
  if (type === "u8") return code[pc];
  if (type === "u16") return code[pc] | (code[pc + 1] << 8);
  if (type === "i16") {
    const value = code[pc] | (code[pc + 1] << 8);
    return value >= 0x8000 ? value - 0x10000 : value;
  }
  throw new TypeError(`Unsupported operand type ${type}`);
}

function operandSize(type) {
  if (type === "u8") return 1;
  if (type === "u16" || type === "i16") return 2;
  throw new TypeError(`Unsupported operand type ${type}`);
}

function classifyConstOperand(op, operandIndex, decodedOperands) {
  if (op === OP.push && operandIndex === 0) return "runtime";
  if (op === OP.get_prop && operandIndex === 0) return "runtime";
  if (op === OP.set_prop && operandIndex === 0) return "runtime";
  if (op === OP.call_method && operandIndex === 0) return "runtime";
  if (op === OP.def_prop && operandIndex === 1) return "runtime";
  if (op === OP.del && operandIndex === 1 && (decodedOperands[0] === undefined || decodedOperands[0] === 0)) return "runtime";
  if ((op === OP.load || op === OP.store) && operandIndex === 1) {
    const scope = decodedOperands[0];
    if (scope === undefined || scope === 2 || scope === 3) return "runtime";
  }
  return null;
}

function applyMetadataModes(module, usage, options) {
  const funcs = module.funcs || module.functions || [];
  const classes = module.classes || [];
  const literals = getLiterals(module);
  const taken = collectLiteralNames(module);

  if (options.methods != "keep") {
    for (const func of funcs) {
      delete func.srcMap;
    }
  }

  if (options.methods === "strip") {
    for (const func of funcs) {
      stripFunctionName(usage, func, getFunctionNameRefIndex(func, literals));
    }
  } else if (options.methods === "remap") {
    const generator = createNameGenerator(options);
    for (const func of funcs) {
      const refIdx = getFunctionNameRefIndex(func, literals);
      const name = isConstIndex(refIdx) ? literals[refIdx] : (typeof func.name === "string" ? func.name : null);
      if (matchesExempt(options.exempt, name, "function")) continue;
      remapFunctionName(module, usage, func, taken, generator, options.methodPrefix || "", refIdx);
    }
  }

  if (options.module === "strip") {
    for (const classDef of classes) {
      stripClassName(usage, classDef, getClassNameRefIndex(classDef, literals));
    }
  } else if (options.module === "remap") {
    const generator = createNameGenerator(options);
    for (const classDef of classes) {
      const refIdx = getClassNameRefIndex(classDef, literals);
      const name = isConstIndex(refIdx) ? literals[refIdx] : (typeof classDef.name === "string" ? classDef.name : null);
      if (matchesExempt(options.exempt, name, "class")) continue;
      remapClassName(module, usage, classDef, taken, generator, options.modulePrefix || "", refIdx);
    }
  }

  if (options.fields === "strip") {
    for (const classDef of classes) {
      for (const slot of getPrivateSlots(classDef)) {
        stripPrivateSlotName(module, usage, slot, getPrivateSlotRefIndex(slot, literals));
      }
    }
  } else if (options.fields === "remap") {
    const generator = createNameGenerator(options);
    for (const classDef of classes) {
      for (const slot of getPrivateSlots(classDef)) {
        const refIdx = getPrivateSlotRefIndex(slot, literals);
        const name = isConstIndex(refIdx) ? literals[refIdx] : (typeof slot.name === "string" ? slot.name : null);
        if (matchesExempt(options.exempt, name, "field")) continue;
        remapPrivateSlotName(module, usage, slot, taken, generator, options.fieldPrefix || "", refIdx);
      }
    }
  }
}

function stripFunctionName(usage, func, refIdx) {
  if (isConstIndex(refIdx)) {
    if (canStrip(usage, refIdx)) func.nameIdx = -1;
    return;
  }
  if (typeof func.name === "string") func.name = undefined;
}

function remapFunctionName(module, usage, func, taken, generator, prefix, refIdx) {
  if (isConstIndex(refIdx)) {
    if (canRemap(usage, refIdx)) func.nameIdx = getOrAppendLiteral(module, generator.next(prefix, taken));
    return;
  }
  if (typeof func.name === "string") func.name = generator.next(prefix, taken);
}

function stripClassName(usage, classDef, refIdx) {
  if (isConstIndex(refIdx)) {
    if (canStrip(usage, refIdx)) classDef.nameIdx = -1;
    return;
  }
  if (typeof classDef.module === "string" || typeof classDef.name === "string") {
    classDef.nameIdx = -1;
    classDef.module = undefined;
    classDef.name = undefined;
  }
}

function remapClassName(module, usage, classDef, taken, generator, prefix, refIdx) {
  if (isConstIndex(refIdx)) {
    if (canRemap(usage, refIdx)) classDef.nameIdx = getOrAppendLiteral(module, generator.next(prefix, taken));
    return;
  }
  if (typeof classDef.module === "string" || typeof classDef.name === "string") {
    classDef.nameIdx = getOrAppendLiteral(module, generator.next(prefix, taken));
    classDef.module = undefined;
    classDef.name = undefined;
  }
}

function stripPrivateSlotName(module, usage, slot, refIdx) {
  if (isConstIndex(refIdx)) {
    if (canStrip(usage, refIdx)) slot.nameIdx = ensureEmptyStringConstant(module);
    return;
  }
  if (typeof slot.name === "string") {
    slot.nameIdx = ensureEmptyStringConstant(module);
    slot.name = undefined;
  }
}

function remapPrivateSlotName(module, usage, slot, taken, generator, prefix, refIdx) {
  if (isConstIndex(refIdx)) {
    if (canRemap(usage, refIdx)) slot.nameIdx = getOrAppendLiteral(module, generator.next(prefix, taken));
    return;
  }
  if (typeof slot.name === "string") {
    slot.nameIdx = getOrAppendLiteral(module, generator.next(prefix, taken));
    slot.name = undefined;
  }
}

function getFunctionNameRefIndex(func, literals) {
  if (isConstIndex(func.nameIdx)) return func.nameIdx;
  if (typeof func.name === "string") return literals.indexOf(func.name);
  return -1;
}

function getClassNameRefIndex(classDef, literals) {
  if (isConstIndex(classDef.nameIdx)) return classDef.nameIdx;
  if (typeof classDef.module === "string") return literals.indexOf(classDef.module);
  if (typeof classDef.name === "string") return literals.indexOf(classDef.name);
  return -1;
}

function getPrivateSlotRefIndex(slot, literals) {
  if (isConstIndex(slot.nameIdx)) return slot.nameIdx;
  if (typeof slot.name === "string") return literals.indexOf(slot.name);
  return -1;
}

function getPrivateSlots(classDef) {
  return classDef.privateSlots || classDef.fields || [];
}

function canStrip(usage, constIdx) {
  if (!isConstIndex(constIdx)) return false;
  const record = usage.get(constIdx);
  return !!record && record.runtimeRefs.length === 0;
}

function canRemap(usage, constIdx) {
  return canStrip(usage, constIdx);
}

function collectLiteralNames(module) {
  return new Set(getLiterals(module).filter((literal) => typeof literal === "string"));
}

function flattenDictionary(dictionary) {
  const source = Array.isArray(dictionary) ? dictionary.join("") : String(dictionary || "");
  const alphabet = Array.from(source);
  if (alphabet.length === 0) throw new Error("remap.dictionary must provide at least one symbol");
  return alphabet;
}

function createNameGenerator(options) {
  const alphabet = flattenDictionary(options.dictionary);
  let counter = 0;
  return {
    next(prefix, taken) {
      while (true) {
        const candidate = `${prefix}${encodeToken(counter++, alphabet)}`;
        if (!taken.has(candidate)) {
          taken.add(candidate);
          return candidate;
        }
      }
    },
  };
}

function encodeToken(counter, alphabet) {
  const chars = [];
  let value = counter;
  do {
    chars.unshift(alphabet[value % alphabet.length]);
    value = Math.floor(value / alphabet.length) - 1;
  } while (value >= 0);
  return chars.join("");
}

function ensureEmptyStringConstant(module) {
  return getOrAppendLiteral(module, "");
}

function getOrAppendLiteral(module, value) {
  const literals = getLiterals(module);
  const existing = literals.indexOf(value);
  if (existing >= 0) return existing;
  literals.push(value);
  return literals.length - 1;
}

function getLiterals(module) {
  const literals = module.constPool && Array.isArray(module.constPool.literals)
    ? module.constPool.literals
    : module.constants;
  if (!Array.isArray(literals)) throw new TypeError("VM module constants must be an array");
  return literals;
}

module.exports = { createRemapTransform };
