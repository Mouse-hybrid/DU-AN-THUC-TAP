// P2-AUD-004: compare a staging audit CSV export to the matching audit GET rows.
// Read-only except for login; no audit payload or credential is saved to evidence.
import {mkdirSync, writeFileSync} from 'node:fs';
import {dirname} from 'node:path';

const base='http://160.191.47.17';
const [,,orderId,output]=process.argv;
const password=process.env.P2_QA_SEED_PASSWORD;
const expected=process.env.POS_EXPECTED_COMMIT;
if(!/^[0-9a-f-]{36}$/i.test(orderId||'')||!output||!password||!/^[a-f0-9]{40}$/.test(expected||'')){
  console.error('PENDING_INPUT: provide CLOSED QA3 order UUID, output JSON, P2_QA_SEED_PASSWORD and full POS_EXPECTED_COMMIT; no request sent');
  process.exit(2);
}
const report={run_id:`RUN-${new Date().toISOString().replace(/[-:.TZ]/g,'')}-P2AUD004`,
  test_ref:'P2-AUD-004',checked_at:new Date().toISOString(),order_id:orderId,
  scope:'Read-only CSV audit export versus filtered GET for one CLOSED QA3 order, with QA2 outlet isolation.',
  result:'INCONCLUSIVE',secrets_recorded:false,mutations:0};
