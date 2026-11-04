// PF-P2-USR-002: read-only role gate. Does not cover write denial or audit policy.
import {writeFileSync,mkdirSync} from 'node:fs';
import {dirname} from 'node:path';

const base='http://160.191.47.17';
const output=process.argv[2];
if (!output) {console.error('Usage: node scripts/p2_usr_002_readonly_rbac.mjs OUTPUT.json');process.exit(1);}
const secret=process.env.P2_QA_SEED_PASSWORD;
if (!secret) {console.error('P2_QA_SEED_PASSWORD must be set in the current process environment');process.exit(1);}
const users=[['qa3_admin','SUPERVISOR'],['qa3_cashier','CASHIER'],['qa3_waiter','WAITER'],['qa3_kitchen','KITCHEN']];
async function call(method,path,token,body) {
  const headers={Accept:'application/json'};
  if (token) headers.Authorization=`Bearer ${token}`;
  if (body) headers['Content-Type']='application/json';
  const res=await fetch(base+path,{method,headers,body:body?JSON.stringify(body):undefined,
    signal:AbortSignal.timeout(25000)});
  const data=await res.json().catch(()=>null);
  return {status:res.status,data};
}
try {
  const before=await call('GET','/version');
  if (before.status!==200||before.data?.environment!=='staging'||
    !/^[a-f0-9]{40}$/.test(before.data?.commit??'')) throw new Error('Invalid staging version');
  const expected=process.env.POS_EXPECTED_COMMIT;
  if (expected&&(!/^[a-f0-9]{7,40}$/.test(expected)||!before.data.commit.startsWith(expected)))
    throw new Error('Staging SHA mismatch');
  const anonymous=await call('GET','/api/v1/staff');
  const rows=[];
  let outlet;
  for(const [username,role] of users) {
    const login=await call('POST','/api/v1/auth/login',null,{username,password:secret});
    if(login.status!==200||!login.data?.access_token)throw new Error(`${username}: login failed (HTTP ${login.status})`);
    const token=login.data.access_token;
    const me=await call('GET','/api/v1/auth/me',token);
    const currentOutlet=me.data?.outlet_id??me.data?.staff?.outlet_id;
    const currentRole=me.data?.role??me.data?.staff?.role;
    if(me.status!==200||currentRole!==role||!currentOutlet)throw new Error(`${username}: /auth/me role/outlet mismatch`);
    if(outlet&&outlet!==currentOutlet)throw new Error('QA 3 accounts belong to different outlets');
    outlet=currentOutlet;
    const staff=await call('GET','/api/v1/staff',token);
    const matrix=await call('GET','/api/v1/staff/permissions',token);
    rows.push({username,role,me_http:me.status,staff_http:staff.status,matrix_http:matrix.status,
      staff_rows:role==='SUPERVISOR'&&Array.isArray(staff.data)?staff.data.length:null});
  }
  const after=await call('GET','/version');
  const stable=after.status===200&&after.data?.commit===before.data.commit;
  const passed=stable&&anonymous.status===401&&rows.every(r=>
    r.staff_http===(r.role==='SUPERVISOR'?200:403)&&
    r.matrix_http===(r.role==='SUPERVISOR'?200:403));
  const report={test_ref:'PF-P2-USR-002',checked_at:new Date().toISOString(),
    staging_commit:before.data.commit,build_stable:stable,anonymous_staff_http:anonymous.status,
    roles:rows,result:passed?'PASSED':'FAILED',business_case:'P2-USR-002 NOT_EXECUTED',
    scope:'GET-only RBAC for staff list and permission matrix; POST/PATCH denial, attempted-write audit and UI not tested.',
    secrets_recorded:false};
  mkdirSync(dirname(output),{recursive:true});
  writeFileSync(output,JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify(report,null,2));
  process.exitCode=passed?0:1;
}catch(error){console.error(`PF-P2-USR-002 cannot complete: ${error.message}`);process.exitCode=1;}
