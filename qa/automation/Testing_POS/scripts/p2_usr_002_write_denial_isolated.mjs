// PF-P2-USR-002-WRITE: three lower roles cannot list or create staff.
// If an unexpected create succeeds, QA 3 Supervisor locks that isolated account.
import {randomBytes,randomUUID} from 'node:crypto';
import {mkdirSync,writeFileSync} from 'node:fs';
import {dirname} from 'node:path';

const base='http://160.191.47.17';
const output=process.argv[2],seedPassword=process.env.P2_QA_SEED_PASSWORD;
if(!output||!seedPassword){console.error('Usage: set P2_QA_SEED_PASSWORD privately; node scripts/p2_usr_002_write_denial_isolated.mjs OUTPUT.json');process.exit(1);}
async function request(method,path,token,body,key){
  const headers={Accept:'application/json'};
  if(token)headers.Authorization=`Bearer ${token}`;
  if(body)headers['Content-Type']='application/json';
  if(key)headers['Idempotency-Key']=key;
  const res=await fetch(base+path,{method,headers,body:body?JSON.stringify(body):undefined,
    signal:AbortSignal.timeout(25000)});
  return {status:res.status,data:await res.json().catch(()=>null)};
}
async function login(username,role){
  const auth=await request('POST','/api/v1/auth/login',null,{username,password:seedPassword});
  if(auth.status!==200||!auth.data?.access_token)throw new Error(`${username}: login HTTP ${auth.status}`);
  const token=auth.data.access_token;
  const me=await request('GET','/api/v1/auth/me',token);
  if(me.status!==200||me.data?.username!==username||me.data?.role!==role||!me.data?.outlet_id)
    throw new Error(`${username}: role/outlet verification failed`);
  return {token,outlet:me.data.outlet_id};
}
const report={test_ref:'PF-P2-USR-002-WRITE',checked_at:new Date().toISOString(),
  result:'INCONCLUSIVE',scope:'QA 3 lower-role GET/POST /staff denied; no new staff. Attempted-write audit policy not asserted.',
  business_case:'P2-USR-002 NOT_EXECUTED until attempted-write audit policy is confirmed',secrets_recorded:false};
let admin,users=[],failure=null,cleanupRequired=[];
try{
  const before=await request('GET','/version');
  if(before.status!==200||before.data?.environment!=='staging'||
    !/^[a-f0-9]{40}$/.test(before.data?.commit??''))throw new Error('Invalid staging version');
  report.staging_commit=before.data.commit;
  const expected=process.env.POS_EXPECTED_COMMIT;
  if(expected&&(!/^[a-f0-9]{7,40}$/.test(expected)||!before.data.commit.startsWith(expected)))
    throw new Error('Staging SHA mismatch');
  admin=await login('qa3_admin','SUPERVISOR');
  for(const [username,role] of [['qa3_cashier','CASHIER'],['qa3_waiter','WAITER'],['qa3_kitchen','KITCHEN']]){
    const user=await login(username,role);
    if(user.outlet!==admin.outlet)throw new Error(`${username}: not in QA 3 outlet`);
    const candidate=`qa_p2usr002_${role.toLowerCase()}_${Date.now()}_${randomBytes(3).toString('hex')}`;
    users.push({username,role,candidate});
    const list=await request('GET','/api/v1/staff',user.token);
    const matrix=await request('GET','/api/v1/staff/permissions',user.token);
    const created=await request('POST','/api/v1/staff',user.token,
      {username:candidate,password:randomBytes(24).toString('hex'),full_name:'QA P2USR002 denied',role:'WAITER'},randomUUID());
    users[users.length-1].http={list:list.status,matrix:matrix.status,create:created.status};
  }
}catch(error){failure=error.message;}
finally{
  let present=[];
  if(admin&&users.length){
    try{
      const all=await request('GET','/api/v1/staff',admin.token);
      if(all.status!==200||!Array.isArray(all.data))throw new Error('Supervisor cannot verify staff list after attempted writes');
      present=all.data.filter(s=>users.some(u=>u.candidate===s.username));
      for(const staff of present){
        try{
          const lock=await request('POST',`/api/v1/staff/${staff.id}/lock`,admin.token,undefined,randomUUID());
          const verify=await request('GET',`/api/v1/staff/${staff.id}`,admin.token);
          if(lock.status!==200||verify.status!==200||verify.data?.is_active!==false)
            cleanupRequired.push({username:staff.username,id:staff.id});
        }catch{cleanupRequired.push({username:staff.username,id:staff.id});}
      }
    }catch(error){failure=failure??error.message;cleanupRequired=users.map(u=>({username:u.candidate,id:'unknown'}));}
  }
  report.roles=users.map(u=>({username:u.username,role:u.role,attempted_username:u.candidate,...u.http}));
  report.unexpected_created_count=present.length;
  report.cleanup_required=cleanupRequired;
  try{
    const after=await request('GET','/version');
    report.build_stable=after.status===200&&after.data?.commit===report.staging_commit;
  }catch{report.build_stable=false;}
  const allDenied=users.length===3&&users.every(u=>u.http?.list===403&&u.http?.matrix===403&&u.http?.create===403);
  report.result=failure||!report.build_stable||cleanupRequired.length?'INCONCLUSIVE':
    allDenied&&present.length===0?'PASSED':'FAILED';
  if(failure)report.runner_error=failure;
  mkdirSync(dirname(output),{recursive:true});
  writeFileSync(output,JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify(report,null,2));
  process.exitCode=report.result==='PASSED'?0:report.result==='FAILED'?1:2;
}