let buildBefore,buildAfter,passed=false,reason;
function csvRows(input){
  const rows=[];let row=[],cell='',quoted=false;
  for(let i=0;i<input.length;i++){
    const ch=input[i];
    if(quoted){
      if(ch==='"'&&input[i+1]==='"'){cell+='"';i++;}
      else if(ch==='"')quoted=false;
      else cell+=ch;
    }else if(ch==='"'){quoted=true;}
    else if(ch===','){row.push(cell);cell='';}
    else if(ch==='\n'){row.push(cell.replace(/\r$/,''));rows.push(row);row=[];cell='';}
    else cell+=ch;
  }
  if(quoted)throw Error('CSV contains an unclosed quoted field');
  if(row.length||cell){row.push(cell);rows.push(row);}
  if(!rows.length)throw Error('CSV is empty');
  const head=rows.shift().map((x,i)=>i===0?x.replace(/^\uFEFF/,'').trim():x.trim());
  if(new Set(head).size!==head.length)throw Error('CSV has duplicate header columns');
  return {head,rows:rows.filter(x=>x.some(Boolean)).map(c=>{
    if(c.length!==head.length)throw Error('CSV row/column count mismatch');
    return Object.fromEntries(head.map((h,i)=>[h,c[i]]));
  })};
}
async function request(method,path,token,body){
  const headers={Accept:'application/json'};
  if(token)headers.Authorization=`Bearer ${token}`;
  if(body!==undefined)headers['Content-Type']='application/json';
  const response=await fetch(base+path,{method,headers,body:body===undefined?undefined:JSON.stringify(body),
    signal:AbortSignal.timeout(30000)});
  const raw=await response.text();
  let data;try{data=JSON.parse(raw);}catch{data=null;}
  return {http:response.status,data,raw,headers:response.headers};
}
async function must(method,path,code,token,body){
  const r=await request(method,path,token,body);
  if(r.http!==code)throw Error(`${path.split('?')[0]} HTTP ${r.http}, expected ${code}`);
  return r;
}
async function identity(username,role){
  const auth=await must('POST','/api/v1/auth/login',200,null,{username,password});
  const token=auth.data?.access_token;
  if(!token)throw Error(`${role} token missing`);
  const me=await must('GET','/api/v1/auth/me',200,token);
  if(me.data?.username!==username||me.data?.role!=='SUPERVISOR'||!me.data?.outlet_id)
    throw Error(`${role} identity mismatch`);
  return {token,outlet:me.data.outlet_id};
}
function auditParams(params){
  return new URLSearchParams(params).toString();
}
try{
  const version=await must('GET','/version',200);
  buildBefore=version.data?.commit;report.build_before=buildBefore;
  if(version.data?.environment!=='staging'||buildBefore!==expected)throw Error('PENDING_BUILD: staging SHA mismatch');
  const spec=(await must('GET','/openapi.json',200)).data;
  const op=spec?.paths?.['/api/v1/audit-logs/export']?.get;
  if(!op||!spec?.paths?.['/api/v1/audit-logs']?.get)throw Error('PENDING_CONTRACT: audit GET/export absent');
  const qa3=await identity('qa3_admin','QA3 supervisor');
  const qa2=await identity('qa2_admin','QA2 supervisor');
  if(qa3.outlet===qa2.outlet)throw Error('PENDING_FIXTURE: QA2 and QA3 outlets are identical');
  const order=await must('GET',`/api/v1/orders/${orderId}`,200,qa3.token);
  if(order.data?.id!==orderId||order.data?.status!=='CLOSED')
    throw Error('PENDING_FIXTURE: supply a CLOSED QA3-owned order');
  const all=await must('GET',`/api/v1/audit-logs?${auditParams({order_id:orderId,limit:'500',offset:'0'})}`,200,qa3.token);
  if(!Array.isArray(all.data)||!all.data.length||all.data.length>=500)
    throw Error('PENDING_FIXTURE: expected a bounded non-empty audit list for this order');
  const first=all.data[0],last=all.data.at(-1);
  if(!first.action||!first.created_at||!last.created_at)throw Error('Audit action/time unavailable');
  const from=new Date(new Date(first.created_at).getTime()-1000).toISOString();
  const to=new Date(new Date(last.created_at).getTime()+1000).toISOString();
  const filter={order_id:orderId,action:first.action,created_from:from,created_to:to};
  const query=auditParams(filter);
  const listed=await must('GET',`/api/v1/audit-logs?${query}&limit=500&offset=0`,200,qa3.token);
  if(!Array.isArray(listed.data)||!listed.data.length||listed.data.length>=500)
    throw Error('PENDING_FIXTURE: filtered audit list empty or truncated');
  const exported=await must('GET',`/api/v1/audit-logs/export?${query}`,200,qa3.token);
  const media=exported.headers.get('content-type')||'';
  const disposition=exported.headers.get('content-disposition')||'';
  if(!/csv/i.test(media)||!/attachment/i.test(disposition))
    throw Error('PENDING_CONTRACT: export is not a downloadable CSV');
  const csv=csvRows(exported.raw);
  report.export_shape={
    content_type:media,
    columns:csv.head.map(name=>name.length<=80&&!/[0-9]{8,}/.test(name)?name:'<REDACTED>'),
    row_count:csv.rows.length,
    matching_get_rows:listed.data.length,
  };
  const cols=['id','action','entity_id','staff_id','staff_role','created_at'];
  if(!cols.every(x=>csv.head.includes(x)))
    throw Error('PENDING_MAPPING: exported CSV columns differ from runner field names; compare export_shape.columns');
  if(csv.rows.length!==listed.data.length)throw Error('Export row count differs from filtered GET');
  const byId=new Map(listed.data.map(x=>[x.id,x]));
  if(byId.size!==listed.data.length)throw Error('Duplicate audit IDs in GET result');
  for(const row of csv.rows){
    const found=byId.get(row.id);
    if(!found)throw Error('Export includes a row outside the filtered GET result');
    for(const field of ['action','entity_id','staff_id','staff_role'])
      if(String(found[field]??'')!==row[field])throw Error(`Export field ${field} differs from GET`);
    if(!Number.isFinite(Date.parse(row.created_at))||
       Date.parse(row.created_at)!==Date.parse(found.created_at))
      throw Error('Export actor timestamp differs from GET');
    if(!row.staff_id||!row.staff_role||!row.entity_id)throw Error('Export row missing actor/entity');
  }
  const leaked=[password,qa3.token,qa2.token].some(s=>s&&exported.raw.includes(s))||
    /eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\./.test(exported.raw);
  if(leaked)throw Error('Export contains a secret');
  const foreign=await request('GET',`/api/v1/audit-logs/export?${query}`,qa2.token);
  if(![200,403,404].includes(foreign.http))
    throw Error(`Other outlet export HTTP ${foreign.http} is unexpected`);
  if(foreign.raw.includes(orderId)||csv.rows.some(x=>foreign.raw.includes(x.id)))
    throw Error('Other outlet export exposed QA3 order/audit row');
  report.checks={get_rows:listed.data.length,export_rows:csv.rows.length,action:first.action,
    actor_time_entity_match:true,download_csv:true,secret_absent:true,
    foreign_outlet_http:foreign.http,foreign_outlet_isolated:true};
  passed=true;
}catch(e){reason=String(e?.message||e).replaceAll(password,'<REDACTED>');}
finally{
  try{buildAfter=(await must('GET','/version',200)).data?.commit;}catch{}
  report.build_after=buildAfter;report.build_stable=!!buildBefore&&buildBefore===buildAfter;
  report.result=passed&&report.build_stable?'PASSED':reason?.startsWith('PENDING_')?'PENDING':'FAILED';
  if(reason)report.error=reason;
  mkdirSync(dirname(output),{recursive:true});
  writeFileSync(output,JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify(report,null,2));
  process.exitCode=report.result==='PASSED'?0:report.result==='FAILED'?1:2;
}
