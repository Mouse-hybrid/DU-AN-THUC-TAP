import {randomBytes,randomUUID} from 'node:crypto';
import {mkdirSync,writeFileSync} from 'node:fs';
import {dirname} from 'node:path';

// P2-USR-001: four isolated QA3 roles, exact audit and lock cleanup.
const base='http://160.191.47.17',output=process.argv[2];
const seed=process.env.P2_QA_SEED_PASSWORD,expected=process.env.POS_EXPECTED_COMMIT;
if(!output||!seed||!/^[a-f0-9]{40}$/.test(expected||'')){
  console.error('PENDING_FIXTURE: OUTPUT, private QA3 password and full POS_EXPECTED_COMMIT required; no request sent');
  process.exit(2);
}
const roles=['WAITER','CASHIER','KITCHEN','SUPERVISOR'],owned=[];
const report={run_id:'RUN-'+new Date().toISOString().replace(/\D/g,'')+'-P2USR001ROLES',
  test_ref:'P2-USR-001',checked_at:new Date().toISOString(),result:'INCONCLUSIVE',
  scope:'QA3 Supervisor creates isolated WAITER/CASHIER/KITCHEN/SUPERVISOR staff; verify role, outlet, live permission, audit, secret redaction and lock cleanup. UI not tested.',
  secrets_recorded:false,roles:[],cleanup:[]};
