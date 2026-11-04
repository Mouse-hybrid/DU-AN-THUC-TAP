// P2-USR-003: own QA 3 account changes WAITER -> CASHIER; old token revoked.
// Always lock newly created staff; never alter seed accounts or record credentials.
import {randomBytes,randomUUID} from 'node:crypto';
import {mkdirSync,writeFileSync} from 'node:fs';
import {dirname} from 'node:path';
const base='http://160.191.47.17',output=process.argv[2],seed=process.env.P2_QA_SEED_PASSWORD;
if(!output||!seed){console.error('Usage: set P2_QA_SEED_PASSWORD privately; node scripts/p2_usr_003_role_change_isolated.mjs OUTPUT.json');process.exit(1);}
async function req(method,path,token,body,key){
  const headers={Accept:'application/json'};
  if(token)headers.Authorization=`Bearer ${token}`;
  if(body)headers['Content-Type']='application/json';
  if(key)headers['Idempotency-Key']=key;
  const r=await fetch(base+path,{method,headers,body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(25000)});
  return {status:r.status,data:await r.json().catch(()=>null)};
}
const report={test_ref:'P2-USR-003',checked_at:new Date().toISOString(),result:'INCONCLUSIVE',
  scope:'Create QA 3 WAITER, change role to CASHIER, reject old token, verify new permissions, lock fixture.',secrets_recorded:false};
let adminToken,staffId,username,password,oldToken,newToken,cleaned=false,failure=null;
try{
  const version=await req('GET','/version');
  if(version.status!==200||version.data?.environment!=='staging'||!/^[a-f0-9]{40}$/.test(version.data?.commit??''))throw new Error('Invalid staging version');
  report.staging_commit=version.data.commit;
  const expected=process.env.POS_EXPECTED_COMMIT;
  if(expected&&(!/^[a-f0-9]{7,40}$/.test(expected)||!version.data.commit.startsWith(expected)))throw new Error('SHA mismatch');
  const admin=await req('POST','/api/v1/auth/login',null,{username:'qa3_admin',password:seed});
  adminToken=admin.data?.access_token;
  if(admin.status!==200||!adminToken)throw new Error(`qa3_admin login HTTP ${admin.status}`);
  const adminMe=await req('GET','/api/v1/auth/me',adminToken);
  if(adminMe.status!==200||adminMe.data?.username!=='qa3_admin'||adminMe.data?.role!=='SUPERVISOR'||!adminMe.data?.outlet_id)
    throw new Error('Supervisor identity verification failed');
  report.outlet_id=adminMe.data.outlet_id;
  username=`qa_p2usr003_${Date.now()}_${randomBytes(3).toString('hex')}`;
  password=randomBytes(24).toString('hex');
  const created=await req('POST','/api/v1/staff',adminToken,{username,password,full_name:'QA P2USR003 isolated',role:'WAITER'},randomUUID());
  staffId=created.data?.id;report.fixture_username=username;report.fixture_staff_id=staffId??null;report.create_http=created.status;
  if(created.status!==201||!staffId||created.data?.outlet_id!==adminMe.data.outlet_id)throw new Error('Fixture creation failed');
  const loginBefore=await req('POST','/api/v1/auth/login',null,{username,password});
  oldToken=loginBefore.data?.access_token;
  if(loginBefore.status!==200||!oldToken)throw new Error('New staff initial login failed');
  const before=await req('GET','/api/v1/auth/me',oldToken);
  report.before_role=before.data?.role;
  if(before.status!==200||before.data?.role!=='WAITER'||before.data?.id!==staffId||
    before.data?.permissions?.includes('PROCESS_PAYMENT'))throw new Error('Initial WAITER permissions unexpected');
  const changed=await req('PATCH',`/api/v1/staff/${staffId}`,adminToken,{role:'CASHIER'});
  report.patch_http=changed.status;
  if(changed.status!==200||changed.data?.role!=='CASHIER')throw new Error('Supervisor role change failed');
  const oldMe=await req('GET','/api/v1/auth/me',oldToken);
  report.old_token_http=oldMe.status;
  const loginAfter=await req('POST','/api/v1/auth/login',null,{username,password});
  newToken=loginAfter.data?.access_token;
  if(loginAfter.status!==200||!newToken)throw new Error('Fresh login after role change failed');
  const fresh=await req('GET','/api/v1/auth/me',newToken);
  report.fresh_me_http=fresh.status;report.fresh_role=fresh.data?.role;
  report.fresh_has_payment_permission=fresh.data?.permissions?.includes('PROCESS_PAYMENT')===true;
  report.assertions_passed=oldMe.status===401&&fresh.status===200&&fresh.data?.id===staffId&&
    fresh.data?.outlet_id===adminMe.data.outlet_id&&fresh.data?.role==='CASHIER'&&report.fresh_has_payment_permission;
}catch(error){failure=error.message;}
finally{
  if(staffId&&adminToken){
    try{
      const lock=await req('POST',`/api/v1/staff/${staffId}/lock`,adminToken);
      const verify=await req('GET',`/api/v1/staff/${staffId}`,adminToken);
      cleaned=lock.status===200&&verify.status===200&&verify.data?.is_active===false;
      report.cleanup={lock_http:lock.status,verify_http:verify.status,locked:cleaned};
      if(newToken)report.locked_token_http=(await req('GET','/api/v1/auth/me',newToken)).status;
    }catch(error){report.cleanup={locked:false,error:error.message};}
  }
  try{report.build_stable=(await req('GET','/version')).data?.commit===report.staging_commit;}catch{report.build_stable=false;}
  report.result=failure||!report.build_stable||!cleaned?'INCONCLUSIVE':
    report.assertions_passed&&report.locked_token_http===401?'PASSED':'FAILED';
  if(failure)report.runner_error=failure;
  if(username&&!cleaned)report.cleanup_required=`CLEANUP REQUIRED if created: ${username}; staff_id ${staffId??'unknown'}`;
  mkdirSync(dirname(output),{recursive:true});writeFileSync(output,JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify(report,null,2));password=undefined;
  process.exitCode=report.result==='PASSED'?0:report.result==='FAILED'?1:2;
}
