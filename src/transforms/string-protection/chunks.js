"use strict";

const STRING_PROTECTION_CHUNK_SIZE = 32;

function splitBytesIntoChunks(bytes, chunkSize = STRING_PROTECTION_CHUNK_SIZE) {
  const out = [];
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    out.push(bytes.slice(offset, Math.min(offset + chunkSize, bytes.length)));
  }
  return out;
}

function encodeChunkedPayload(prefix, chunks) {
  if (typeof prefix !== "string" || prefix.length !== 1) {
    throw new RangeError("chunked payload prefix must be exactly one code unit");
  }
  let out = prefix;
  out += String.fromCharCode(chunks.length);
  for (const chunk of chunks) out += String.fromCharCode(chunk.length);
  for (const chunk of chunks) {
    for (let index = 0; index < chunk.length; index++) out += String.fromCharCode(chunk[index]);
  }
  return out;
}

function headerLengthForChunkCount(chunkCount) {
  return 2 + chunkCount;
}

module.exports = {
  STRING_PROTECTION_CHUNK_SIZE,
  splitBytesIntoChunks,
  encodeChunkedPayload,
  headerLengthForChunkCount,
};
