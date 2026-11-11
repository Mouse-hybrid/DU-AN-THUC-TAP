// Phase 1 TC_API_21_001: authenticated Kitchen Stations contract on staging.
// Login and GET only; no order/table/station mutation.
import {mkdirSync, writeFileSync} from 'node:fs';
import {dirname} from 'node:path';

const base=(process.env.POS_STAGING_URL||'http://160.191.47.17').replace(/\/+$/,'');
const password=process.env.P2_QA_SEED_PASSWORD;
const expected=process.env.POS_EXPECTED_COMMIT;
const output=process.argv[2];
if(base!=='http://160.191.47.17')throw Error('Approved staging origin only');
if(!output||!password||!/^[0-9a-f]{40}$/.test(expected||'')){
  console.error('PENDING_INPUT: output path, QA seed password and full staging SHA required; no request sent');
  process.exit(2);
}
const report={
  run_id:`RUN-${new Date().toISOString().replace(/\D/g,'')}-TCAPI21001`,
  test_ref:'TC_API_21_001',checked_at:new Date().toISOString(),
  scope:'QA3 KITCHEN GET /api/v1/kitchen/stations response and station fields; no business mutation.',
  result:'INCONCLUSIVE',environment:'staging',secrets_recorded:false,mutations:0,
};
let token,buildBefore,buildAfter,checksPassed=false,failure;
async function call(method,path,body){
  const headers={Accept:'application/json'};
  if(token)headers.Authorization=`Bearer ${token}`;
  if(body!==undefined)headers['Content-Type']='application/json';
  const response=await fetch(base+path,{method,headers,
    body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(20000)});
  return {http:response.status,data:await response.json().catch(()=>null)};
}
function must(r,http,label){
  if(r.http!==http)throw Error(`${label} HTTP ${r.http}, expected ${http}`);
  return r.data;
}
async function version(){return must(await call('GET','/version'),200,'version');}
try{
  const before=await version();
  buildBefore=before.commit;report.build_before=buildBefore;
  if(before.environment!=='staging'||buildBefore!==expected)
    throw Error('PENDING_BUILD: staging SHA/environment mismatch');
  const spec=must(await call('GET','/openapi.json'),200,'OpenAPI');
  if(!spec?.paths?.['/api/v1/kitchen/stations']?.get)
    throw Error('PENDING_CONTRACT: Kitchen Stations GET missing');
  const login=must(await call('POST','/api/v1/auth/login',
    {username:'qa3_kitchen',password}),200,'QA3 Kitchen login');
  token=login?.access_token;
  if(!token)throw Error('QA3 Kitchen token missing');
  const me=must(await call('GET','/api/v1/auth/me'),200,'QA3 Kitchen identity');
  if(me.username!=='qa3_kitchen'||me.role!=='KITCHEN'||!me.outlet_id)
    throw Error('PENDING_FIXTURE: QA3 Kitchen role/outlet mismatch');
  const stationsReply=await call('GET','/api/v1/kitchen/stations');
  report.http={stations:stationsReply.http};
  const stations=must(stationsReply,200,'Kitchen Stations');
  if(!Array.isArray(stations))throw Error('Stations response is not an array');
  const uuid=/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
  const ids=new Set(stations.map(s=>s?.id));
  report.checks={
    array_nonempty:stations.length>0,
    unique_valid_ids:ids.size===stations.length&&stations.every(s=>uuid.test(s?.id||'')),
    names_nonempty:stations.every(s=>typeof s?.name==='string'&&s.name.trim().length>0),
    active_flags_boolean:stations.every(s=>typeof s?.is_active==='boolean'),
    active_station_exists:stations.some(s=>s?.is_active===true),
    outlet_scoped:stations.every(s=>!s?.outlet_id||s.outlet_id===me.outlet_id),
  };
  report.station_count=stations.length;
  report.active_station_count=stations.filter(s=>s?.is_active===true).length;
  checksPassed=Object.values(report.checks).every(Boolean);
  if(!checksPassed)throw Error('Kitchen Stations response violates current contract/QA3 outlet');
}catch(error){
  failure=String(error?.message||error).replaceAll(password,'<REDACTED>');
  if(token)failure=failure.replaceAll(token,'<REDACTED>');
}finally{
  try{buildAfter=(await version()).commit;}catch{}
  report.build_after=buildAfter||null;
  report.build_stable=!!buildBefore&&buildBefore===buildAfter;
  report.result=checksPassed&&report.build_stable?'PASSED':
    failure?.startsWith('PENDING_')?'PENDING':'FAILED';
  if(failure)report.error=failure;
  mkdirSync(dirname(output),{recursive:true});
  writeFileSync(output,JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify(report,null,2));
  process.exitCode=report.result==='PASSED'?0:report.result==='FAILED'?1:2;
}
