// Isolated staging QA: TC_EXT_006/007/008. Mutations opt-in only.
// Uses QA simulated payment, never a real payment gateway.
describe('TC_EXT_006-008 | isolated order verification', () => {
  const envKeys=['POS_BASE_URL','POS_USERNAME','POS_PASSWORD','EXT_RUN_MUTATIONS','EXT_CASHIER_USERNAME','EXT_CASHIER_PASSWORD','EXT_WAITER_USERNAME','EXT_WAITER_PASSWORD','EXT_CASHIER_TOKEN','EXT_WAITER_TOKEN'];
  let env={}, headers={}, cashier={}, waiter={}, ctx={};
  const list=b=>Array.isArray(b)?b:(Array.isArray(b?.items)?b.items:(Array.isArray(b?.data)?b.data:(Array.isArray(b?.results)?b.results:[])));
  const base=()=>String(env.POS_BASE_URL||'http://160.191.47.17').replace(/\/$/,'');
  const key=()=> 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g,c=>{const n=Math.floor(Math.random()*16);return (c==='x'?n:(n&3)|8).toString(16)});
  const call=(method,path,h,body)=>cy.request({method,url:base()+'/api/v1'+path,headers:h,body,failOnStatusCode:false,log:false});
  const idem=h=>({...h,'Idempotency-Key':key()});
  const unwrap=b=>b?.order||b;
  const roleHeaders=(role,token,username,password)=>token ? cy.wrap({Authorization:'Bearer '+token},{log:false}) : login(username,password);
  const login=(username,password)=>call('POST','/auth/login',{}, {username,password}).then(r=>{
    expect(r.status,'login HTTP').eq(200);
    const token=r.body.access_token||r.body?.data?.access_token;
    expect(token,'login JWT').to.be.a('string').and.not.be.empty;
    return {Authorization:'Bearer '+token};
  });
  beforeEach(function(){
    ctx={started:false,orderId:null,tableId:null,sessionId:null,sellableId:null};
    cy.env(envKeys).then(v=>{
      env=v;
      if(String(v.EXT_RUN_MUTATIONS)!=='true'||!v.POS_USERNAME||!v.POS_PASSWORD||
         !(v.EXT_CASHIER_TOKEN||(v.EXT_CASHIER_USERNAME&&v.EXT_CASHIER_PASSWORD))||
         !(v.EXT_WAITER_TOKEN||(v.EXT_WAITER_USERNAME&&v.EXT_WAITER_PASSWORD))){
        cy.log('PENDING: set EXT_RUN_MUTATIONS and separate cashier/waiter QA credentials');
        this.skip();
      }
    });
    cy.then(()=>login(env.POS_USERNAME,env.POS_PASSWORD)).then(h=>{headers=h;});
    cy.then(()=>roleHeaders('cashier',env.EXT_CASHIER_TOKEN,env.EXT_CASHIER_USERNAME,env.EXT_CASHIER_PASSWORD)).then(h=>{cashier=h;});
    cy.then(()=>roleHeaders('waiter',env.EXT_WAITER_TOKEN,env.EXT_WAITER_USERNAME,env.EXT_WAITER_PASSWORD)).then(h=>{waiter=h;});
    cy.then(()=>call('GET','/tables',cashier)).then(r=>{expect(r.status,'cashier token preflight').eq(200);});
    cy.then(()=>call('GET','/tables',waiter)).then(r=>{expect(r.status,'waiter token preflight').eq(200);});
    cy.then(()=>call('GET','/tables',headers)).then(r=>{
      expect(r.status).eq(200);
      const available=list(r.body).filter(t=>t.status==='AVAILABLE'&&!t.current_session_id);
      if(!available.length) throw new Error('PRECONDITION: no AVAILABLE table; no session created');
      ctx.tableId=available[0].id;
    });
    cy.then(()=>call('GET','/menu',headers)).then(r=>{
      expect(r.status).eq(200);
      ctx.sellableId=list(r.body).find(m=>m.is_available===true)?.id;
      ctx.unavailableId=list(r.body).find(m=>m.is_available===false)?.id;
      if(!ctx.sellableId) throw new Error('PRECONDITION: no sellable menu item; no session created');
    });
    cy.then(()=>call('GET','/tables/'+ctx.tableId,headers)).then(r=>{
      expect(r.status).eq(200);
      expect(r.body.status,'table must still be AVAILABLE').eq('AVAILABLE');
      expect(r.body.current_session,'must have no existing session').to.be.oneOf([null,undefined]);
    });
    cy.then(()=>call('POST','/tables/'+ctx.tableId+'/open-session',idem(headers),{guest_count:1})).then(r=>{
      expect(r.status,'open isolated session').eq(201);
      ctx.started=true;
      ctx.sessionId=r.body.id||r.body.session?.id||r.body.table_session?.id;
      expect(ctx.sessionId,'new session id').to.exist;
    });
    cy.then(()=>call('POST','/orders',idem(cashier),{table_session_id:ctx.sessionId})).then(r=>{
      expect(r.status,'create QA order').eq(201);
      ctx.orderId=r.body.id||r.body.order?.id;
      expect(ctx.orderId,'new QA order id').to.exist;
      expect(r.body.table_session_id||r.body.order?.table_session_id).eq(ctx.sessionId);
    });
  });
  it('TC_EXT_006 | unavailable menu item rejected and subtotal unchanged',function(){
    if(!ctx.unavailableId){this.skip();return;}
    call('GET','/orders/'+ctx.orderId,cashier).then(before=>{
      expect(before.status).eq(200);
      const b=unwrap(before.body);
      expect(b.status).eq('NEW');
      const count=list(b.items).length;
      call('POST','/orders/'+ctx.orderId+'/items',idem(cashier),{items:[{menu_item_id:ctx.unavailableId,quantity:1}]}).then(rejected=>{
        expect(rejected.status,'unavailable item rejected').eq(409);
        call('GET','/orders/'+ctx.orderId,cashier).then(after=>{
          expect(after.status).eq(200);
          expect(String(unwrap(after.body).subtotal)).eq(String(b.subtotal));
          expect(list(unwrap(after.body).items).length).eq(count);
        });
      });
    });
  });
  it('TC_EXT_007 | same key and payload creates only one item',()=>{
    const h=idem(cashier), body={items:[{menu_item_id:ctx.sellableId,quantity:1}]};
    call('POST','/orders/'+ctx.orderId+'/items',h,body).then(first=>{
      expect(first.status).eq(201);
      call('GET','/orders/'+ctx.orderId,cashier).then(mid=>{
        expect(mid.status).eq(200);
        const b=unwrap(mid.body);
        call('POST','/orders/'+ctx.orderId+'/items',h,body).then(repeat=>{
          expect(repeat.status).to.be.oneOf([200,201]);
          call('GET','/orders/'+ctx.orderId,cashier).then(after=>{
            expect(after.status).eq(200);
            const a=unwrap(after.body);
            expect(String(a.subtotal),'no duplicate subtotal').eq(String(b.subtotal));
            expect(list(a.items).length,'no extra order lines').eq(list(b.items).length);
          });
        });
      });
    });
  });
  it('TC_EXT_008 | same key with different payload rejected',()=>{
    const h=idem(cashier),body={items:[{menu_item_id:ctx.sellableId,quantity:1}]};
    call('POST','/orders/'+ctx.orderId+'/items',h,body).then(first=>{
      expect(first.status).eq(201);
      call('GET','/orders/'+ctx.orderId,cashier).then(mid=>{
        expect(mid.status).eq(200);
        const b=unwrap(mid.body);
        call('POST','/orders/'+ctx.orderId+'/items',h,{items:[{menu_item_id:ctx.sellableId,quantity:2}]}).then(repeat=>{
          expect(repeat.status,'idempotency-key conflict').eq(409);
          call('GET','/orders/'+ctx.orderId,cashier).then(after=>{
            expect(after.status).eq(200);
            const a=unwrap(after.body);
            expect(String(a.subtotal),'subtotal unchanged').eq(String(b.subtotal));
            expect(list(a.items).length,'item count unchanged').eq(list(b.items).length);
          });
        });
      });
    });
  });
  afterEach(()=>{
    if(!ctx.started)return;
    const record={test:ctx.orderId,table:ctx.tableId,cleanup:'STARTED',at:new Date().toISOString()};
    const save=()=>cy.writeFile('evidence/TC_EXT_001_009/cleanup-last.json',record);
    const check=(r,label,status)=>{expect(r.status,label+' HTTP').eq(200);expect(unwrap(r.body).status,label+' status').eq(status);};
    if(!ctx.orderId){record.cleanup='BLOCKED_NO_ORDER';save();return;}
    call('GET','/orders/'+ctx.orderId,cashier).then(o=>{
      expect(o.status).eq(200);
      const status=unwrap(o.body).status;
      if(status==='NEW') return call('POST','/orders/'+ctx.orderId+'/items',idem(cashier),{items:[{menu_item_id:ctx.sellableId,quantity:1,note:'QA recovery'}]}).then(added=>{
        expect(added.status,'recovery item').eq(201);
        return call('POST','/orders/'+ctx.orderId+'/send-to-kitchen',idem(cashier));
      }).then(sent=>check(sent,'send to kitchen','SENT'));
      expect(status,'cleanup expected NEW or SENT').eq('SENT');
    }).then(()=>call('POST','/orders/'+ctx.orderId+'/request-billing',idem(cashier)))
      .then(r=>check(r,'request billing','BILLING'))
      .then(()=>call('POST','/orders/'+ctx.orderId+'/pay',idem(cashier)))
      .then(r=>check(r,'QA simulated pay','PAID'))
      .then(()=>call('POST','/orders/'+ctx.orderId+'/close',idem(cashier)))
      .then(r=>check(r,'close order','CLOSED'))
      .then(()=>call('GET','/tables/'+ctx.tableId,headers))
      .then(r=>{expect(r.status).eq(200);expect(r.body.status).eq('CLEANING');expect(r.body.current_session).to.be.oneOf([null,undefined]);})
      .then(()=>call('POST','/tables/'+ctx.tableId+'/mark-clean',idem(waiter)))
      .then(r=>{expect(r.status,'mark clean').eq(200);return call('GET','/tables/'+ctx.tableId,headers);})
      .then(r=>{expect(r.status).eq(200);expect(r.body.status,'final table').eq('AVAILABLE');record.cleanup='AVAILABLE';save();});
  });
});
