// P2-USR-001: create one owned QA 3 staff, verify login/role/outlet, then lock it.
// No seed staff mutation; credential and JWT values are never written to evidence.
import {randomBytes,randomUUID} from 'node:crypto';
import {mkdirSync,writeFileSync} from 'node:fs';
import {dirname} from 'node:path';

const base='http://160.191.47.17';
const output=process.argv[2],seedPassword=process.env.P2_QA_SEED_PASSWORD;
if(!output||!seedPassword){console.error('Usage: set P2_QA_SEED_PASSWORD privately; node scripts/p2_usr_001_create_staff_isolated.mjs OUTPUT.json');process.exit(1);}
async function request(method,path,token,body,key){
  const headers={Accept:'application/json'};
  if(token)headers.Authorization=`Bearer ${token}`;
  if(body)headers['Content-Type']='application/json';
  if(key)headers['Idempotency-Key']=key;
  const res=await fetch(base+path,{method,headers,body:body?JSON.stringify(body):undefined,
    signal:AbortSignal.timeout(25000)});
  return {status:res.status,data:await res.json().catch(()=>null)};
}
const report={test_ref:'P2-USR-001',checked_at:new Date().toISOString(),result:'INCONCLUSIVE',
  scope:'Create isolated QA 3 WAITER, verify login/role/outlet and credential redaction; lock own fixture.',
  secrets_recorded:false};
let supervisorToken,staffId,username,memberToken,memberPassword,cleaned=false,failure=null;
try{
  const before=await request('GET','/version');
  if(before.status!==200||before.data?.environment!=='staging'||
    !/^[a-f0-9]{40}$/.test(before.data?.commit??''))throw new Error('Invalid staging version');
  report.staging_commit=before.data.commit;
  const expected=process.env.POS_EXPECTED_COMMIT;
  if(expected&&(!/^[a-f0-9]{7,40}$/.test(expected)||!before.data.commit.startsWith(expected)))
    throw new Error('Staging SHA mismatch');
  const admin=await request('POST','/api/v1/auth/login',null,{username:'qa3_admin',password:seedPassword});
  if(admin.status!==200||!admin.data?.access_token)throw new Error(`qa3_admin login HTTP ${admin.status}`);
  supervisorToken=admin.data.access_token;
  const meAdmin=await request('GET','/api/v1/auth/me',supervisorToken);
  if(meAdmin.status!==200||meAdmin.data?.role!=='SUPERVISOR'||
    meAdmin.data?.username!=='qa3_admin'||!meAdmin.data?.outlet_id)
    throw new Error('Supervisor role/outlet verification failed');
  report.qa3_outlet_id=meAdmin.data.outlet_id;
  username=`qa_p2usr001_${Date.now()}_${randomBytes(3).toString('hex')}`;
  memberPassword=randomBytes(24).toString('hex');
  const created=await request('POST','/api/v1/staff',supervisorToken,
    {username,password:memberPassword,full_name:'QA P2USR001 isolated',role:'WAITER'},randomUUID());
  staffId=created.data?.id;
  report.fixture_username=username;report.fixture_staff_id=staffId??null;report.create_http=created.status;
  if(created.status!==201||!staffId||created.data?.outlet_id!==meAdmin.data.outlet_id||created.data?.role!=='WAITER')
    throw new Error(`Isolated fixture create HTTP ${created.status}; check username before rerun`);
  const newLogin=await request('POST','/api/v1/auth/login',null,{username,password:memberPassword});
  memberToken=newLogin.data?.access_token;
  report.new_login_http=newLogin.status;
  if(newLogin.status!==200||!memberToken)throw new Error(`New staff login HTTP ${newLogin.status}`);
  const meNew=await request('GET','/api/v1/auth/me',memberToken);
  report.new_me_http=meNew.status;
  const identityCorrect=meNew.status===200&&meNew.data?.id===staffId&&
    meNew.data?.username===username&&meNew.data?.role==='WAITER'&&
    meNew.data?.outlet_id===meAdmin.data.outlet_id;
  const noSecret=[created.data,newLogin.data,meNew.data].every(body=>{
    const serialized=JSON.stringify(body??{});
    return !serialized.includes(memberPassword)&&!/("password"|"password_hash"|"new_password")\s*:/.test(serialized);
  });
  report.identity_correct=identityCorrect;report.credential_not_exposed=noSecret;
  report.assertions_passed=identityCorrect&&noSecret;
}catch(error){failure=error.message;}
finally{
  if(staffId&&supervisorToken){
    try{
      const lock=await request('POST',`/api/v1/staff/${staffId}/lock`,supervisorToken);
      const verify=await request('GET',`/api/v1/staff/${staffId}`,supervisorToken);
      cleaned=lock.status===200&&verify.status===200&&verify.data?.is_active===false;
      report.cleanup={lock_http:lock.status,verify_http:verify.status,locked:cleaned};
      if(memberToken){
        const stale=await request('GET','/api/v1/auth/me',memberToken);
        report.locked_token_http=stale.status;
      }
    }catch(error){report.cleanup={locked:false,error:error.message};}
  }
  try{
    const after=await request('GET','/version');
    report.build_stable=after.status===200&&after.data?.commit===report.staging_commit;
  }catch{report.build_stable=false;}
  if(memberToken)report.locked_token_revoked=report.locked_token_http===401;
  report.result=failure||!report.build_stable||!cleaned?'INCONCLUSIVE':
    report.assertions_passed&&report.locked_token_revoked===true?'PASSED':'FAILED';
  if(failure)report.runner_error=failure;
  if(username&&!cleaned)report.cleanup_required=`CLEANUP REQUIRED if fixture was created: ${username}; staff_id ${staffId??'unknown'}`;
  mkdirSync(dirname(output),{recursive:true});
  writeFileSync(output,JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify(report,null,2));
  memberPassword=undefined;
  process.exitCode=report.result==='PASSED'?0:report.result==='FAILED'?1:2;
}
