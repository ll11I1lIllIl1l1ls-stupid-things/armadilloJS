"use strict";

const fs = require("fs");
const path = require("path");
const { compile } = require("../src/virtualize/compiler");
const { createTransformPipeline } = require("../src/transforms");
const { disassembleModule } = require("../src/virtualize/asm/disassembler");

/**
 * Disassembles a JavaScript file into ArmadilloJS VM bytecode.
 * 
 * Usage: node tools/disassemble.js <input_file.js>
 */
function main() {
  const inputFile = process.argv[2];
  if (!inputFile) {
    console.error("Usage: node tools/disassemble.js <input_file.js>");
    process.exit(1);
  }

  if (!fs.existsSync(inputFile)) {
    console.error(`File not found: ${inputFile}`);
    process.exit(1);
  }

  try {
    const source = fs.readFileSync(inputFile, "utf8");
    
    const match = source.match(/new Uint8Array\(\[([\s\S]*?)\]\)/);
    if (match && source.includes("createRuntime")) {
      const bytesArray = match[1].split(',').map(Number);
      const bytes = new Uint8Array(bytesArray);
      const disassembly = disassembleModule(bytes);
      console.log(disassembly);
      return;
    }

    // 1. Compile source to IR module
    const module = compile(source, inputFile);
    
    // 2. (Optional) Run transform pipeline if needed
    // In this case, we'll use a default config for basic virtualization
    const config = { virtualize: { enabled: true } };
    const pipeline = createTransformPipeline(config);
    const transformedModule = pipeline.run(module);
    
    // 3. Disassemble the module
    const disassembly = disassembleModule(transformedModule);
    
    console.log(disassembly);
  } catch (err) {
    console.error("Failed to disassemble module:");
    console.error(err.stack);
    process.exit(1);
  }
}

main();
