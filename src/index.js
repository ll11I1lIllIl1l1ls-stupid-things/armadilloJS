#!/usr/bin/env node
"use strict";

const { readConfig } = require("./config");
const { virtualizeProject } = require("./virtualize");

async function main(argv) {
  const configIndex = argv.indexOf("--config");
  if (configIndex === -1 || !argv[configIndex + 1]) throw new Error("Usage: node src/index.js --config <config.json>");
  await virtualizeProject(readConfig(argv[configIndex + 1]));
}

main(process.argv.slice(2)).catch((error) => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exitCode = 1;
});
