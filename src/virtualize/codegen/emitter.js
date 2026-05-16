"use strict";

const { runtimeSource } = require("../runtime");

function emitJavaScript(bytes) {
  return `"use strict";\n(function(){\n  var bytes = new Uint8Array([${Array.from(bytes).join(",")}]);\n  var run = ${runtimeSource};\n  run(bytes, globalThis);\n})();\n`;
}

module.exports = { emitJavaScript };
