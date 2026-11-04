// Phase 2 staff contract readiness. Three GETs only; no login or staff mutation.
import {readFileSync, writeFileSync, mkdirSync} from 'node:fs';
import {dirname, join} from 'node:path';

const cases = [
  {id:'P2-USR-001', operations:['POST /api/v1/staff']},
  {id:'P2-USR-002', operations:['GET /api/v1/staff','POST /api/v1/staff']},
  {id:'P2-USR-003', operations:['PATCH /api/v1/staff/{staff_id}']},
  {id:'P2-USR-004', operations:['POST /api/v1/staff/{staff_id}/lock','POST /api/v1/staff/{staff_id}/unlock']},
  {id:'P2-USR-005', operations:['POST /api/v1/staff/{staff_id}/reset-password']},
  {id:'P2-USR-009', operations:['GET /api/v1/staff/{staff_id}','PATCH /api/v1/staff/{staff_id}']},
];

function evaluate(openapi) {
  if (!openapi || !openapi.paths) throw new Error('OpenAPI paths missing');
  const rows = cases.map(c => {
    const missing = c.operations.filter(op => {
      const [method,path] = op.split(' ');
      const operation = openapi.paths[path]?.[method.toLowerCase()];
      return !operation || !Array.isArray(operation.security) ||
        !operation.security.some(s => Object.hasOwn(s,'HTTPBearer'));
    });
    return {test_ref:c.id, contract:missing.length?'BLOCKED_MISSING_AUTHENTICATED_OPERATION':'CONTRACT_PRESENT',
      missing_or_unsecured_operations:missing, business_execution:'NOT_EXECUTED'};
  });
  return {cases:rows, counts:{assessed:rows.length, contract_present:rows.filter(r=>r.contract==='CONTRACT_PRESENT').length,
    blocked:rows.filter(r=>r.contract!=='CONTRACT_PRESENT').length, business_pass:0}};
}

async function getJson(base,path) {
  const response = await fetch(base+path,{signal:AbortSignal.timeout(25000),headers:{Accept:'application/json'}});
  if (response.status!==200) throw new Error(`${path} HTTP ${response.status}`);
  return response.json();
}

const output = process.argv[2];
if (!output) {console.error('Usage: node scripts/p2_usr_contract_readiness.mjs OUTPUT.json'); process.exit(1);}
try {
  const base = (process.env.BASE_URL||'http://160.191.47.17').replace(/\/+$/,'');
  if (base!=='http://160.191.47.17') throw new Error('Approved staging origin only');
  const snapshots = process.env.P2_READONLY_SNAPSHOT_DIR;
  const read = snapshots ? async name => JSON.parse(readFileSync(join(snapshots,name),'utf8')) : null;
  const before = snapshots ? await read('version_before.json') : await getJson(base,'/version');
  if (before.environment!=='staging'||!/^[a-f0-9]{40}$/.test(before.commit)) throw new Error('Invalid staging version');
  const expected = process.env.POS_EXPECTED_COMMIT;
  if (expected && (!/^[a-f0-9]{7,40}$/.test(expected)||!before.commit.startsWith(expected)))
    throw new Error('Staging commit does not match POS_EXPECTED_COMMIT');
  const openapi = snapshots ? await read('openapi.json') : await getJson(base,'/openapi.json');
  const result = evaluate(openapi);
  const after = snapshots ? await read('version_after.json') : await getJson(base,'/version');
  if (after.commit!==before.commit) throw new Error('Staging changed during read-only gate');
  const report = {task:'P2-USR contract readiness',observed_at:new Date().toISOString(),
    staging_commit:before.commit,build_stable:true,
    openapi_paths:Object.keys(openapi.paths).length,
    openapi_operations:Object.values(openapi.paths).reduce((n,p)=>n+Object.keys(p).filter(k=>/^(get|post|patch|put|delete)$/i.test(k)).length,0),
    ...result,scope:'Read-only contract inspection; no credential, staff creation, lock or business case executed.'};
  mkdirSync(dirname(output),{recursive:true});
  writeFileSync(output,JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify({task:report.task,staging_commit:report.staging_commit,
    openapi_paths:report.openapi_paths,openapi_operations:report.openapi_operations,
    counts:report.counts,output},null,2));
  process.exitCode=report.counts.blocked?2:0;
} catch (error) {console.error(`P2-USR readiness failed: ${error.message}`);process.exitCode=1;}
