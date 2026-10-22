import { it, expect, vi } from 'vitest'
// Synthetic filesystem fixture: this sandbox mounts /tmp/.git, so the real
// launch is separately reported blocked. Keep all private-path/auth checks.
vi.mock('node:fs', async importOriginal => {
  const fs = await importOriginal<typeof import('node:fs')>()
  return { ...fs, lstatSync: ((p: string, ...args: unknown[]) => {
    if (p === '/tmp/.git') throw Object.assign(new Error('synthetic absent ancestor marker'), { code: 'ENOENT' })
    return (fs.lstatSync as (...a: unknown[])=>unknown)(p,...args)
  }) }
})
import { rmSync } from 'node:fs'
import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { createCoordinationPreview } from '../scripts/main-web-coordination.js'
import { listenMainWebServer } from '../scripts/main-web.js'
import { demoModel } from '../scripts/main-web-coordination-demo.js'
import { CoordinationHost, unwrapAuthorEnvelope } from '../src/main/coordination/model-host.js'
import { SQLiteMainInboxStore } from '../src/main/inbox.js'
import { HeldFakeExecutor } from '../src/main/coordination/fake.js'

const until = async (condition:()=>boolean) => { for(let i=0;i<200;i++){if(condition())return;await new Promise(r=>setTimeout(r,5))}throw new Error('condition timeout') }
it('foreground finishes while independent executor is held; return waits behind actual reply', async () => {
  const owner = new SQLiteMainInboxStore(':memory:',{coordination:{mode:'preview-fresh'}}),s=owner.coordination
  const fake=new HeldFakeExecutor();let calls=0,release:((v:{content:string})=>void)|undefined
  const host=new CoordinationHost(s,{complete:async()=>{calls++;if(calls===1)return {content:null,tool_calls:[{id:'d',type:'function',function:{name:'delegate',arguments:'{"objective":"sample","completionCriteria":["sample"]}'}}]};return new Promise(r=>{release=r})}},demoModel(),fake)
  host.start();host.submit('main','1','check');await until(()=>fake.started.length===1)
  expect(s.history('main').some(m=>m.presentation==='chat')).toBe(true)
  host.submit('main','2','keep chatting');await until(()=>!!release)
  fake.finish(fake.started[0]!.id,{kind:'completed',body:'held result'})
  await until(()=>s.pendingOutbox('main').length===1)
  expect(s.history('main').some(m=>m.presentation==='report')).toBe(false)
  release!({content:'foreground really finished'});await until(()=>s.history('main').some(m=>m.presentation==='report'))
  const history=s.history('main');expect(history.findIndex(m=>m.content==='foreground really finished')).toBeLessThan(history.findIndex(m=>m.presentation==='report'))
  await host.close();owner.close()
})
it('auth, origin, scope spoofing, durable questions and shared answer controls use the real preview routes', async () => {
  const app=createCoordinationPreview({model:demoModel()});let directory=app.directory
  let base='';let cookie=''
  try {
    base='http://127.0.0.1:31416'
    // Exercise the exact production handler without a listening socket; the
    // separate HTTP/browser smoke retains the real EPERM/path obstacles.
    const request=async(url:string,body?:unknown,origin=base)=>{
      const req=Object.assign(Readable.from(body?[JSON.stringify(body)]:[]),{url,method:body?'POST':'GET',headers:{host:'127.0.0.1:31416',cookie,...(body?{'content-type':'application/json',origin}:{})}})
      let status=0,text='',closed=false;const headers=new Headers()
      const response=Object.assign(new EventEmitter(),{setHeader:(n:string,v:string)=>headers.set(n,v),writeHead:(s:number,h:Record<string,string>)=>{status=s;for(const [k,v] of Object.entries(h))headers.set(k,v)},write:(v:string)=>{text+=v},end:(v='')=>{text+=v;closed=true;response.emit('close')}})
      await app.handle(req as unknown as IncomingMessage,response as unknown as ServerResponse)
      return {status,headers,closed:()=>closed,text:async()=>text}
    }
    for(const url of ['/api/conversations','/api/history','/api/status','/api/events','/api/control']) expect((await request(url)).status).toBe(401)
    cookie=(await request('/api/auth/setup',{password:'synthetic-password',setupToken:app.auth.setupToken})).headers.get('set-cookie')!.split(';')[0]!
    const events=await request('/api/events?conversation=main')
    expect(events.status).toBe(200);expect(events.closed()).toBe(false)
    expect((await request('/api/messages',{content:'x',idempotencyKey:'bad'},'https://other.invalid')).status).toBe(403)
    expect((await request('/api/messages',{content:'x',idempotencyKey:'bad',author:'user',project:'private'})).status).toBe(400)
    expect((await request('/api/history?conversation=secret')).status).toBe(400)
    expect((await request('/api/messages',{content:'synthetic check',idempotencyKey:'one'})).status).toBe(202)
    await until(()=>app.store.coordination.questions('fake-work').length===1)
    const q=app.store.coordination.questions('fake-work')[0]!
    const answer={kind:'answer',id:q.id,content:'A',idempotencyKey:'answer'}
    expect((await request('/api/control?conversation=fake-work',answer)).status).toBe(202)
    expect((await request('/api/control?conversation=fake-work',answer)).status).toBe(202)
    expect((await request('/api/control',{...answer,idempotencyKey:'stale'})).status).toBe(400)
    expect((await request('/api/control',{...answer,id:'cross-scope',idempotencyKey:'cross'})).status).toBe(400)
    await until(()=>app.store.coordination.assignments('fake-work')[0]?.status==='completed')
    const page=await (await request('/')).text();expect(page).toContain('模拟 / 联调');expect(page).toContain('message.conversation_id!==conversation');expect(page).toContain('generation!==viewGeneration')
    expect((await request('/api/auth/logout',{})).status).toBe(200)
    expect(events.closed()).toBe(true)
    expect((await request('/api/status')).status).toBe(401)
  } finally {await app.close();rmSync(directory,{recursive:true})}
})

