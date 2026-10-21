import { it, expect, vi } from 'vitest'
import { rmSync, readFileSync } from 'node:fs'
import { Readable } from 'node:stream'
import { EventEmitter } from 'node:events'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { createCoordinationPreview, previewCheckpoint } from '../scripts/main-web-coordination.js'
import { mainCheckpoint } from '../scripts/main-web.js'
import { ownerContextCheckpoint, readOwnerContext } from '../src/main/owner-context.js'
import { SQLiteMainInboxStore } from '../src/main/inbox.js'
import { CoordinationHost } from '../src/main/coordination/model-host.js'
import { HeldFakeExecutor } from '../src/main/coordination/fake.js'
import type { ModelReply, ScopedModel } from '../src/agent/scoped-protocol.js'

vi.mock('node:fs', async original => {
  const fs = await original<typeof import('node:fs')>()
  return { ...fs, lstatSync: (...args: Parameters<typeof fs.lstatSync>) => {
    if (String(args[0]) === '/tmp/.git') throw Object.assign(new Error('fixture marker'), { code: 'ENOENT' })
    return fs.lstatSync(...args)
  } }
})
const until = async (condition: () => boolean) => { for (let i=0;i<300;i++){if(condition())return;await new Promise(r=>setTimeout(r,5))}throw new Error('condition timeout') }
class Response extends EventEmitter {
  status=0; text='';headers:Record<string,string>={}
  setHeader(n:string,v:string){this.headers[n.toLowerCase()]=v}
  writeHead(s:number,h:Record<string,string>){this.status=s;for(const [k,v] of Object.entries(h))this.setHeader(k,v)}
  write(v:string){this.text+=v}
  end(v=''){this.text+=v;this.emit('close')}
}

it('preview init/save/reopen keeps tool capabilities and persistent owner provenance; history matches SSE timestamps',async()=>{
  const contexts:string[]=[]
  const model:ScopedModel={complete:async messages=>{contexts.push(JSON.stringify(messages));return {content:'synthetic reply'}}}
  let app=createCoordinationPreview({model});const dir=app.directory;let cookie=''
  const request=async(url:string,method='GET',body?:unknown)=>{
    const req=Object.assign(Readable.from(body?[JSON.stringify(body)]:[]),{url,method,headers:{host:'127.0.0.1:31416',cookie,...(body?{'content-type':'application/json',origin:'http://127.0.0.1:31416'}:{})}})
    const response=new Response();await app.handle(req as unknown as IncomingMessage,response as unknown as ServerResponse);return response
  }
  try {
    expect(previewCheckpoint('SYNTHETIC_INIT_OWNER')).toContain(ownerContextCheckpoint('SYNTHETIC_INIT_OWNER'))
    expect(app.host.checkpoint).toContain(ownerContextCheckpoint(readOwnerContext(dir)))
    expect(app.host.checkpoint).not.toContain('不调用工具')
    // Legacy website remains intentionally unchanged.
    expect(mainCheckpoint('legacy')).toContain('不调用工具')
    cookie=(await request('/api/auth/setup','POST',{password:'synthetic-password',setupToken:app.auth.setupToken})).headers['set-cookie']!.split(';')[0]!
    const events=await request('/api/events?conversation=main&cursor=0')
    await request('/api/messages','POST',{content:'hello init',idempotencyKey:'init'})
    await until(()=>app.store.coordination.history('main').some(m=>m.presentation==='chat'))
    expect(contexts[0]).not.toContain('不调用工具')
    const saved=await request('/api/owner-context','PUT',{content:'SYNTHETIC_SAVED_OWNER_MARKER'})
    expect(saved.status).toBe(200)
    expect(app.host.checkpoint).toContain(ownerContextCheckpoint('SYNTHETIC_SAVED_OWNER_MARKER'))
    expect(app.host.checkpoint).toContain('delegate');expect(app.host.checkpoint).not.toContain('不调用工具')
    await request('/api/messages','POST',{content:'hello saved',idempotencyKey:'saved'});await until(()=>contexts.length===2)
    expect(contexts[1]).toContain('SYNTHETIC_SAVED_OWNER_MARKER');expect(contexts[1]).not.toContain('不调用工具')
    const history=JSON.parse((await request('/api/history')).text).messages as {id:string;createdAt:string;created_at:string}[]
    const eventMessages=events.text.split('\n').filter(line=>line.startsWith('data: ')).map(line=>JSON.parse(line.slice(6)).message).filter(Boolean)
    for(const m of history){expect(m.createdAt).toBe(m.created_at);expect(new Date(m.createdAt).toISOString()).toBe(m.createdAt);expect(eventMessages.find(e=>e.id===m.id)?.createdAt).toBe(m.createdAt)}
    await app.close();app=createCoordinationPreview({model,reopen:dir})
    expect(app.host.checkpoint).toContain('SYNTHETIC_SAVED_OWNER_MARKER');expect(app.host.checkpoint).not.toContain('不调用工具')
    app.host.submit('main','reopen','hello reopen');await until(()=>contexts.length===3)
    expect(contexts[2]).toContain('SYNTHETIC_SAVED_OWNER_MARKER');expect(contexts[2]).not.toContain('不调用工具')
    app.host.submit('fake-work','ordinary','group hello');await until(()=>contexts.length===4)
    app.host.submit('fake-work','addressed','@main group hello');await until(()=>contexts.length===5)
    for(const input of contexts.slice(3)){expect(input).not.toContain('SYNTHETIC_SAVED_OWNER_MARKER');expect(input).not.toContain('不调用工具')}
  } finally {await app.close();rmSync(dir,{recursive:true})}
})

