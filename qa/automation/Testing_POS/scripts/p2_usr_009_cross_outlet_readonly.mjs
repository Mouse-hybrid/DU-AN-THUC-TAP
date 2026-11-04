// PF-P2-USR-009: read-only staff isolation between QA 2 and QA 3.
// Never log passwords, tokens, staff response bodies, or attempt PATCH.
import {mkdirSync,writeFileSync} from 'node:fs';
import {dirname} from 'node:path';

const base='http://160.191.47.17';
const output=process.argv[2];
const password=process.env.P2_QA_SEED_PASSWORD;
if(!output||!password){console.error('Usage: P2_QA_SEED_PASSWORD=<private> node scripts/p2_usr_009_cross_outlet_readonly.mjs OUTPUT.json');process.exit(1);}
async function request(method,path,token,body){
  const headers={Accept:'application/json'};
  if(token)headers.Authorization=`Bearer ${token}`;
  if(body)headers['Content-Type']='application/json';
  const response=await fetch(base+path,{method,headers,body:body?JSON.stringify(body):undefined,
    signal:AbortSignal.timeout(25000)});
  return {status:response.status,data:await response.json().catch(()=>null)};
}
async function login(username){
  const res=await request('POST','/api/v1/auth/login',null,{username,password});
  if(res.status!==200||!res.data?.access_token)throw new Error(`${username} login HTTP ${res.status}`);
  const token=res.data.access_token;
  const me=await request('GET','/api/v1/auth/me',token);
  if(me.status!==200||me.data?.username!==username||me.data?.role!=='SUPERVISOR'||!me.data?.outlet_id)
    throw new Error(`${username} role/outlet verification failed`);
  return {token,outlet_id:me.data.outlet_id};
}
try{
  const before=await request('GET','/version');
  if(before.status!==200||before.data?.environment!=='staging'||
    !/^[a-f0-9]{40}$/.test(before.data?.commit??''))throw new Error('Invalid staging version');
  const expected=process.env.POS_EXPECTED_COMMIT;
  if(expected&&(!/^[a-f0-9]{7,40}$/.test(expected)||!before.data.commit.startsWith(expected)))
    throw new Error('Staging commit does not match POS_EXPECTED_COMMIT');

  const a=await login('qa2_admin');
  const b=await login('qa3_admin');
  if(a.outlet_id===b.outlet_id)throw new Error('QA 2 and QA 3 must have distinct outlets');
  const targetList=await request('GET','/api/v1/staff',b.token);
  if(targetList.status!==200||!Array.isArray(targetList.data))throw new Error('QA 3 staff list unavailable');
  const target=targetList.data.find(s=>s.username==='qa3_waiter'&&
    s.outlet_id===b.outlet_id&&/^[a-f0-9-]{36}$/i.test(s.id??''));
  if(!target)throw new Error('QA 3 waiter seed staff not found in QA 3 list');
  const own=await request('GET',`/api/v1/staff/${target.id}`,b.token);
  if(own.status!==200||own.data?.id!==target.id)throw new Error('QA 3 cannot verify ownership of seed staff');
  const foreign=await request('GET',`/api/v1/staff/${target.id}`,a.token);
  const listA=await request('GET','/api/v1/staff',a.token);
  const after=await request('GET','/version');
  const stable=after.status===200&&after.data?.commit===before.data.commit;
  const noLeak=foreign.data?.id===undefined&&
    listA.status===200&&Array.isArray(listA.data)&&!listA.data.some(s=>s.id===target.id);
  const passed=stable&&foreign.status===404&&noLeak;
  const report={test_ref:'PF-P2-USR-009',checked_at:new Date().toISOString(),
    staging_commit:before.data.commit,build_stable:stable,qa2_outlet_id:a.outlet_id,
    qa3_outlet_id:b.outlet_id,target_staff_id:target.id,qa3_own_get_http:own.status,
    qa2_foreign_get_http:foreign.status,qa2_list_http:listA.status,foreign_staff_not_leaked:noLeak,
    result:passed?'PASSED':'FAILED',business_case:'P2-USR-009 NOT_EXECUTED',
    scope:'Read-only cross-outlet GET and list isolation. PATCH denial/audit and UI not tested.',
    secrets_recorded:false};
  mkdirSync(dirname(output),{recursive:true});
  writeFileSync(output,JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify(report,null,2));
  process.exitCode=passed?0:1;
}catch(error){console.error(`PF-P2-USR-009 could not complete: ${error.message}`);process.exitCode=1;}
