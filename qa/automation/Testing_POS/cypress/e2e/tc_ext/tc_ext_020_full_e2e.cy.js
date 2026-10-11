/**
 * TC_EXT_020: POS end-to-end staging workflow (API-backed Cypress).
 * MUTATES STAGING. Explicit QA fixture, role tokens and simulated-payment approval required.
 * Only run on the approved QA/staging host. Does not exercise a real payment gateway.
 * Never mark TC_EXT_020 Passed unless all business assertions and cleanup pass.
 */
describe('TC_EXT_020 | isolated POS full lifecycle', () => {
  const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  const key=()=> 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g,c=>{
    const n=Math.floor(Math.random()*16);return(c==='x'?n:(n&3)|8).toString(16);
  });
  const list=b=>Array.isArray(b)?b:
    ['items','data','results'].map(k=>b?.[k]).find(Array.isArray)||[];
  const order=b=>b?.order||b;
  let env={}, base='', admin={}, cashier={}, waiter={};
  let ctx={};
  const api=(method,path,headers,body)=>cy.request({
    method,url:base+'/api/v1'+path,headers,body,failOnStatusCode:false,log:false
  });
  const write=(stage,status,details='')=>{
    ctx.stage=stage;
    ctx.audit.push({stage,status,details,time:new Date().toISOString()});
    return cy.writeFile('evidence/TC_EXT_020/last-run.json',{
      test:'TC_EXT_020',fixtureTable:ctx.tableId||null,createdOrder:ctx.orderId||null,
      session:ctx.sessionId||null,stage:ctx.stage,cleanup:ctx.cleanup,
      audit:ctx.audit
    });
  };
  const request=(method,path,headers,body,stage,expected)=>{
    const h=method==='GET'?headers:{...headers,'Idempotency-Key':key()};
    return api(method,path,h,body).then(r=>{
      // Return the Cypress command chain, not a synchronous response after cy.writeFile.
      return write(stage,r.status).then(()=>{
        expect(r.status,stage+' HTTP').eq(expected);
        return r;
      });
    });
  };
  const login=(username,password)=>api('POST','/auth/login',{}, {username,password}).then(r=>{
    expect(r.status,'role login').eq(200);
    const token=r.body?.access_token||r.body?.data?.access_token;
    expect(token,'JWT').to.be.a('string').and.not.be.empty;
    return {Authorization:'Bearer '+token};
  });
  const role=(token,username,password)=>token
    ? cy.wrap({Authorization:'Bearer '+token},{log:false})
    : login(username,password);

  beforeEach(function(){
    ctx={stage:'NOT_STARTED',cleanup:'NOT_NEEDED',audit:[],tableId:null,sessionId:null,orderId:null,itemId:null};
    cy.env(['POS_BASE_URL','POS_USERNAME','POS_PASSWORD',
      'EXT_020_RUN_MUTATIONS','EXT_020_ALLOW_SIMULATED_PAYMENT',
      'EXT_020_TABLE_ID','EXT_020_MENU_ITEM_ID','EXT_020_CASHIER_TOKEN',
      'EXT_020_WAITER_TOKEN','EXT_020_CASHIER_USERNAME','EXT_020_CASHIER_PASSWORD',
      'EXT_020_WAITER_USERNAME','EXT_020_WAITER_PASSWORD']).then(e=>{
      env=e;
      base=String(e.POS_BASE_URL||'http://160.191.47.17').replace(/\/$/,'');
      const allowed=String(e.EXT_020_RUN_MUTATIONS)==='true'&&
        String(e.EXT_020_ALLOW_SIMULATED_PAYMENT)==='true';
      const validRoles=(e.EXT_020_CASHIER_TOKEN||(e.EXT_020_CASHIER_USERNAME&&e.EXT_020_CASHIER_PASSWORD))&&
        (e.EXT_020_WAITER_TOKEN||(e.EXT_020_WAITER_USERNAME&&e.EXT_020_WAITER_PASSWORD));
      if(!allowed||!e.POS_USERNAME||!e.POS_PASSWORD||!validRoles||
        !uuid.test(String(e.EXT_020_TABLE_ID||''))||!uuid.test(String(e.EXT_020_MENU_ITEM_ID||''))){
        cy.log('PENDING: explicit staging mutation approval, UUID fixtures and three role credentials required');
        this.skip();return;
      }
      if(base!=='http://160.191.47.17'){
        throw new Error('SAFETY: full lifecycle restricted to approved POS staging host');
      }
      ctx.tableId=e.EXT_020_TABLE_ID;
      ctx.itemId=e.EXT_020_MENU_ITEM_ID;
    });
    cy.then(()=>login(env.POS_USERNAME,env.POS_PASSWORD)).then(h=>{admin=h;});
    cy.then(()=>role(env.EXT_020_CASHIER_TOKEN,env.EXT_020_CASHIER_USERNAME,env.EXT_020_CASHIER_PASSWORD)).then(h=>{cashier=h;});
    cy.then(()=>role(env.EXT_020_WAITER_TOKEN,env.EXT_020_WAITER_USERNAME,env.EXT_020_WAITER_PASSWORD)).then(h=>{waiter=h;});
    cy.then(()=>api('GET','/tables/'+ctx.tableId,admin)).then(r=>{
      expect(r.status,'fixture table GET').eq(200);
      expect(r.body.status,'fixture table AVAILABLE').eq('AVAILABLE');
      expect(r.body.current_session,'no existing customer session').to.be.oneOf([null,undefined]);
    });
    cy.then(()=>api('GET','/menu',admin)).then(r=>{
      expect(r.status,'menu GET').eq(200);
      const item=list(r.body).find(x=>String(x.id)===String(ctx.itemId));
      expect(item,'configured sellable QA item').to.exist;
      expect(item.is_available,'item available').eq(true);
    });
    cy.then(()=>api('GET','/tables',cashier)).then(r=>expect(r.status,'cashier can access tables').eq(200));
    cy.then(()=>api('GET','/tables',waiter)).then(r=>expect(r.status,'waiter can access tables').eq(200));
  });

  it('opens -> orders -> sends -> bills -> simulates pay -> closes -> cleans',()=>{
    request('POST','/tables/'+ctx.tableId+'/open-session',admin,
      {guest_count:1},'OPEN_SESSION',201).then(r=>{
        ctx.sessionId=r.body.id||r.body.session?.id||r.body.table_session?.id;
        expect(ctx.sessionId,'new session ID').to.match(uuid);
      });
    cy.then(()=>request('POST','/orders',cashier,
      {table_session_id:ctx.sessionId},'CREATE_ORDER',201)).then(r=>{
        ctx.orderId=r.body.id||r.body.order?.id;
        expect(ctx.orderId,'new order ID').to.match(uuid);
      });
    cy.then(()=>request('POST','/orders/'+ctx.orderId+'/items',cashier,
      {items:[{menu_item_id:ctx.itemId,quantity:1,note:'QA TC_EXT_020'}]},
      'ADD_ITEM',201));
    cy.then(()=>request('GET','/orders/'+ctx.orderId,cashier,undefined,'VERIFY_NEW',200)).then(r=>{
      const o=order(r.body);
      expect(o.status).eq('NEW');
      expect(list(o.items).some(i=>String(i.menu_item_id)===String(ctx.itemId))).eq(true);
      expect(Number(o.subtotal),'subtotal positive').to.be.greaterThan(0);
    });
    cy.then(()=>request('POST','/orders/'+ctx.orderId+'/send-to-kitchen',cashier,
      undefined,'SEND_TO_KITCHEN',200)).then(r=>expect(order(r.body).status).eq('SENT'));
    cy.then(()=>request('POST','/orders/'+ctx.orderId+'/request-billing',cashier,
      undefined,'REQUEST_BILLING',200)).then(r=>expect(order(r.body).status).eq('BILLING'));
    cy.then(()=>request('POST','/orders/'+ctx.orderId+'/pay',cashier,
      undefined,'SIMULATED_PAY',200)).then(r=>expect(order(r.body).status).eq('PAID'));
    cy.then(()=>request('POST','/orders/'+ctx.orderId+'/close',cashier,
      undefined,'CLOSE_ORDER',200)).then(r=>expect(order(r.body).status).eq('CLOSED'));
    cy.then(()=>request('GET','/tables/'+ctx.tableId,admin,undefined,'VERIFY_CLEANING',200))
      .then(r=>expect(r.body.status).eq('CLEANING'));
    cy.then(()=>request('POST','/tables/'+ctx.tableId+'/mark-clean',waiter,
      undefined,'MARK_CLEAN',200)).then(r=>expect(r.body.status).eq('AVAILABLE'));
    cy.then(()=>request('GET','/tables/'+ctx.tableId,admin,undefined,'VERIFY_AVAILABLE',200))
      .then(r=>{
        expect(r.body.status).eq('AVAILABLE');
        expect(r.body.current_session).to.be.oneOf([null,undefined]);
        ctx.cleanup='VERIFIED_AVAILABLE';
        return write('COMPLETE',200);
      });
  });

  afterEach(function(){
    if(!ctx.sessionId||ctx.cleanup==='VERIFIED_AVAILABLE')return;
    // Best-effort compensation: run even when main assertions fail.
    // Never silently count a failed main workflow as passed.
    const note=(stage,r)=>{ctx.audit.push({stage,status:r.status,time:new Date().toISOString()});return r;};
    if(!ctx.orderId){
      ctx.cleanup='MANUAL_REVIEW_SESSION_OPEN_NO_ORDER';
      cy.writeFile('evidence/TC_EXT_020/last-run.json',ctx);
      return;
    }
    api('GET','/orders/'+ctx.orderId,cashier).then(r=>{
      note('RECOVERY_GET_ORDER',r);
      if(r.status!==200){ctx.cleanup='MANUAL_REVIEW_ORDER_UNREADABLE';return;}
      const s=order(r.body).status;
      const post=(suffix)=>api('POST','/orders/'+ctx.orderId+suffix,
        {...cashier,'Idempotency-Key':key()});
      const actions=s==='NEW'
        ? ['/send-to-kitchen','/request-billing','/pay','/close']
        :s==='SENT'?['/request-billing','/pay','/close']
        :s==='BILLING'?['/pay','/close']
        :s==='PAID'?['/close']
        :[];
      let chain=cy.wrap(null,{log:false});
      actions.forEach(p=>{
        chain=chain.then(()=>post(p).then(x=>note('RECOVERY_'+p,x)));
      });
      return chain;
    }).then(()=>api('GET','/tables/'+ctx.tableId,admin)).then(r=>{
      note('RECOVERY_GET_TABLE',r);
      if(r.status===200&&r.body.status==='CLEANING'){
        return api('POST','/tables/'+ctx.tableId+'/mark-clean',
          {...waiter,'Idempotency-Key':key()}).then(x=>note('RECOVERY_MARK_CLEAN',x));
      }
    }).then(()=>api('GET','/tables/'+ctx.tableId,admin)).then(r=>{
      note('RECOVERY_FINAL_TABLE',r);
      ctx.cleanup=r.status===200&&r.body.status==='AVAILABLE'
        ? 'VERIFIED_AVAILABLE_AFTER_FAILURE'
        : 'MANUAL_REVIEW_REQUIRED';
      return cy.writeFile('evidence/TC_EXT_020/last-run.json',{
        test:'TC_EXT_020',fixtureTable:ctx.tableId,createdOrder:ctx.orderId,
        session:ctx.sessionId,stage:ctx.stage,cleanup:ctx.cleanup,audit:ctx.audit
      });
    });
  });
});