it('one fair foreground queue serializes main and @main-in-group while background completes independently',async()=>{
  const owner=new SQLiteMainInboxStore(':memory:',{coordination:{mode:'preview-fresh'}}),s=owner.coordination,fake=new HeldFakeExecutor()
  const seed=s.admit('main','seed','synthetic work')
  s.accept('main',seed.event.id,{action:'fake-check',objective:'sample',scope:['synthetic'],completionCriteria:['evidence']})
  s.finishChat(s.beginChat('main')!,'seed accepted')
  s.admit('main','held-main','hold main')
  s.admit('fake-work','held-group','@main hold group')
  s.admit('main','later-main','later main')
  let active=0,maxActive=0;const seen:string[]=[],releases:((r:ModelReply)=>void)[]=[]
  const model:ScopedModel={complete:async messages=>{
    active++;maxActive=Math.max(maxActive,active);seen.push(messages.at(-1)!.content!)
    try{return await new Promise<ModelReply>(resolve=>releases.push(resolve))}finally{active--}
  }}
  const host=new CoordinationHost(s,model,model,fake)
  try {
    host.start();await until(()=>releases.length===1&&fake.started.length===1)
    for(let i=0;i<100;i++)host.pump()
    expect(releases).toHaveLength(1);expect(active).toBe(1)
    fake.finish(fake.started[0]!.id,{kind:'completed',body:'background completed during foreground'})
    await until(()=>s.assignments('fake-work')[0]!.status==='completed')
    expect(releases).toHaveLength(1);expect(s.pendingOutbox('main')).toHaveLength(1)
    expect(s.history('main').some(m=>m.presentation==='report')).toBe(false)
    releases[0]!({content:'main reply'});await until(()=>releases.length===2)
    expect(seen[1]).toContain('@main hold group')
    for(let i=0;i<100;i++)host.pump();expect(releases).toHaveLength(2)
    releases[1]!({content:'group reply'});await until(()=>releases.length===3)
    expect(seen[2]).toContain('later main')
    releases[2]!({content:'later reply'});await until(()=>active===0)
    expect(maxActive).toBe(1)
    await until(()=>s.history('main').some(m=>m.presentation==='report'))
  }finally{await host.close();owner.close()}
})

it('browser smoke uses locator assertions without expression eval or CSP changes',()=>{
  const smoke=readFileSync(new URL('../scripts/smoke-coordination-web.ts',import.meta.url),'utf8')
  expect(smoke).not.toContain('wait_for_function(')
  expect(smoke).toContain("expect(page.locator('.task-card').first).to_contain_text('已完成'")
  expect(smoke).toContain("expect(page.locator('#messages')).to_contain_text('模拟/联调回传'")
})
