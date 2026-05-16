"use strict";

/**
 * Checks if a name matches an entry in the exempt list.
 * Supported formats: function{name}, method{name}, class{name}, field{name}
 * 
 * @param {string[]} exemptList 
 * @param {string} name 
 * @param {"function"|"method"|"class"|"field"} kind 
 * @returns {boolean}
 */
function matchesExempt(exemptList, name, kind = "function") {
  if (!name || !Array.isArray(exemptList) || exemptList.length === 0) return false;
  return exemptList.some((entry) => {
    const match = /^(function|method|class|field)\{(.+)\}$/.exec(entry);
    if (!match) return false;
    const entryKind = match[1];
    const entryName = match[2];

    if (kind === "function" || kind === "method") {
      return (entryKind === "function" || entryKind === "method") && entryName === name;
    }
    return entryKind === kind && entryName === name;
  });
}

module.exports = { matchesExempt };
