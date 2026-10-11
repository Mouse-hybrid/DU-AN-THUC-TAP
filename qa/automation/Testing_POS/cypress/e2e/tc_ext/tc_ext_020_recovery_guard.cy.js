// TC_EXT_020 recovery guard - opt-in, explicitly scoped to a QA table/session/order.
// No new orders or table sessions are ever created by this spec.
// Only handles PAID->CLOSED->CLEANING->AVAILABLE, or CLOSED/CLEANING->AVAILABLE.
// This is a RECOVERY tool, not a passing TC_EXT_020 full E2E test.
describe('TC_EXT_020 | recovery guard for interrupted QA lifecycle',()=>{
 const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
 it('recovers explicitly specified paid QA order and returns table to AVAILABLE',function(){
  cy.env(['POS_BASE_URL','EXT_020_RECOVERY_APPROVED','EXT_020_RECOVERY_TABLE_ID',
   'EXT_020_RECOVERY_SESSION_ID','EXT_020_RECOVERY_ORDER_ID',
   'EXT_020_CASHIER_TOKEN','EXT_020_WAITER_TOKEN']).then(e=>{
   const base=String(e.POS_BASE_URL||'http://160.191.47.17').replace(/\/$/,'');
   if(base!=='http://160.191.47.17')throw new Error('SAFETY: QA staging only');
   const ids=['EXT_020_RECOVERY_TABLE_ID','EXT_020_RECOVERY_SESSION_ID','EXT_020_RECOVERY_ORDER_ID'];
   if(String(e.EXT_020_RECOVERY_APPROVED)!=='true'||
     ids.some(k=>!uuid.test(String(e[k]||'')))||
     !e.EXT_020_CASHIER_TOKEN||!e.EXT_020_WAITER_TOKEN){
    cy.log('PENDING: need approved QA recovery, exact table/session/order and role tokens');
    this.skip();return;
   }
   const t=e.EXT_020_RECOVERY_TABLE_ID,s=e.EXT_020_RECOVERY_SESSION_ID,o=e.EXT_020_RECOVERY_ORDER_ID;
   const cashier={Authorization:'Bearer '+e.EXT_020_CASHIER_TOKEN};
   const waiter={Authorization:'Bearer '+e.EXT_020_WAITER_TOKEN};
   const key=()=> 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g,c=>{
    const n=Math.floor(Math.random()*16);return(c==='x'?n:(n&3)|8).toString(16)});
   const call=(method,path,h)=>cy.request({method,url:base+'/api/v1'+path,
    headers:method==='POST'?{...h,'Idempotency-Key':key()}:h,
    failOnStatusCode:false,log:false});
   const save=(stage,status,extra={})=>cy.writeFile('evidence/TC_EXT_020/recovery-last.json',{
    table:t,session:s,order:o,stage,status,updatedAt:new Date().toISOString(),...extra});
   call('GET','/tables/'+t,cashier).then(tab=>{
    expect(tab.status,'GET table').eq(200);
    expect(tab.body.id,'exact QA table').eq(t);
    if(tab.body.status==='AVAILABLE'&&tab.body.current_session==null){
     return call('GET','/orders/'+o,cashier).then(ord=>{
      expect(ord.status,'GET QA order').eq(200);
      expect((ord.body.order||ord.body).table_session_id).eq(s);
      expect((ord.body.order||ord.body).status).eq('CLOSED');
      return save('ALREADY_AVAILABLE',200,{cleanup:'VERIFIED_AVAILABLE'});
     });
    }
    const session=tab.body.current_session;
    if(session?.id!==s)throw new Error('SAFETY: active session changed; no mutation');
    return call('GET','/orders/'+o,cashier).then(ord=>{
     expect(ord.status,'GET order').eq(200);
     const body=ord.body.order||ord.body;
     expect(body.table_session_id,'exact QA session').eq(s);
     expect(body.table_id||t,'same table').eq(t);
     const matches=(tab.body.orders||[]).some(x=>x.id===o);
     expect(matches,'specified order listed for table').eq(true);
     expect((tab.body.orders||[]).length,'no other active orders').eq(1);
     if(!['PAID','CLOSED'].includes(body.status))throw new Error(
      'SAFETY: order must be PAID or CLOSED; actual '+body.status);
     if(body.status==='CLOSED')return cy.wrap(null,{log:false});
     return save('BEFORE_CLOSE','PAID').then(()=>
      call('POST','/orders/'+o+'/close',cashier).then(res=>{
       expect(res.status,'close order HTTP').eq(200);
       expect((res.body.order||res.body).status,'closed status').eq('CLOSED');
       return save('CLOSED',res.status);
      }));
    }).then(()=>call('GET','/tables/'+t,cashier)).then(tab2=>{
     expect(tab2.status).eq(200);
     if(tab2.body.status==='AVAILABLE'){
      expect(tab2.body.current_session).to.be.null;
      return save('AVAILABLE',200,{cleanup:'VERIFIED_AVAILABLE'});
     }
     if(tab2.body.status!=='CLEANING')throw new Error(
      'SAFETY: expected CLEANING after close, got '+tab2.body.status);
     return save('BEFORE_MARK_CLEAN',200).then(()=>call('POST','/tables/'+t+'/mark-clean',waiter)
      .then(clean=>{
       expect(clean.status,'mark clean HTTP').eq(200);
       return call('GET','/tables/'+t,cashier).then(final=>{
        expect(final.status).eq(200);
        expect(final.body.status,'table returned AVAILABLE').eq('AVAILABLE');
        expect(final.body.current_session).to.be.null;
        return save('COMPLETE',200,{cleanup:'VERIFIED_AVAILABLE'});
       });
      }));
    });
   });
  });
 });
});
