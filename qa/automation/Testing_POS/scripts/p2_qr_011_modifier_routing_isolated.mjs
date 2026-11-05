// P2-QR-011: QR modifier persists into the correct Kitchen station.
// Own QA3 session, revoke QR, serve items, pay simulated, close and clean.
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const base = (process.env.POS_STAGING_URL || 'http://160.191.47.17').replace(/\/+$/, '');
const password = process.env.P2_QA_SEED_PASSWORD;
const expected = process.env.POS_EXPECTED_COMMIT;
const output = process.argv[2];
if (base !== 'http://160.191.47.17') throw new Error('Approved staging origin only');
if (!output) { console.error('Usage: node scripts/p2_qr_011_modifier_routing_isolated.mjs OUTPUT.json'); process.exit(2); }
if (!expected) { console.error('PENDING_BUILD: POS_EXPECTED_COMMIT missing; no request sent'); process.exit(2); }
if (!password) { console.error('PENDING_FIXTURE: P2_QA_SEED_PASSWORD missing; no request sent'); process.exit(2); }
const roles = {};
const owned = { tableId: null, tableCode: null, sessionId: null, orderId: null, itemId: null, qrItemId: null, qrIssued: false, starterMenuId: null, qrToken: null };
const log = [];
function redact(value) {
  let safe = String(value).replaceAll(password, '<REDACTED>');
  for (const jwt of Object.values(roles)) safe = safe.replaceAll(jwt, '<REDACTED>');
  return safe.replace(/\/api\/v1\/public\/qr\/[^\s/'"]+/g, '/api/v1/public/qr/<REDACTED>');
}
function call(method, path, role, body, key) {
  const args = ['--max-time', '30', '--silent', '--show-error', '--write-out', '\n%{http_code}', '-X', method];
  if (role) args.push('-H', `Authorization: Bearer ${roles[role]}`);
  if (body !== undefined) args.push('-H', 'Content-Type: application/json', '--data-binary', '@-');
  if (method !== 'GET' && method !== 'HEAD') args.push('-H', `Idempotency-Key: ${key || randomUUID()}`);
  args.push(`${base}${path}`);
  const command = process.platform === 'win32' ? 'curl.exe' : 'curl';
  const raw = execFileSync(command, args, {
    encoding: 'utf8', input: body === undefined ? undefined : JSON.stringify(body), maxBuffer: 3_000_000,
  });
  const split = raw.lastIndexOf('\n');
  const http = Number(raw.slice(split + 1));
  const text = raw.slice(0, split);
  let data;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { http, data };
}
function must(r, expectedHttp, label) {
  if (r.http !== expectedHttp) throw new Error(`${label} HTTP ${r.http}, expected ${expectedHttp}`);
  return r.data;
}
function version() { return must(call('GET', '/version'), 200, 'version').commit; }
function order() { return must(call('GET', `/api/v1/orders/${owned.orderId}`, 'cashier'), 200, 'own order'); }
function table() { return must(call('GET', `/api/v1/tables/${owned.tableId}`, 'waiter'), 200, 'own table'); }
function post(path, role, body, key) { return call('POST', path, role, body, key); }
function queue(status) {
  const rows = must(call('GET', `/api/v1/kitchen/queue?status=${status}`, 'kitchen'), 200, 'Kitchen Queue');
  if (!Array.isArray(rows)) throw new Error('Kitchen Queue is not an array');
  return rows.filter(x => x.order_id === owned.orderId);
}
function finish() {
  if (!owned.sessionId) return false;
  let t = table();
  if (t.id !== owned.tableId || (t.current_session?.id && t.current_session.id !== owned.sessionId))
    throw new Error('CLEANUP REQUIRED: table/session changed');
  if (owned.qrIssued && t.current_session?.id === owned.sessionId) {
    must(call('DELETE', `/api/v1/tables/${owned.tableId}/qr-session`, 'waiter'), 204, 'revoke own QR');
    owned.qrIssued = false;
  }
  if (!owned.orderId) {
    const rows = (t.orders || []).filter(x => x.table_session_id === owned.sessionId);
    if (rows.length === 1) owned.orderId = rows[0].id;
    else if (rows.length === 0 && t.current_session?.id === owned.sessionId)
      owned.orderId = must(post('/api/v1/orders', 'waiter', {table_session_id: owned.sessionId}), 201, 'cleanup create').id;
  }
  if (!owned.orderId) throw new Error(`CLEANUP REQUIRED: ${owned.tableCode} session ${owned.sessionId} has no owned order`);
  let o = order();
  if (o.table_session_id !== owned.sessionId) throw new Error('CLEANUP REQUIRED: order session changed');
  if (o.status === 'NEW') {
    if (!o.items.length) {
      if (!owned.starterMenuId) throw new Error('CLEANUP REQUIRED: starter item unavailable');
      must(post(`/api/v1/orders/${owned.orderId}/items`, 'waiter',
        {items: [{menu_item_id: owned.starterMenuId, quantity: 1, note: 'QA P2QR011 cleanup'}]}), 201, 'cleanup add');
    }
    must(post(`/api/v1/orders/${owned.orderId}/send-to-kitchen`, 'waiter'), 200, 'cleanup send');
  }
  o = order();
  for (const item of o.items) {
    for (const [from, action, role] of [['SENT','start-cooking','kitchen'],
      ['PREPARING','mark-ready','kitchen'],['READY','pickup','waiter'],['PICKED_UP','served','waiter']]) {
      const current = order().items.find(x => x.id === item.id);
      if (current?.status === from)
        must(post(`/api/v1/orders/${owned.orderId}/items/${item.id}/${action}`, role), 200, `cleanup ${action}`);
    }
    if (order().items.find(x => x.id === item.id)?.status !== 'SERVED')
      throw new Error(`CLEANUP REQUIRED: own item ${item.id} not SERVED`);
  }
  o = order();
  if (!['BILLING','PAID','CLOSED'].includes(o.status))
    must(post(`/api/v1/orders/${owned.orderId}/request-billing`, 'waiter'), 200, 'cleanup billing');
  if (!['PAID','CLOSED'].includes(order().status))
    must(post(`/api/v1/orders/${owned.orderId}/pay`, 'cashier'), 200, 'cleanup simulated payment');
  if (order().status !== 'CLOSED')
    must(post(`/api/v1/orders/${owned.orderId}/close`, 'cashier'), 200, 'cleanup close');
  t = table();
  if (t.status === 'CLEANING') must(post(`/api/v1/tables/${owned.tableId}/mark-clean`, 'waiter'), 200, 'cleanup table');
  const done = queue('DONE'), active = must(call('GET','/api/v1/kitchen/queue','kitchen'),200,'active queue');
  const final = order(), end = table();
  if (final.status !== 'CLOSED' || end.status !== 'AVAILABLE' || end.current_session ||
    final.items.some(x => x.status !== 'SERVED') || done.length !== final.items.length ||
    active.some(x => x.order_id === owned.orderId)) throw new Error('CLEANUP REQUIRED: final state mismatch');
  return true;
}

const report = {run_id: 'RUN-'+new Date().toISOString().replace(/\D/g,'')+'-P2QR011',
  test_ref:'P2-QR-011', checked_at:new Date().toISOString(), scope:
  'QA3 QR modifier selection, Waiter send, Kitchen station/ticket; customer UI not tested',
  token_recorded:false,secrets_recorded:false,result:'INCONCLUSIVE'};
let buildBefore, buildAfter, asserted = false, cleanupPass = false, failure, executed = false;
try {
  buildBefore = version(); report.staging_commit=buildBefore;
  if (!buildBefore.startsWith(expected)) throw new Error(`PENDING_BUILD: unexpected staging ${buildBefore}`);
  const spec = must(call('GET','/openapi.json'),200,'OpenAPI');
  for (const p of ['/api/v1/public/qr/{token}/orders','/api/v1/tables/{table_id}/qr-session'])
    if (!spec.paths?.[p]) throw new Error(`PENDING_CONTRACT: missing ${p}`);
  for (const [name,role] of [['qa3_waiter','WAITER'],['qa3_cashier','CASHIER'],['qa3_kitchen','KITCHEN']]) {
    const login = must(post('/api/v1/auth/login',null,{username:name,password}),200,`${name} login`);
    if (login.staff?.role !== role || !login.access_token) throw new Error('QA3 role mismatch');
    roles[name.slice(4)] = login.access_token;
  }
  const tables = must(call('GET','/api/v1/tables','waiter'),200,'tables');
  const candidates = tables.filter(t => /^Q3-[12]$/.test(t.code) && t.status === 'AVAILABLE');
  const menu = must(call('GET','/api/v1/menu?available_only=true','cashier'),200,'staff menu');
  const starter = menu.find(x=>x.is_available&&x.station_id&&!x.has_modifiers);
  const modifierItems = menu.filter(x=>x.is_available&&x.station_id&&x.has_modifiers);
  if (!candidates.length || !starter || !modifierItems.length) throw new Error('PENDING_FIXTURE: available Q3 table, starter and modifier item required');
  owned.starterMenuId=starter.id;
  let target,chosen=[];
  for(const candidate of modifierItems){
    const groups=must(call('GET',`/api/v1/menu/${candidate.id}/modifiers?active_only=true`,'cashier'),200,'modifier groups');
    const selected=[];
    let valid=true;
    for(const group of groups){
      const available=(group.options||[]).filter(x=>x.is_available);
      if(available.length<group.min_select){valid=false;break;}
      selected.push(...available.slice(0,group.min_select).map(x=>({...x,group_name:group.name})));
    }
    if(!valid)continue;
    if(!selected.length){
      const optional=groups.find(g=>g.max_select>0&&(g.options||[]).some(x=>x.is_available));
      if(optional){
        const option=optional.options.find(x=>x.is_available);
        selected.push({...option,group_name:optional.name});
      }
    }
    if(selected.length){target=candidate;chosen=selected;break;}
  }
  if (!target) throw new Error('PENDING_FIXTURE: no active available modifier to verify');
  for (const candidate of candidates) {
    const opened=post(`/api/v1/tables/${candidate.id}/open-session`,'waiter',{guest_count:1});
    if(opened.http===409)continue;
    owned.tableId=candidate.id;owned.tableCode=candidate.code;
    owned.sessionId=must(opened,201,'open own QA3 table').id;break;
  }
  if(!owned.sessionId)throw new Error('PENDING_FIXTURE: all Q3 tables occupied');
  owned.orderId=must(post('/api/v1/orders','cashier',{table_session_id:owned.sessionId}),201,'create order').id;
  if(!owned.orderId)throw new Error('CLEANUP REQUIRED: order id missing');
  const added=must(post(`/api/v1/orders/${owned.orderId}/items`,'cashier',
    {items:[{menu_item_id:starter.id,quantity:1,note:'QA P2QR011 starter'}]}),201,'add starter');
  owned.itemId=added.items?.find(x=>x.menu_item_id===starter.id)?.id;
  if(!owned.itemId)throw new Error('CLEANUP REQUIRED: starter item missing');
  const issued=must(post(`/api/v1/tables/${owned.tableId}/qr-session`,'waiter'),201,'issue QR');
  owned.qrIssued=true;owned.qrToken=issued.token;
  if(issued.table_session_id!==owned.sessionId||!owned.qrToken)throw new Error('QR session mismatch');
  const qrMenu=must(call('GET',`/api/v1/public/qr/${owned.qrToken}/menu`),200,'public menu');
  const qrTarget=qrMenu.items?.find(x=>x.id===target.id);
  if(!qrTarget||chosen.some(x=>!qrTarget.modifier_groups?.some(g=>g.options?.some(o=>o.id===x.id))))
    throw new Error('QR menu missing chosen modifier');
  executed=true;
  const submitted=must(post(`/api/v1/public/qr/${owned.qrToken}/orders`,null,
    {items:[{menu_item_id:target.id,quantity:1,modifier_option_ids:chosen.map(x=>x.id)}]}),201,'QR submit');
  const qrLine=submitted.items?.find(x=>x.source==='QR'&&x.menu_item_name===target.name);
  const shared=order();
  owned.qrItemId=shared.items?.find(x=>x.source==='QR'&&x.menu_item_id===target.id)?.id;
  if(!qrLine||!owned.qrItemId||shared.table_session_id!==owned.sessionId||shared.items.length!==2)
    throw new Error('QR line not attached to own POS order/session');
  must(post(`/api/v1/orders/${owned.orderId}/send-to-kitchen`,'waiter'),200,'Waiter send');
  const sent=order().items.find(x=>x.id===owned.qrItemId);
  const ticket=queue('QUEUED').find(x=>x.order_item_id===owned.qrItemId);
  const modifierNames=chosen.map(x=>`${x.group_name}/${x.name}/${Number(x.price_delta)}`).sort();
  const itemModifiers=sent?.modifiers||[],ticketModifiers=ticket?.modifiers||[];
  const names=rows=>rows.map(x=>`${x.group_name}/${x.option_name}/${Number(x.price_delta)}`).sort();
  report.checks={
    waiter_sent:sent?.status==='SENT',
    correct_station:ticket?.station_id===target.station_id,
    one_ticket:queue('QUEUED').filter(x=>x.order_item_id===owned.qrItemId).length===1,
    pos_modifiers:JSON.stringify(names(itemModifiers))===JSON.stringify(modifierNames),
    kds_modifiers:JSON.stringify(names(ticketModifiers))===JSON.stringify(modifierNames),
    source_qr:sent?.source==='QR'&&qrLine.source==='QR',
  };
  report.table_code=owned.tableCode;report.order_id=owned.orderId;report.qr_item_id=owned.qrItemId;
  report.station_id=ticket?.station_id;report.expected_station_id=target.station_id;
  report.modifier_option_ids=chosen.map(x=>x.id);
  asserted=Object.values(report.checks).every(Boolean);
  if(!asserted)throw new Error('Modifier/station assertion failed');
} catch(e) { failure=redact(e.message||e); }
finally {
  if(owned.sessionId)try{cleanupPass=finish();}catch(e){failure=`${failure||'Runner error'}; ${redact(e.message||e)}`;}
  try{buildAfter=version();}catch{}
  report.build_after=buildAfter||null;report.build_stable=buildBefore===buildAfter;
  report.business_execution=executed?'EXECUTED':'NOT_EXECUTED';report.cleanup_pass=cleanupPass;
  report.order_closed=cleanupPass;report.table_available=cleanupPass;
  report.result=asserted&&cleanupPass&&report.build_stable?'PASSED':
    /^PENDING_/.test(failure||'')?'PENDING':executed?'FAILED':'INCONCLUSIVE';
  if(failure)report.error=failure;
  if(!cleanupPass&&owned.sessionId)report.cleanup_required=`Inspect own ${owned.tableCode} session ${owned.sessionId}, order ${owned.orderId}; no global reset`;
  mkdirSync(dirname(output),{recursive:true});writeFileSync(output,JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify(report,null,2));process.exitCode=report.result==='PASSED'?0:report.result==='FAILED'?1:2;
}
