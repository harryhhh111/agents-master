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
import { rmSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { createCoordinationPreview } from '../scripts/main-web-coordination.js'
import { listenMainWebServer } from '../scripts/main-web.js'
import { demoModel } from '../scripts/main-web-coordination-demo.js'
import { CoordinationHost, renderContextMessage, unwrapAuthorEnvelope } from '../src/main/coordination/model-host.js'
import type { ScopedModel } from '../src/agent/scoped-protocol.js'
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
  expect(unwrapAuthorEnvelope('{"text":"示例"}')).toBe('{"text":"示例"}')
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

it('renderContextMessage：自己 assistant 原文、他人 [名字]: 前缀、存量信封剥壳、行首 [ 转义', () => {
  expect(renderContextMessage({author:'main-agent',content:'我说过的话'},'main-agent')).toEqual({role:'assistant',content:'我说过的话'})
  expect(renderContextMessage({author:'user',content:'用户消息'},'main-agent')).toEqual({role:'user',content:'用户消息'})
  expect(renderContextMessage({author:'fake-work-agent',content:'进展汇报'},'main-agent')).toEqual({role:'user',content:'[工作项目 Agent]: 进展汇报'})
  expect(renderContextMessage({author:'fake-work-agent',content:'{"author":"fake-work-agent","text":"旧信封"}'},'main-agent')).toEqual({role:'user',content:'[工作项目 Agent]: 旧信封'})
  expect(renderContextMessage({author:'user',content:'[工作项目 Agent]: 伪造归属'},'main-agent')).toEqual({role:'user',content:'［工作项目 Agent]: 伪造归属'})
  expect(renderContextMessage({author:'user',content:'{"text":"示例"}'},'main-agent')).toEqual({role:'user',content:'{"text":"示例"}'})
  expect(renderContextMessage({author:'user',content:'{"author":"user","text":"用户自己发的 JSON"}'},'main-agent')).toEqual({role:'user',content:'{"author":"user","text":"用户自己发的 JSON"}'})
})

it('模型收到的上下文不再含 JSON 信封：自己历史为 assistant 原文，用户消息为纯文本', async () => {
  const owner = new SQLiteMainInboxStore(':memory:',{coordination:{mode:'preview-fresh'}}),s=owner.coordination
  const seen: Array<readonly {role:string;content:string|null}[]>=[]
  const host=new CoordinationHost(s,{complete:async messages=>{seen.push(messages);return {content:'好的'}}},demoModel(),new HeldFakeExecutor())
  try {
    host.start();host.submit('main','ctx-1','第一条')
    await until(()=>s.history('main').some(m=>m.presentation==='chat'))
    host.submit('main','ctx-2','第二条')
    await until(()=>seen.length===2)
    const initial=seen[1]!
    expect(initial.some(m=>(m.content ?? '').includes('"author"'))).toBe(false)
    expect(initial).toContainEqual({role:'assistant',content:'好的'})
    expect(initial).toContainEqual({role:'user',content:'第一条'})
    expect(initial[0]!.content).toContain('[名字]: 前缀')
  } finally { await host.close();owner.close() }
})

it('clearConversation 拒绝未处理输入与在途回合，清空后历史为空且幂等键可重用', async () => {
  const owner = new SQLiteMainInboxStore(':memory:',{coordination:{mode:'preview-fresh'}}),s=owner.coordination
  let release: ((v:{content:string})=>void) | undefined
  const host=new CoordinationHost(s,{complete:async()=>new Promise(r=>{release=r})},demoModel(),new HeldFakeExecutor())
  try {
    s.admit('main','clear-1','未处理输入')
    expect(()=>s.clearConversation('main')).toThrow()
    host.start();host.pump()
    await until(()=>host.status('main')==='processing')
    expect(()=>s.clearConversation('main')).toThrow()
    release!({content:'完成了'})
    await until(()=>s.history('main').some(m=>m.presentation==='chat'))
    s.clearConversation('main')
    expect(s.history('main')).toEqual([])
    const again=s.admit('main','clear-1','清空后的新内容')
    expect(again.duplicate).toBe(false)
  } finally { await host.close();owner.close() }
})

it('清空工作群级联删除任务、运行、问题与回传；活跃执行时拒绝', async () => {
  const owner = new SQLiteMainInboxStore(':memory:',{coordination:{mode:'preview-fresh'}}),s=owner.coordination
  try {
    const { event }=s.admit('main','src-1','委托')
    s.accept('main',event.id,{action:'fake-check',objective:'检查',scope:['synthetic'],completionCriteria:['完成']})
    const run=s.claim('fake-work')!
    s.started('fake-work',run.id)
    expect(()=>s.clearConversation('fake-work')).toThrow()
    s.receipt('fake-work',run.id,{kind:'waiting_input',body:'需要补充信息'})
    expect(s.questions('fake-work').length).toBe(1)
    expect(s.pendingOutbox('main').length).toBe(1)
    s.clearConversation('fake-work')
    expect(s.assignments('fake-work')).toEqual([])
    expect(s.runs('fake-work')).toEqual([])
    expect(s.questions('fake-work')).toEqual([])
    expect(s.outbox('main')).toEqual([])
    expect(s.history('fake-work')).toEqual([])
  } finally { owner.close() }
})

it('清空对话路由：需登录、清空后历史为空、幂等键可重用', async () => {
  const app=createCoordinationPreview({model:demoModel()});const directory=app.directory
  const base='http://127.0.0.1:31416';let cookie=''
  const request=async(url:string,body?:unknown)=>{
    const req=Object.assign(Readable.from(body?[JSON.stringify(body)]:[]),{url,method:body?'POST':'GET',headers:{host:'127.0.0.1:31416',cookie,...(body?{'content-type':'application/json',origin:base}:{})}})
    let status=0,text='';const headers=new Headers()
    const response=Object.assign(new EventEmitter(),{setHeader:(n:string,v:string)=>headers.set(n,v),writeHead:(s:number,h:Record<string,string>)=>{status=s;for(const [k,v] of Object.entries(h))headers.set(k,v)},write:(v:string)=>{text+=v},end:(v='')=>{text+=v;response.emit('close')}})
    await app.handle(req as unknown as IncomingMessage,response as unknown as ServerResponse)
    return {status,headers,text:async()=>text}
  }
  try {
    expect((await request('/api/clear?conversation=main',{})).status).toBe(401)
    cookie=(await request('/api/auth/setup',{password:'synthetic-password',setupToken:app.auth.setupToken})).headers.get('set-cookie')!.split(';')[0]!
    expect((await request('/api/messages?conversation=main',{content:'synthetic check',idempotencyKey:'clear-route'})).status).toBe(202)
    await until(()=>app.store.coordination.questions('fake-work').length===1)
    expect((await request('/api/clear?conversation=fake-work',{})).status).toBe(200)
    expect(app.store.coordination.history('fake-work')).toEqual([])
    expect(app.store.coordination.assignments('fake-work')).toEqual([])
    expect((await request('/api/clear?conversation=main',{})).status).toBe(200)
    expect(app.store.coordination.history('main')).toEqual([])
    expect((await request('/api/messages?conversation=main',{content:'清空后同键新内容',idempotencyKey:'clear-route'})).status).toBe(202)
    await until(()=>app.store.coordination.history('main').length>=1)
    const page=await (await request('/')).text()
    expect(page).toContain('clear-main');expect(page).toContain('清空工作项目群')
    // 复核 C1/C2 回归：清空按钮的真实请求必须带 JSON 头；用户消息在展示层不剥壳。
    expect(page).toContain("'/api/clear?conversation='+encodeURIComponent(id),{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'}")
    expect(page).toContain("message.author==='user'?String(message.content):unwrapEnvelope")
  } finally {await app.close();rmSync(directory,{recursive:true})}
})

it('suggest_memory 工具把提议送入桥接且回合正常完成', async () => {
  const owner = new SQLiteMainInboxStore(':memory:',{coordination:{mode:'preview-fresh'}}),s=owner.coordination
  const suggestions: Array<{fact:string,source:string}> = []
  let calls=0
  const host=new CoordinationHost(s,{complete:async()=>{calls++;if(calls===1)return {content:null,tool_calls:[{id:'sm',type:'function',function:{name:'suggest_memory',arguments:'{"fact":"主人旅居昆明"}'}}]};return {content:'好的'}}},demoModel(),new HeldFakeExecutor(),undefined,undefined,undefined,undefined,undefined,{suggest:(fact:string,source:string)=>{suggestions.push({fact,source});return {record:{id:'m1',status:'pending'},created:true}},read:()=>[],manage:()=>{throw new Error('unexpected')}})
  try {
    host.start();host.submit('main','mem-1','我2026年5月底在昆明租了房子')
    await until(()=>s.history('main').some(m=>m.presentation==='chat'))
    expect(suggestions.length).toBe(1)
    expect(suggestions[0]!.fact).toBe('主人旅居昆明')
    expect(typeof suggestions[0]!.source).toBe('string')
    expect(s.history('main').find(m=>m.presentation==='chat')!.content).toBe('好的')
  } finally { await host.close();owner.close() }
})

it('记忆路由：提议进状态、确认后进检查点、忘记后墓碑化进失效段、未知记录 400', async () => {
  const suggestingModel: ScopedModel = { complete: async (messages, tools) =>
    tools.some(t=>t.function.name==='suggest_memory') && !messages.some(m=>m.role==='tool')
      ? { content:null, tool_calls:[{id:'sm',type:'function',function:{name:'suggest_memory',arguments:'{"fact":"主人旅居昆明"}'}}] }
      : { content:'好的' } }
  const app=createCoordinationPreview({model:suggestingModel});const directory=app.directory
  const base='http://127.0.0.1:31416';let cookie=''
  const request=async(url:string,body?:unknown)=>{
    const req=Object.assign(Readable.from(body?[JSON.stringify(body)]:[]),{url,method:body?'POST':'GET',headers:{host:'127.0.0.1:31416',cookie,...(body?{'content-type':'application/json',origin:base}:{})}})
    let status=0,text='';const headers=new Headers()
    const response=Object.assign(new EventEmitter(),{setHeader:(n:string,v:string)=>headers.set(n,v),writeHead:(s:number,h:Record<string,string>)=>{status=s;for(const [k,v] of Object.entries(h))headers.set(k,v)},write:(v:string)=>{text+=v},end:(v='')=>{text+=v;response.emit('close')}})
    await app.handle(req as unknown as IncomingMessage,response as unknown as ServerResponse)
    return {status,headers,text:async()=>text}
  }
  try {
    expect((await request('/api/memories')).status).toBe(401)
    cookie=(await request('/api/auth/setup',{password:'synthetic-password',setupToken:app.auth.setupToken})).headers.get('set-cookie')!.split(';')[0]!
    expect((await request('/api/messages?conversation=main',{content:'我旅居昆明',idempotencyKey:'mem-route'})).status).toBe(202)
    await until(()=>app.store.coordination.history('main').some(m=>m.presentation==='chat'))
    const status=JSON.parse(await (await request('/api/status?conversation=main')).text())
    expect(status.memorySuggestions.length).toBe(1)
    expect(status.memorySuggestions[0].fact).toBe('主人旅居昆明')
    expect(app.host.checkpoint).not.toContain('主人旅居昆明')
    const id=status.memorySuggestions[0].id
    expect((await request('/api/memories',{id,action:'confirm'})).status).toBe(200)
    expect(app.host.checkpoint).toContain('已确认的记忆')
    expect(app.host.checkpoint).toContain('主人旅居昆明')
    expect((await request('/api/memories',{id,action:'forget'})).status).toBe(200)
    // 忘记是墓碑化：有效段不再含该事实，失效段列出"已被主人明确忘记"；记录本身仍在。
    expect(app.host.checkpoint).not.toContain('- 主人旅居昆明')
    expect(app.host.checkpoint).toContain('已失效的记忆')
    expect(app.host.checkpoint).toContain('「主人旅居昆明」已被主人明确忘记')
    const forgotten=JSON.parse(await (await request('/api/memories',{id,action:'forget'})).text())
    expect(forgotten.applied).toBe(false);expect(forgotten.record.status).toBe('forgotten')
    expect((await request('/api/memories',{id:'unknown',action:'confirm'})).status).toBe(400)
    const page=await (await request('/')).text()
    expect(page).toContain('memory-area');expect(page).toContain('已确认的记忆')
    expect(page).toContain("action:'forget'")
  } finally {await app.close();rmSync(directory,{recursive:true})}
})

it('记忆工具组：read/correct/forget 经真实桥接落库并立即刷新检查点', async () => {
  // 回合预算为 3 轮模型调用，真实用法是每条指令一个操作：回合 1 read→correct→答复；回合 2 read→forget→答复。
  const { AgentMemories }=await import('../src/main/coordination/memories.js')
  let pendingId=''
  const readResults: string[] = []
  const model: ScopedModel = { complete: async (messages, tools) => {
    expect(tools.some(t=>t.function.name==='read_memories')).toBe(true)
    expect(tools.some(t=>t.function.name==='suggest_memory')).toBe(true)
    const reads=messages.filter(m=>m.role==='tool')
    if (reads.length===0) return { content:null, tool_calls:[{id:'r',type:'function',function:{name:'read_memories',arguments:'{}'}}] }
    // read_memories 的返回必须携带记录 ID/状态，模型据此操作
    readResults.push(String(reads.at(-1)!.content))
    const lastUser=[...messages].reverse().find(m=>m.role==='user'&&typeof m.content==='string'&&(m.content.includes('改成绿色')||m.content.includes('忘记那条')))
    if (lastUser && String(lastUser.content).includes('改成绿色')) {
      if (reads.length===1) return { content:null, tool_calls:[{id:'x',type:'function',function:{name:'correct_memory',arguments:JSON.stringify({id:pendingId,newFact:'主人喜欢绿色'})}}] }
      const op=JSON.parse(reads.at(-1)!.content ?? '{}') as {record:{status:string},applied:boolean}
      expect(op.applied).toBe(true);expect(op.record.status).toBe('confirmed')
      return { content:'已改成绿色' }
    }
    if (reads.length===1) {
      const list=JSON.parse(String(reads[0]!.content)) as Array<{id:string,fact:string,status:string}>
      const green=list.find(r=>r.fact==='主人喜欢绿色')!
      expect(green.status).toBe('confirmed')
      return { content:null, tool_calls:[{id:'f',type:'function',function:{name:'forget_memory',arguments:JSON.stringify({id:green.id})}}] }
    }
    const op=JSON.parse(reads.at(-1)!.content ?? '{}') as {record:{status:string},applied:boolean}
    expect(op.applied).toBe(true);expect(op.record.status).toBe('forgotten')
    return { content:'已忘记' }
  } }
  const app=createCoordinationPreview({model});const directory=app.directory
  try {
    const memories=new AgentMemories(directory)
    pendingId=memories.suggest('主人喜欢蓝色','evt-seed').record.id
    app.host.submit('main','mem-t1','把那条蓝色记忆改成绿色')
    await until(()=>app.store.coordination.history('main').some(m=>m.presentation==='chat'))
    const old=memories.list().find(r=>r.id===pendingId)!
    expect(old.status).toBe('superseded')
    const green=memories.list().find(r=>r.fact==='主人喜欢绿色')!
    // correct 幂等标识与事件来源都由宿主绑定到回合事件，模型入参里没有来源字段
    expect(green.operationId).toBe(`${green.sourceEvent}:${pendingId}:主人喜欢绿色`)
    expect(green.supersedes).toBe(pendingId)
    expect(app.host.checkpoint).toContain('- 主人喜欢绿色')
    expect(app.host.checkpoint).toContain('「主人喜欢蓝色」已被主人更正')
    app.host.submit('main','mem-t2','忘记那条绿色的')
    await until(()=>app.store.coordination.history('main').filter(m=>m.presentation==='chat').length===2)
    expect(memories.list().find(r=>r.fact==='主人喜欢绿色')!.status).toBe('forgotten')
    expect(app.host.checkpoint).not.toContain('- 主人喜欢绿色')
    expect(app.host.checkpoint).toContain('「主人喜欢绿色」已被主人明确忘记')
    expect(readResults.length).toBeGreaterThan(0)
  } finally { await app.close();rmSync(directory,{recursive:true}) }
})

it('记忆操作落库后回合失败用诚实文案：不谎报"未接受新的操作"', async () => {
  // 复现 2026-10-24 线上时序：短 ID 被拒（修正机会）→ read → correct 成功 → 轮次预算耗尽。
  // 操作已落库，回合失败的文案必须承认部分操作可能已生效。
  const { AgentMemories }=await import('../src/main/coordination/memories.js')
  const directory=mkdtempSync('/dev/shm/mem-partial-')
  const owner=new SQLiteMainInboxStore(':memory:',{coordination:{mode:'preview-fresh'}}),s=owner.coordination
  const memories=new AgentMemories(directory)
  const pendingId=memories.suggest('主人喜欢蓝色','evt-seed').record.id
  const sink={ suggest:(f:string,e:string)=>memories.suggest(f,e), read:()=>memories.active(),
    manage:(action:'confirm'|'correct'|'forget',id:string,newFact:string|undefined,operationId:string,sourceEvent:string)=>
      action==='confirm'?memories.confirm(id):action==='correct'?memories.correct(id,newFact!,operationId,sourceEvent):memories.forget(id) }
  const model: ScopedModel = { complete: async messages => {
    const corrected=messages.some(m=>typeof m.content==='string'&&m.content.includes('未通过协议校验'))
    const reads=messages.filter(m=>m.role==='tool')
    if(!corrected)return { content:null, tool_calls:[{id:'bad',type:'function',function:{name:'correct_memory',arguments:JSON.stringify({id:'不存在的记录',newFact:'主人喜欢绿色'})}}] }
    if(reads.length===0)return { content:null, tool_calls:[{id:'r',type:'function',function:{name:'read_memories',arguments:'{}'}}] }
    if(reads.length===1)return { content:null, tool_calls:[{id:'x',type:'function',function:{name:'correct_memory',arguments:JSON.stringify({id:pendingId.slice(0,8),newFact:'主人喜欢绿色'})}}] }
    return { content:'不应到达：轮次预算应先耗尽' }
  } }
  const host=new CoordinationHost(s,model,demoModel(),new HeldFakeExecutor(),undefined,undefined,undefined,true,undefined,sink)
  try {
    host.start();host.submit('main','p-1','把蓝色那条改成绿色')
    await until(()=>s.history('main').some(m=>m.presentation==='chat'))
    const reply=s.history('main').find(m=>m.presentation==='chat')!.content
    // 短 ID 前缀解析生效：纠正实际落库
    expect(memories.list().some(r=>r.fact==='主人喜欢绿色'&&r.status==='confirmed')).toBe(true)
    expect(memories.list().find(r=>r.id===pendingId)!.status).toBe('superseded')
    // 文案诚实：承认部分操作可能已生效，不谎报"未接受新的操作"
    expect(reply).toContain('可能已生效')
    expect(reply).not.toContain('未接受新的操作')
  } finally { await host.close();owner.close();rmSync(directory,{recursive:true}) }
})

it('工作区工具组：主对话可见、群聊不可见；研究流在预算内完成并引用真实文件', async () => {
  const { Workspace }=await import('../src/main/coordination/workspace.js')
  const project=mkdtempSync('/dev/shm/ws-host-')
  writeFileSync(path.join(project,'ROADMAP.md'),'# 路线图\n第二阶段已完成。\n')
  const ws=new Workspace([{name:'proj',path:project,summary:'合成项目',delegable:false}])
  const groupTools: string[][]=[]
  const model: ScopedModel = { complete: async (messages, tools) => {
    const names=tools.map(t=>t.function.name)
    if (messages.some(m=>typeof m.content==='string'&&m.content.includes('群里问'))) { groupTools.push(names); return { content:'好' } }
    expect(names).toEqual(expect.arrayContaining(['list_projects','list_files','read_file','search_files','project_status','task_detail','read_artifact']))
    const reads=messages.filter(m=>m.role==='tool')
    if (reads.length===0) return { content:null, tool_calls:[{id:'lp',type:'function',function:{name:'list_projects',arguments:'{}'}}] }
    if (reads.length===1) return { content:null, tool_calls:[{id:'sf',type:'function',function:{name:'search_files',arguments:JSON.stringify({project:'proj',query:'第二阶段'})}}] }
    if (reads.length===2) return { content:null, tool_calls:[{id:'rf',type:'function',function:{name:'read_file',arguments:JSON.stringify({project:'proj',path:'ROADMAP.md',startLine:'1'})}}] }
    const readResult=String(reads.at(-1)!.content)
    expect(readResult).toContain('第二阶段已完成')
    return { content:'根据 ROADMAP.md：第二阶段已完成。' }
  } }
  const app=createCoordinationPreview({model,workspace:ws})
  const directory=app.directory
  try {
    app.host.submit('main','ws-1','项目进度如何？')
    await until(()=>app.store.coordination.history('main').some(m=>m.presentation==='chat'))
    expect(app.store.coordination.history('main').find(m=>m.presentation==='chat')!.content).toContain('第二阶段已完成')
    // 群聊回合不暴露工作区工具（私人视野不泄入工作群）
    app.host.submit('fake-work','ws-2','群里问问项目')
    await until(()=>app.store.coordination.history('fake-work').length>1)
    expect(groupTools[0]).toBeDefined()
    expect(groupTools[0]!).not.toContain('list_projects')
    expect(groupTools[0]!).not.toContain('read_file')
  } finally { await app.close();rmSync(directory,{recursive:true});rmSync(project,{recursive:true}) }
})

// W3 复核回归：注入工作区后 directory 返回真实项目目录，不再出现 FAKE-project 合成事实。
it('directory 工具：注入工作区后返回真实项目目录', async () => {
  const { Workspace }=await import('../src/main/coordination/workspace.js')
  const project=mkdtempSync('/dev/shm/ws-dir-')
  const ws=new Workspace([{name:'proj',path:project,summary:'合成项目',delegable:false}])
  const model: ScopedModel = { complete: async messages => {
    const reads=messages.filter(m=>m.role==='tool')
    if (reads.length===0) return { content:null, tool_calls:[{id:'d',type:'function',function:{name:'directory',arguments:'{}'}}] }
    const directory=String(reads[0]!.content)
    expect(directory).toContain('"name":"proj"')
    expect(directory).not.toContain('FAKE-project')
    return { content:'当前工作区有 proj 项目。' }
  } }
  const app=createCoordinationPreview({model,workspace:ws})
  try {
    app.host.submit('main','dir-1','看看有哪些项目')
    await until(()=>app.store.coordination.history('main').some(m=>m.presentation==='chat'))
    expect(app.store.coordination.history('main').find(m=>m.presentation==='chat')!.content).toContain('proj')
  } finally { await app.close();rmSync(project,{recursive:true}) }
})

it('task_detail/read_artifact：任务留痕与产物核对（含短 ID 前缀）', async () => {
  const { Workspace }=await import('../src/main/coordination/workspace.js')
  const project=mkdtempSync('/dev/shm/ws-art-')
  const artifactDir=path.join(project,'.agent-artifacts','run-x')
  mkdirSync(artifactDir,{recursive:true})
  writeFileSync(path.join(artifactDir,'stdout.log'),'CLI 输出：已修改 3 个文件\n')
  const ws=new Workspace([{name:'proj',path:project,summary:'合成项目',delegable:true}])
  const owner=new SQLiteMainInboxStore(':memory:',{coordination:{mode:'preview-fresh'}}),s=owner.coordination
  s.allowedProjects=['proj']
  // 铺一条 CLI 任务：admit → accept(cli-task) → claim → 绑定执行留痕 → receipt 完成
  const { event }=s.admit('main','td-1','修复合成问题')
  const accepted=s.accept('main',event.id,{action:'cli-task',objective:'修复合成问题',scope:['project'],project:'proj',completionCriteria:['测试通过']})
  const run=s.claim('fake-work')!
  s.started('fake-work',run.id)
  s.bindExecution('fake-work',run.id,{backend:'kimi',pid:1234,sessionId:null,artifactStdoutPath:path.join(artifactDir,'stdout.log'),artifactStderrPath:path.join(artifactDir,'stderr.log')})
  // 与生产一致：判读前把含退出码的完整留痕补绑进运行记录
  s.bindExecution('fake-work',run.id,{backend:'kimi',pid:1234,sessionId:null,exitCode:0,durationMs:100,artifactStdoutPath:path.join(artifactDir,'stdout.log'),artifactStderrPath:path.join(artifactDir,'stderr.log')})
  s.receipt('fake-work',run.id,{kind:'completed',body:'修复完成',execution:{backend:'kimi',pid:1234,sessionId:null,exitCode:0,durationMs:100,artifactStdoutPath:path.join(artifactDir,'stdout.log'),artifactStderrPath:path.join(artifactDir,'stderr.log')}})
  const model: ScopedModel = { complete: async messages => {
    const reads=messages.filter(m=>m.role==='tool')
    if (reads.length===0) return { content:null, tool_calls:[{id:'t',type:'function',function:{name:'task_detail',arguments:JSON.stringify({id:accepted.assignmentId.slice(0,8)})}}] }
    const detail=String(reads[0]!.content)
    expect(detail).toContain('修复合成问题')
    expect(detail).toContain('"exitCode":0')
    if (reads.length===1) return { content:null, tool_calls:[{id:'a',type:'function',function:{name:'read_artifact',arguments:JSON.stringify({id:accepted.assignmentId.slice(0,8),path:'stdout'})}}] }
    const artifact=String(reads.at(-1)!.content)
    expect(artifact).toContain('已修改 3 个文件')
    return { content:'任务已完成，产物显示修改了 3 个文件。' }
  } }
  const host=new CoordinationHost(s,model,demoModel(),new HeldFakeExecutor(),undefined,undefined,undefined,undefined,undefined,undefined,ws,6)
  try {
    host.start();host.submit('main','td-2','那个任务结果怎样？')
    await until(()=>s.history('main').some(m=>m.presentation==='chat'))
    expect(s.history('main').find(m=>m.presentation==='chat')!.content).toContain('修改了 3 个文件')
  } finally { await host.close();owner.close();rmSync(project,{recursive:true}) }
})
