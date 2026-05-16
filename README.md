# ArmadilloJS

> [!CAUTION]
> **Usage of AI.** Although the author has conducted some testing, unexpected results may still occur. The author assumes no responsibility for such outcomes.

ArmadilloJS is an open source JavaScript virtualization obfuscator. It compiles supported JavaScript into custom VM bytecode, serializes that bytecode, and emits a self-contained JavaScript file containing both the bytecode payload and VM runtime.

The project intentionally does not obfuscate the original JavaScript after virtualization. All obfuscation passes (except virtualize) only operate on VM bytecode or VM bytecode assembly abstractions.

## Current status

ArmadilloJS is in early development. The following limitations currently apply:

- JavaScript support: Only partial ES5 is supported, along with a very small subset of ES6 features.
- VM runtime: The virtual machine itself is currently **not obfuscated** and includes a crash tracker for debugging purposes.
- Obfuscation passes: Only the following basic passes are available and they are all implemented terribly:
  - control flow obfuscation
  - String obfuscation
  - Number obfuscation
  - Remap

See an example of [a simple script](./input/test.js) and [its obfuscated version](./output/test.js)

## Quick start

```bash
npm install
node src/index.js --config config.example.json
node output/test.js
```
