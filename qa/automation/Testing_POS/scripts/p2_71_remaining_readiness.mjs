// Read-only contract gate for the 45 Phase 2 cases outside Sprint 3 QR/Rewards.
// No login, business mutation, testcase status change, or bug creation.
import {readFileSync, writeFileSync, mkdirSync} from 'node:fs';
import {dirname, join, resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

const isSprint3=c=>c.module==='QR Ordering'||c.module==='Rewards System';
const key=(method,path)=>`${method.toUpperCase()} ${path.startsWith('/api/')?path:'/api/v1'+path}`;
const mentionedOperations=text=>[...String(text??'').matchAll(/\b(GET|POST|PATCH|PUT|DELETE)\s+(\/[\w{}\/-]+)/g)]
  .map(m=>key(m[1],m[2]));
const exists=(paths,operation)=>{
  const [method,path]=operation.split(' ');
  const canonical=p=>p.replace(/\{[^/{}]+\}/g,'{}');
  // The 71-case design uses /tables/merge; deployed Pha 2 names the source
  // table in the path. Match this confirmed alias without rewriting the baseline.
  const mergeAlias=method==='POST'&&path==='/api/v1/tables/merge'
    ? '/api/v1/tables/{}/merge' : null;
  return Object.entries(paths).some(([live,verbs])=>
    (canonical(live)===canonical(path)||canonical(live)===mergeAlias)&&
    !!verbs[method.toLowerCase()]);
};

export function assessRemaining(manifest,inventory,openapi){
  if(manifest.schema_version!==1||!Array.isArray(manifest.cases)||manifest.cases.length!==71||
     new Set(manifest.cases.map(c=>c.id)).size!==71)throw new Error('Expected 71 unique Phase 2 case IDs');
  if(!/^[a-f0-9]{40}$/i.test(inventory.commit??'')||!openapi?.paths)throw new Error('Invalid build or OpenAPI');
  const paths=openapi.paths;
  const rows=manifest.cases.filter(c=>!isSprint3(c)).map(c=>{
    const operations=mentionedOperations(c.planned_operation);
    const missing=operations.filter(op=>!exists(paths,op));
    let readiness='REVIEW_REQUIRED',reason='Contract, policy, fixture and cleanup require QA review';
    if(missing.length){readiness='BLOCKED_MISSING_OPERATION';reason='Proposed operation absent from live OpenAPI';}
    else if(c.id==='P2-AUD-005'||c.id==='P2-USR-008'){
      readiness='BLOCKED_SCOPE_DEPENDENCY';reason='Full audit/permission scope requires Phase 2 write actions';
    }else if(c.id==='P2-MON-001'||c.id==='P2-MON-002'||c.id==='P2-MON-004'){
      readiness='BLOCKED_EXTERNAL_ACCESS';reason='Monitoring/log access and policy fixture unavailable from OpenAPI';
    }else if(c.id==='P2-MON-003'||c.id==='P2-MON-005'){
      readiness='BLOCKED_SCOPE_DEPENDENCY';reason='Payment gateway or role-change contract unavailable';
    }else if(c.id==='P2-ORD-001'||c.id==='P2-ORD-002'){
      if(!JSON.stringify(openapi).includes('"expected_version"')){
        readiness='BLOCKED_MISSING_VERSION_CONTRACT';reason='Order write expected_version is not documented';
      }
    }else if(c.id==='P2-ORD-003'){
      if(!JSON.stringify(openapi).includes('"pin"')){
        readiness='BLOCKED_MISSING_PIN_CONTRACT';reason='Supervisor PIN input is not documented';
      }
    }else if(c.id==='P2-AUD-001'||c.id==='P2-AUD-002'||c.id==='P2-AUD-003'){
      const params=paths['/api/v1/audit-logs']?.get?.parameters?.map(p=>p.name)??[];
      const required=c.id==='P2-AUD-002'?['order_id','limit','offset']:['order_id','action','created_from','created_to'];
      if(required.every(p=>params.includes(p))){
        readiness='CONTRACT_PRESENT';reason='Read-only audit contract exists; use separate owned QA order execution evidence';
      }else{
        readiness='BLOCKED_MISSING_OPERATION';reason='Audit filter/pagination parameters incomplete';
      }
    }else if(operations.length&&missing.length===0){
      readiness='CONTRACT_PRESENT';reason='Named operation exists; fixture and business assertions not evaluated';
    }
    return {id:c.id,module:c.module,priority:c.priority,planned_operation:c.planned_operation,
      named_operations:operations,missing_operations:missing,readiness,reason,
      business_execution:'NOT_EXECUTED_IN_THIS_RUN'};
  });
  if(rows.length!==45)throw new Error('Expected 45 non-Sprint-3 cases');
  const counts={baseline_cases:71,assessed_cases:45,excluded_sprint3_cases:26,
    contract_present:rows.filter(r=>r.readiness==='CONTRACT_PRESENT').length,
    review_required:rows.filter(r=>r.readiness==='REVIEW_REQUIRED').length,
    blocked:rows.filter(r=>r.readiness.startsWith('BLOCKED')).length,business_pass:0};
  return {task:'Phase 2 remaining 45-case contract readiness',type:'READ_ONLY_GATE',
    staging_commit:inventory.commit,source_filename:manifest.source_filename,
    counts,cases:rows,conclusion:'Contract readiness only; preserve testcase Status and prior run history.'};
}

function getJson(base,path){
  const url=new URL(path,base);
  if(!['http:','https:'].includes(url.protocol)||url.username||url.password)throw new Error('Invalid base URL');
  return fetch(url,{signal:AbortSignal.timeout(25000),headers:{Accept:'application/json'}}).then(async r=>{
    if(r.status!==200)throw new Error(`${path} HTTP ${r.status}`);
    return r.json();
  });
}

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  const [manifestFile,inventoryFile,outputFile]=process.argv.slice(2);
  if(!manifestFile||!inventoryFile||!outputFile){console.error('Usage: node p2_71_remaining_readiness.mjs MANIFEST.json DES_QA_07.json OUTPUT.json');process.exit(1);}
  try{
    const manifest=JSON.parse(readFileSync(manifestFile,'utf8'));
    const inventory=JSON.parse(readFileSync(inventoryFile,'utf8'));
    const base=process.env.BASE_URL??'http://160.191.47.17';
    const snapshots=process.env.P2_READONLY_SNAPSHOT_DIR;
    const snapshot=name=>JSON.parse(readFileSync(join(snapshots,name),'utf8'));
    const before=snapshots?snapshot('version_before.json'):await getJson(base,'/version');
    if(before.environment!=='staging'||before.commit!==inventory.commit||
       (process.env.POS_EXPECTED_COMMIT&&!before.commit.startsWith(process.env.POS_EXPECTED_COMMIT)))
      throw new Error('Staging SHA does not match DES-QA-07 inventory');
    const openapi=snapshots?snapshot('openapi.json'):await getJson(base,'/openapi.json');
    const result=assessRemaining(manifest,inventory,openapi);
    const after=snapshots?snapshot('version_after.json'):await getJson(base,'/version');
    if(after.commit!==before.commit)throw new Error('Staging SHA changed during read-only gate');
    result.checked_at=new Date().toISOString();
    result.build_stable=true;
    result.capture_mode=snapshots?'THREE_SEQUENTIAL_READ_ONLY_GET_SNAPSHOTS':'LIVE_GET';
    result.openapi_paths=Object.keys(openapi.paths).length;
    result.openapi_operations=Object.values(openapi.paths).reduce((n,p)=>n+Object.keys(p).filter(k=>/^(get|post|patch|put|delete)$/i.test(k)).length,0);
    mkdirSync(dirname(outputFile),{recursive:true});
    writeFileSync(outputFile,JSON.stringify(result,null,2)+'\n');
    console.log(JSON.stringify({task:result.task,staging_commit:result.staging_commit,counts:result.counts,
      openapi_paths:result.openapi_paths,openapi_operations:result.openapi_operations,output:outputFile,
      conclusion:result.conclusion},null,2));
    process.exitCode=result.counts.blocked?2:0;
  }catch(e){console.error(`P2 remaining contract gate could not complete: ${e.message}`);process.exitCode=1;}
}
