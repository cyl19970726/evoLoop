import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify from 'fastify';
import { z } from 'zod';
import type { Principal } from '@evoloop/contracts';
import { DomainError } from '@evoloop/contracts/ports';
import type { SessionTimelineService } from '../src/session-timeline/index.js';
import { registerSessionTimelineRoutes } from '../src/session-timeline/routes.js';
const project='00000000-0000-4000-8000-000000000001';
const key='owned:00000000-0000-4000-8000-000000000002';
const root=`/api/projects/${project}/session-work/${key}/timeline`;
test('authenticated timeline GET routes expose independent source, direct Item and bounded live reads',async()=>{
  const app=Fastify();const calls:unknown[][]=[];
  const principal:Principal={actorId:'reader',projectIds:[project],permissions:['read']};
  app.decorateRequest('principal',null);app.decorateRequest('workerIdentity',null);
  app.addHook('onRequest',async request=>{request.principal=request.headers.authorization?principal:null});
  app.setErrorHandler((error,_request,reply)=>reply.code(error instanceof z.ZodError?400:
    error instanceof DomainError&&error.code==='FORBIDDEN'?403:409).send({code:error instanceof DomainError?error.code:'INVALID_INPUT'}));
  const service={page:async(...args:unknown[])=>{calls.push(['page',...args]);return{entries:[],pending:[],nextCursor:null,messagesCursor:null}},
    item:async(...args:unknown[])=>{calls.push(['item',...args]);return{id:'native-item',kind:'message',body:'Public answer'}},
    updates:async(...args:unknown[])=>{calls.push(['updates',...args]);return{cursor:'new',resetRequired:false,entries:[],turns:[],freshness:'live',limitations:[]}}
  } as unknown as SessionTimelineService;
  registerSessionTimelineRoutes(app,service);
  try{
    assert.equal((await app.inject({url:root})).statusCode,403);
    const page=await app.inject({url:`${root}?source=messages&messagesCursor=next&limit=25`,headers:{authorization:'Bearer token'}});
    assert.equal(page.statusCode,200,page.body);
    assert.deepEqual(calls[0],['page',principal,project,key,{source:'messages',messagesCursor:'next',limit:25}]);
    const item=await app.inject({url:`${root}/items/native-item?turnId=turn-1`,headers:{authorization:'Bearer token'}});
    assert.equal(item.statusCode,200,item.body);
    assert.equal(item.json().body,'Public answer');
    assert.deepEqual(calls[1],['item',principal,project,key,'turn-1','native-item',undefined]);
    const updates=await app.inject({url:`${root}/updates?after=old`,headers:{authorization:'Bearer token'}});
    assert.equal(updates.json().cursor,'new');
    assert.deepEqual(calls[2],['updates',principal,project,key,'old',15000]);
    assert.equal((await app.inject({url:`${root}?source=invalid`,headers:{authorization:'Bearer token'}})).statusCode,400);
    assert.equal((await app.inject({url:`${root}/items/native-item`,headers:{authorization:'Bearer token'}})).statusCode,400);
    for(const malformedKey of ['owned:------------------------------------',
      'external:0000000-00000-4000-8000-000000000002']){
      const invalidRoot=`/api/projects/${project}/session-work/${malformedKey}/timeline`;
      const callsBefore=calls.length;
      for(const url of [invalidRoot,`${invalidRoot}/items/native-item?turnId=turn-1`,
        `${invalidRoot}/updates?waitMs=0`]){
        assert.equal((await app.inject({url,headers:{authorization:'Bearer token'}})).statusCode,400);
      }
      assert.equal(calls.length,callsBefore,'invalid Session keys never reach the service');
    }
  }finally{await app.close()}
});
