"use strict";

const fs = require("fs");
const path = require("path");
const { compile } = require("./compiler");
const { createTransformPipeline } = require("../transforms");
const { serializeModule } = require("./codegen/serializer");
const { emitJavaScript } = require("./codegen/emitter");

async function virtualizeProject(config) {
  for (const source of config.sources) {
    const files = listJavaScriptFiles(source.input);
    for (const inputFile of files) {
      const rel = path.relative(source.input, inputFile);
      const outputFile = path.join(source.output, rel);
      virtualizeFile(inputFile, outputFile, config);
    }
  }
}

function virtualizeFile(inputFile, outputFile, config) {
  const source = fs.readFileSync(inputFile, "utf8");
  const pipeline = createTransformPipeline(config);
  const module = pipeline.run(compile(source, inputFile));
  const bytes = serializeModule(module);
  const output = emitJavaScript(bytes);
  fs.mkdirSync(path.dirname(outputFile), { recursive: true });
  fs.writeFileSync(outputFile, output, "utf8");
}

function listJavaScriptFiles(root) {
  const stat = fs.statSync(root);
  if (stat.isFile()) return root.endsWith(".js") ? [root] : [];
  const out = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) out.push(...listJavaScriptFiles(full));
    else if (entry.isFile() && entry.name.endsWith(".js")) out.push(full);
  }
  return out;
}

module.exports = { virtualizeProject, virtualizeFile, listJavaScriptFiles };
