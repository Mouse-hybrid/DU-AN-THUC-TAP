// TC_EXT_014 - read-only SLA threshold checks against live Kitchen Queue.
// Workbook contract: <8 NORMAL; >=8 WARNING; >=12 DELAYED; >=15 CRITICAL.
// Only mark PASSED when all 4 bands have representative active records.
describe('TC_EXT_014 | Kitchen Queue SLA 8/12/15 minute thresholds', () => {
  const band = (mins) => mins >= 15 ? 'CRITICAL' : mins >= 12 ? 'DELAYED' : mins >= 8 ? 'WARNING' : 'NORMAL';
  const rows = body => Array.isArray(body) ? body :
    ['entries','items','queue','data','results'].map(k=>body?.[k]).find(Array.isArray) || [];
  it('checks every SLA band with live active queue records', function () {
    cy.env(['POS_BASE_URL','POS_USERNAME','POS_PASSWORD','EXT_KITCHEN_TOKEN']).then(e => {
      const base=String(e.POS_BASE_URL||'http://160.191.47.17').replace(/\/$/,'');
      const run = (headers) => cy.request({
        method:'GET',url:base+'/api/v1/kitchen/queue',headers,failOnStatusCode:false
      }).then(response=>{
        expect(response.status,'GET kitchen queue').eq(200);
        const entries=rows(response.body);
        expect(entries,'queue records').to.be.an('array');
        const now=Date.now();
        const samples={NORMAL:[],WARNING:[],DELAYED:[],CRITICAL:[]};
        entries.forEach(entry=>{
          const source=entry.started_at || entry.item?.started_at;
          if(!source)return;
          const timestamp=Date.parse(source);
          if(!Number.isFinite(timestamp)||timestamp>now)return;
          const elapsed=(now-timestamp)/60000;
          const expected=band(elapsed);
          const actual=entry.sla_status || entry.sla_level || entry.sla?.status ||
            entry.sla?.level || entry.sla_warning_level;
          samples[expected].push({actual,elapsed,entry});
        });
        const missing=Object.entries(samples).filter(([,arr])=>!arr.length).map(([name])=>name);
        if(missing.length){
          cy.log('BLOCKED: missing SLA threshold fixtures: '+missing.join(', '));
          this.skip();
          return;
        }
        Object.entries(samples).forEach(([expected,group])=>{
          group.forEach(({actual,elapsed})=>{
            expect(actual,'SLA field for '+elapsed.toFixed(1)+' min').to.exist;
            expect(String(actual).toUpperCase(),'SLA '+expected).eq(expected);
          });
        });
      });
      if(e.EXT_KITCHEN_TOKEN) return run({Authorization:'Bearer '+e.EXT_KITCHEN_TOKEN});
      expect(e.POS_USERNAME,'QA username').to.be.a('string').and.not.be.empty;
      expect(e.POS_PASSWORD,'QA password').to.be.a('string').and.not.be.empty;
      cy.request({method:'POST',url:base+'/api/v1/auth/login',
        body:{username:e.POS_USERNAME,password:e.POS_PASSWORD},failOnStatusCode:false}).then(login=>{
        expect(login.status,'QA login').eq(200);
        const token=login.body.access_token||login.body?.data?.access_token;
        expect(token,'JWT').to.be.a('string').and.not.be.empty;
        return run({Authorization:'Bearer '+token});
      });
    });
  });
});