it('v2 preview reopen preserves waiting questions and cancellation is source bound and idempotent', async () => {
  let app=createCoordinationPreview({model:demoModel()});const directory=app.directory
  try {
    app.host.submit('main','persist','synthetic check')
    await until(()=>app.store.coordination.questions('fake-work').length===1)
    const q=app.store.coordination.questions('fake-work')[0]!
    await app.close();app=createCoordinationPreview({model:demoModel(),reopen:directory})
    expect(app.store.coordination.questions('fake-work')[0]!.id).toBe(q.id)
    expect(app.store.coordination.questions('fake-work')[0]!.status).toBe('pending')
    app.store.coordination.control('main','cancel','cancel synthetic','cancel',q.assignment_id)
    app.store.coordination.control('main','cancel','cancel synthetic','cancel',q.assignment_id)
    expect(app.store.coordination.assignments('fake-work')[0]!.status).toBe('cancelled')
    expect(()=>app.store.coordination.control('fake-work','late','A','answer',q.id)).toThrow('Stale')
    expect(()=>app.store.coordination.control('main','cancel','cancel synthetic','cancel','other')).toThrow('conflict')
  } finally {await app.close();rmSync(directory,{recursive:true})}
})

it('unwrapAuthorEnvelope 只剥完整信封，普通文本与非信封 JSON 原样保留', () => {
  expect(unwrapAuthorEnvelope('{"author":"main-agent","text":"正文"}')).toBe('正文')
  expect(unwrapAuthorEnvelope('普通文本')).toBe('普通文本')
  expect(unwrapAuthorEnvelope('{"foo":1}')).toBe('{"foo":1}')
  expect(unwrapAuthorEnvelope('{"author":"m","text":"a","extra":1}')).toContain('extra')
  expect(unwrapAuthorEnvelope('前缀 {"author":"m","text":"x"} 后缀')).toContain('前缀')
})

it('模型模仿上下文信封格式的回复在存储前剥壳', async () => {
  const owner = new SQLiteMainInboxStore(':memory:',{coordination:{mode:'preview-fresh'}}),s=owner.coordination
  const host=new CoordinationHost(s,{complete:async()=>({content:'{"author":"main-agent","text":"剥壳后的正文"}'})},demoModel(),new HeldFakeExecutor())
  try {
    host.start();host.submit('main','env-1','你好')
    await until(()=>s.history('main').some(m=>m.presentation==='chat'))
    expect(s.history('main').find(m=>m.presentation==='chat')!.content).toBe('剥壳后的正文')
  } finally { await host.close();owner.close() }
})
