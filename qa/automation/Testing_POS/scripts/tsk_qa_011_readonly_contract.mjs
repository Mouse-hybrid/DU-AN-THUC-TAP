#!/usr/bin/env node
// TSK-QA-011 contract preflight. GET only; no login, order or table mutation.
import fs from 'node:fs/promises';
import path from 'node:path';

const BASE = 'http://160.191.47.17';
const evidenceDir = path.resolve(import.meta.dirname, '..', '..', '..', '..', 'evidence', 'DES-QA-05');
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const evidenceFile = path.join(evidenceDir, `TSK_QA_011_CONTRACT_${stamp}.log`);
const lines = [];
const record = (line) => { lines.push(line); console.log(line); };

async function getJson(url) {
  const response = await fetch(url, { method: 'GET', signal: AbortSignal.timeout(10000) });
  if (!response.ok) throw new Error(`${new URL(url).pathname} HTTP ${response.status}`);
  return response.json();
}

function requestText(operation, spec) {
  const seen = new Set();
  function expand(value, depth=0) {
    if (depth>12 || value==null) return '';
    if (Array.isArray(value)) return value.map(x=>expand(x,depth+1)).join(' ');
    if (typeof value!=='object') return String(value);
    if (value.$ref) {
      if (seen.has(value.$ref)) return '';
      seen.add(value.$ref);
      const node=value.$ref.split('/').slice(1).reduce((o,key)=>o?.[key],spec);
      return expand(node,depth+1);
    }
    return Object.entries(value).map(([key,val])=>`${key} ${expand(val,depth+1)}`).join(' ');
  }
  return expand({parameters:operation.parameters,requestBody:operation.requestBody});
}

let exitCode=0;
try {
  const before=await getJson(`${BASE}/version`);
  const commit=String(before.commit??'');
  if (!/^[0-9a-f]{40}$/i.test(commit)) throw new Error('/version lacks a full commit SHA');
  const spec=await getJson(`${BASE}/openapi.json`);
  record(`[TSK-QA-011] Read-only OpenAPI staging commit ${commit}; ${Object.keys(spec.paths??{}).length} paths`);

  const operations=Object.entries(spec.paths??{}).flatMap(([url,definition]) =>
    Object.entries(definition).filter(([verb])=>/^(get|post|put|patch|delete)$/i.test(verb))
      .map(([verb,details])=>({url,verb:verb.toUpperCase(),details})));
  const writes=operations.filter(x=>x.verb!=='GET' && /\/orders\//.test(x.url));
  const versionWrites=writes.filter(x=>/\b(expected_version|if-match)\b/i.test(requestText(x.details,spec)));
  const voidOps=writes.filter(x=>/\/void\b/i.test(x.url));
  const pinVoids=voidOps.filter(x=>/\b(pin|supervisor_pin)\b/i.test(requestText(x.details,spec)));
  const transferOps=operations.filter(x=>x.verb!=='GET' &&
    /\/(tables|orders)\/.*\b(transfer|move|merge|split)\b/i.test(x.url));
  record(`[TSK-QA-011] Version precondition documented on ${versionWrites.length} order write operation(s): ${versionWrites.map(x=>`${x.verb} ${x.url}`).join(', ')||'none'}`);
  record(`[TSK-QA-011] Void operations ${voidOps.length}; PIN input documented on ${pinVoids.length}: ${pinVoids.map(x=>`${x.verb} ${x.url}`).join(', ')||'none'}`);
  record(`[TSK-QA-011] Transfer/merge/split table or order write operation(s) ${transferOps.length}: ${transferOps.map(x=>`${x.verb} ${x.url}`).join(', ')||'none'}`);
  const after=await getJson(`${BASE}/version`);
  if (after.commit!==commit) throw new Error(`build changed during preflight: ${commit} -> ${after.commit}`);
  if (versionWrites.length===0 || pinVoids.length===0 || transferOps.length===0) {
    record('[TSK-QA-011] BLOCKED/DEFERRED: full business task has missing live contracts. BE response 22/10 places these in Phase 2; no business case executed.');
  } else {
    record('[TSK-QA-011] CONTRACT READY FOR REVIEW: do not mark business Passed without isolated fixture, permissions, expected/error assertions and cleanup.');
  }
} catch(error) {
  exitCode=2;
  record(`[TSK-QA-011] INCONCLUSIVE: ${error.message}; staging contract was not verified. No mutation.`);
} finally {
  await fs.mkdir(evidenceDir,{recursive:true});
  await fs.writeFile(evidenceFile,`${lines.join('\n')}\n`);
  console.log(`TSK-QA-011 evidence: ${evidenceFile}`);
}
// Let pending stdout/TTY writes finish before Node exits, particularly on Windows.
process.exitCode = exitCode;