let adminToken,adminId,before,after,error;
async function call(method,path,token,body){
  const headers={Accept:'application/json'};
  if(token)headers.Authorization='Bearer '+token;
  if(body!==undefined)headers['Content-Type']='application/json';
  if(method!=='GET'&&path!=='/api/v1/auth/login')headers['Idempotency-Key']=randomUUID();
  const r=await fetch(base+path,{method,headers,
    body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(25_000)});
  return {http:r.status,data:await r.json().catch(()=>null)};
}
function must(r,status,label){if(r.http!==status)throw Error(label+': HTTP '+r.http+', expected '+status);return r.data;}
async function get(path,token){return must(await call('GET',path,token),200,'GET '+path);}
async function sha(){return (await get('/version')).commit;}
function safe(e){
  let message=String(e?.message||e);
  for(const value of [seed,adminToken,...owned.flatMap(x=>[x.password,x.token])])
    if(value)message=message.replaceAll(value,'<REDACTED>');
  return message;
}
async function audit(id,action){
  const query=new URLSearchParams({entity_id:id,action,limit:'100'});
  const rows=await get('/api/v1/audit-logs?'+query,adminToken);
  if(!Array.isArray(rows))throw Error('Audit response is not an array');
  return rows.filter(row=>row.entity_id===id&&row.action===action);
}
try{
  before=await sha();report.staging_commit=before;
  if(before!==expected)throw Error('PENDING_BUILD: staging SHA differs from pinned build');
  const spec=await get('/openapi.json');
  for(const [path,method] of [['/api/v1/staff','post'],['/api/v1/staff/{staff_id}/lock','post'],
    ['/api/v1/audit-logs','get']])
    if(!spec.paths?.[path]?.[method])throw Error('PENDING_CONTRACT: '+method+' '+path);
  const login=must(await call('POST','/api/v1/auth/login',null,
    {username:'qa3_admin',password:seed}),200,'QA3 admin login');
  adminToken=login.access_token;
  if(!adminToken)throw Error('QA3 admin token missing');
  const me=await get('/api/v1/auth/me',adminToken);
  if(me.username!=='qa3_admin'||me.role!=='SUPERVISOR'||!me.outlet_id||!me.id)
    throw Error('QA3 Supervisor identity mismatch');
  adminId=me.id;report.outlet_id=me.outlet_id;
  const matrix=await get('/api/v1/staff/permissions',adminToken);
  const manage=matrix.find(x=>x.permission==='STAFF_MANAGE');
  if(!Array.isArray(manage?.roles))throw Error('STAFF_MANAGE matrix unavailable');
  for(const role of roles){
    if(await sha()!==before)throw Error('PENDING_BUILD: staging changed before create');
    const fixture={role,username:'qa_p2usr001_'+role.toLowerCase()+'_'+Date.now()+'_'+
      randomBytes(3).toString('hex'),password:randomBytes(24).toString('hex'),id:null,token:null};
    owned.push(fixture);
    const created=await call('POST','/api/v1/staff',adminToken,
      {username:fixture.username,password:fixture.password,full_name:'QA P2USR001 '+role,role});
    fixture.id=created.data?.id||null;
    const staff=must(created,201,'create '+role);
    if(!fixture.id||staff.role!==role||staff.outlet_id!==me.outlet_id||
      staff.username!==fixture.username||staff.is_active!==true)throw Error(role+' creation mismatch');
    const own=await get('/api/v1/staff/'+fixture.id,adminToken);
    const auth=must(await call('POST','/api/v1/auth/login',null,
      {username:fixture.username,password:fixture.password}),200,role+' login');
    fixture.token=auth.access_token;
    if(!fixture.token)throw Error(role+' token missing');
    const identity=await get('/api/v1/auth/me',fixture.token);
    const manager=await call('GET','/api/v1/staff/permissions',fixture.token);
    const expectedManager=manage.roles.includes(role)?200:403;
    const createdAudit=await audit(fixture.id,'STAFF_CREATED');
    const secretAbsent=[staff,own,identity,...createdAudit].every(value=>{
      const text=JSON.stringify(value);
      return !text.includes(fixture.password)&&!/"(?:password|password_hash|access_token)"\s*:/.test(text);
    });
    const passed=own.id===fixture.id&&identity.id===fixture.id&&
      identity.username===fixture.username&&identity.role===role&&
      identity.outlet_id===me.outlet_id&&manager.http===expectedManager&&
      createdAudit.length===1&&createdAudit[0].staff_id===adminId&&secretAbsent;
    report.roles.push({role,fixture_staff_id:fixture.id,create_http:201,login_http:200,
      me_http:200,manager_http:manager.http,expected_manager_http:expectedManager,
      staff_created_audit_count:createdAudit.length,secrets_absent:secretAbsent,passed});
    if(!passed)throw Error(role+' role/outlet/permission/audit assertion failed');
  }
}catch(e){error=safe(e);}
finally{
  if(adminToken)for(const fixture of [...owned].reverse()){
    try{
      if(!fixture.id){
        const list=await get('/api/v1/staff',adminToken);
        const matches=list.filter(x=>x.username===fixture.username);
        if(matches.length===1)fixture.id=matches[0].id;
        if(matches.length>1)throw Error('Ambiguous owned staff username');
      }
      if(!fixture.id){report.cleanup.push({role:fixture.role,found:false,passed:false});continue;}
      const locked=must(await call('POST','/api/v1/staff/'+fixture.id+'/lock',adminToken),200,'lock '+fixture.role);
      const verify=await get('/api/v1/staff/'+fixture.id,adminToken);
      const stale=fixture.token?await call('GET','/api/v1/auth/me',fixture.token):null;
      const lockedAudit=await audit(fixture.id,'STAFF_LOCKED');
      const passed=locked.is_active===false&&verify.is_active===false&&
        (!stale||stale.http===401)&&lockedAudit.length===1;
      report.cleanup.push({role:fixture.role,fixture_staff_id:fixture.id,lock_http:200,
        locked:verify.is_active===false,stale_token_http:stale?.http??null,
        staff_locked_audit_count:lockedAudit.length,passed});
    }catch(e){report.cleanup.push({role:fixture.role,fixture_staff_id:fixture.id,
      passed:false,error:safe(e)});}
  }
  try{after=await sha();}catch{}
  report.build_after=after||null;report.build_stable=!!before&&before===after;
  report.business_execution=owned.some(x=>x.id)?'EXECUTED':'NOT_EXECUTED';
  report.assertions_passed=report.roles.length===roles.length&&report.roles.every(x=>x.passed);
  report.cleanup_pass=owned.length===roles.length&&report.cleanup.length===roles.length&&
    report.cleanup.every(x=>x.passed);
  if(error)report.error=error;
  if(owned.some(x=>!report.cleanup.some(c=>c.fixture_staff_id===x.id&&c.passed)))
    report.cleanup_required='Inspect only owned qa_p2usr001_ usernames; no global reset.';
  report.result=report.assertions_passed&&report.cleanup_pass&&report.build_stable?'PASSED':
    /^PENDING_/.test(error||'')&&owned.length===0?'PENDING':
      report.cleanup_required?'INCONCLUSIVE':'FAILED';
  mkdirSync(dirname(output),{recursive:true});
  writeFileSync(output,JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify(report,null,2));
  process.exitCode=report.result==='PASSED'?0:report.result==='FAILED'?1:2;
}

