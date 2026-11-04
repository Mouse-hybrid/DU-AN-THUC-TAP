// P2-USR-009: isolated QA 3 staff, cross-outlet GET/PATCH denial, then lock own fixture.
// No seed staff mutation; no password/token/response-body logging.
import {randomBytes,randomUUID} from 'node:crypto';
import {mkdirSync,writeFileSync} from 'node:fs';
import {dirname} from 'node:path';

const base='http://160.191.47.17';
const output=process.argv[2];
const seedPassword=process.env.P2_QA_SEED_PASSWORD;
if(!output||!seedPassword){console.error('Usage: set P2_QA_SEED_PASSWORD privately; node scripts/p2_usr_009_cross_outlet_isolated.mjs OUTPUT.json');process.exit(1);}
async function request(method,path,token,body,key){
  const headers={Accept:'application/json'};
  if(token)headers.Authorization=`Bearer ${token}`;
  if(body)headers['Content-Type']='application/json';
  if(key)headers['Idempotency-Key']=key;
  const res=await fetch(base+path,{method,headers,body:body?JSON.stringify(body):undefined,
    signal:AbortSignal.timeout(25000)});
  return {status:res.status,data:await res.json().catch(()=>null)};
}
async function login(username){
  const auth=await request('POST','/api/v1/auth/login',null,{username,password:seedPassword});
  if(auth.status!==200||!auth.data?.access_token)throw new Error(`${username} login HTTP ${auth.status}`);
  const token=auth.data.access_token;
  const me=await request('GET','/api/v1/auth/me',token);
  if(me.status!==200||me.data?.username!==username||me.data?.role!=='SUPERVISOR'||!me.data?.outlet_id)
    throw new Error(`${username} role/outlet verification failed`);
  return {token,outlet:me.data.outlet_id};
}
const report={test_ref:'P2-USR-009',checked_at:new Date().toISOString(),result:'INCONCLUSIVE',
  scope:'Isolated QA 3 staff: own GET, QA 2 cross-outlet GET/PATCH, own GET unchanged, QA 3 locks fixture.',
  secrets_recorded:false};
let qa3,staffId,username,cleaned=false,failure=null;
try{
  const before=await request('GET','/version');
  if(before.status!==200||before.data?.environment!=='staging'||
    !/^[a-f0-9]{40}$/.test(before.data?.commit??''))throw new Error('Invalid staging version');
  report.staging_commit=before.data.commit;
  const expected=process.env.POS_EXPECTED_COMMIT;
  if(expected&&(!/^[a-f0-9]{7,40}$/.test(expected)||!before.data.commit.startsWith(expected)))
    throw new Error('Staging SHA mismatch');
  const qa2=await login('qa2_admin');
  qa3=await login('qa3_admin');
  if(qa2.outlet===qa3.outlet)throw new Error('QA 2 and QA 3 have same outlet');
  report.qa2_outlet_id=qa2.outlet;report.qa3_outlet_id=qa3.outlet;
  username=`qa_p2usr009_${Date.now()}_${randomBytes(3).toString('hex')}`;
  const fullName='QA P2USR009 isolated';
  const created=await request('POST','/api/v1/staff',qa3.token,
    {username,password:randomBytes(24).toString('hex'),full_name:fullName,role:'WAITER'},randomUUID());
  staffId=created.data?.id;
  report.fixture_username=username;report.fixture_staff_id=staffId??null;
  if(created.status!==201||!staffId||created.data?.outlet_id!==qa3.outlet)
    throw new Error(`QA 3 fixture create HTTP ${created.status}; CLEANUP REQUIRED if staff exists`);
  const own=await request('GET',`/api/v1/staff/${staffId}`,qa3.token);
  if(own.status!==200||own.data?.id!==staffId)throw new Error('QA 3 cannot verify own fixture');
  const foreign=await request('GET',`/api/v1/staff/${staffId}`,qa2.token);
  const patch=await request('PATCH',`/api/v1/staff/${staffId}`,qa2.token,{full_name:fullName});
  const afterPatch=await request('GET',`/api/v1/staff/${staffId}`,qa3.token);
  report.own_get_http=own.status;report.foreign_get_http=foreign.status;
  report.foreign_patch_http=patch.status;report.own_after_patch_http=afterPatch.status;
  report.unchanged=afterPatch.status===200&&afterPatch.data?.id===staffId&&
    afterPatch.data?.full_name===fullName&&afterPatch.data?.role==='WAITER'&&afterPatch.data?.is_active===true;
  report.no_foreign_data=foreign.data?.id===undefined&&patch.data?.id===undefined;
  report.assertions_passed=foreign.status===404&&patch.status===404&&report.unchanged&&report.no_foreign_data;
}catch(error){failure=error.message;}
finally{
  if(staffId&&qa3){
    try{
      const lock=await request('POST',`/api/v1/staff/${staffId}/lock`,qa3.token);
      const verify=await request('GET',`/api/v1/staff/${staffId}`,qa3.token);
      cleaned=lock.status===200&&verify.status===200&&verify.data?.is_active===false;
      report.cleanup={lock_http:lock.status,verify_http:verify.status,locked:cleaned};
    }catch(error){report.cleanup={locked:false,error:error.message};}
  }
  try{
    const after=await request('GET','/version');
    report.build_stable=after.status===200&&after.data?.commit===report.staging_commit;
  }catch(error){report.build_stable=false;}
  report.result=failure||!report.build_stable||!cleaned?'INCONCLUSIVE':
    report.assertions_passed?'PASSED':'FAILED';
  if(failure)report.runner_error=failure;
  if(username&&!cleaned)report.cleanup_required=`CLEANUP REQUIRED if fixture was created: ${username}; staff_id ${staffId??'unknown'}`;
  mkdirSync(dirname(output),{recursive:true});
  writeFileSync(output,JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify(report,null,2));
  process.exitCode=report.result==='PASSED'?0:report.result==='FAILED'?1:2;
}
