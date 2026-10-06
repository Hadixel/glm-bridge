// Patch the vendored ZCode CLI (zcode.cjs) so reasoning reaches clients.
//
// The CLI collects GLM's reasoning internally but drops it at the
// workspace/generateText protocol boundary, so no client ever sees
// thinking blocks. This script forwards it out.
//
// The bundle is minified, so variable names differ between ZCode
// builds. Every patch therefore matches on STRUCTURE (protocol field
// names like finishReason/toolCalls/usage, which are not minified)
// and uses backreferences for the minified identifiers. That makes the
// patch survive a ZCode re-extraction without manual re-anchoring.
//
// Usage: node patch-zcode.js <path-to-zcode.cjs>
// Exit 0 on success (including already-patched), 1 on failure.

'use strict';
const fs = require('fs');

const file = process.argv[2];
if (!file) {
  console.error('usage: node patch-zcode.js <zcode.cjs>');
  process.exit(2);
}
if (!fs.existsSync(file)) {
  console.error('not found:', file);
  process.exit(2);
}

let src = fs.readFileSync(file, 'utf8');

// Version-agnostic signature of an applied patch: the conditional
// spread that forwards the reasoning array (…X.reasoning.length?{reasoning:…).
const PATCHED_MARKER = '.reasoning.length?{reasoning:';
if (src.includes(PATCHED_MARKER)) {
  console.log('zcode.cjs reasoning passthrough: APPLIED (already patched)');
  process.exit(0);
}

// Each patch: [name, regex, replacement, required?]. Steps 2 and 3 are
// load-bearing (without them no reasoning reaches any client). Step 4 only
// declares the field in the result schema; the handler works without it, so
// a non-match is a warning, not a failure.
const patches = [
  {
    name: 'forward reasoning from the model result',
    // …finishReason:X.finishReason,usage:X.usage,…Y.length>0?{toolCalls:Y}:{}}
    re: /finishReason:(\w+)\.finishReason,usage:\1\.usage,\.\.\.(\w+)\.length>0\?\{toolCalls:\2\}:\{\}\}/,
    to: 'finishReason:$1.finishReason,usage:$1.usage,...$2.length>0?{toolCalls:$2}:{},...$1.reasoning&&$1.reasoning.length?{reasoning:$1.reasoning}:{}}',
    required: true,
  },
  {
    name: 'forward reasoning through the generateText handler',
    // return{text:X.text,selection:X.selection,finishReason:X.finishReason,…}
    re: /return\{text:(\w+)\.text,selection:\1\.selection,finishReason:\1\.finishReason,\.\.\.\1\.usage\?\{usage:\1\.usage\}:{},\.\.\.\1\.toolCalls\?\{toolCalls:\1\.toolCalls\}:\{\}\}/,
    to: 'return{text:$1.text,selection:$1.selection,finishReason:$1.finishReason,...$1.usage?{usage:$1.usage}:{},...$1.toolCalls?{toolCalls:$1.toolCalls}:{},...$1.reasoning&&$1.reasoning.length?{reasoning:$1.reasoning}:{}}',
    required: true,
  },
  {
    name: 'declare reasoning in the result schema',
    // X=Z.object({text:Z.string(),selection:S,toolCalls:Z.array(T).optional(),finishReason:…
    re: /(\w+)=(\w+)\.object\(\{text:\2\.string\(\),selection:(\w+),toolCalls:\2\.array\((\w+)\)\.optional\(\),finishReason:\2\.string\(\)\.optional\(\),/,
    to: '$1=$2.object({text:$2.string(),reasoning:$2.array($2.looseObject({type:$2.string(),text:$2.string()})).optional(),selection:$3,toolCalls:$2.array($4).optional(),finishReason:$2.string().optional(),',
    required: false,
  },
];

const counts = {};
for (const p of patches) {
  // Count ALL matches. A non-global regex only returns the first
  // match, which would hide ambiguity and let us patch the wrong
  // site — so force the global flag for counting.
  const g = new RegExp(p.re.source, p.re.flags.includes('g') ? p.re.flags : p.re.flags + 'g');
  const n = (src.match(g) || []).length;
  counts[p.name] = n;
  if (n === 1) {
    src = src.replace(p.re, p.to);
    console.log(`OK   ${p.name}`);
  } else if (n > 1) {
    console.log(`WARN ${p.name}: ${n} matches (expected 1) — skipped to avoid corrupting the bundle`);
  } else if (p.required) {
    console.log(`FAIL ${p.name}: anchor not found`);
  } else {
    console.log(`skip ${p.name}: anchor not found (non-load-bearing)`);
  }
}

const failed = patches.filter(p => p.required && counts[p.name] !== 1);
if (failed.length) {
  console.error('\nzcode.cjs NOT patched — reasoning will not reach clients.');
  console.error('The ZCode build likely changed its minified structure.');
  for (const p of failed) console.error(`  - ${p.name}`);
  process.exit(1);
}

// Verify the patch actually landed before writing.
if (!src.includes(PATCHED_MARKER)) {
  console.error('\nzcode.cjs NOT patched — verification failed (marker absent).');
  process.exit(1);
}

fs.writeFileSync(file, src);
console.log('\nzcode.cjs reasoning passthrough: APPLIED');
console.log('  thinking blocks now reach both OpenAI and Anthropic clients.');
