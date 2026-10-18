import { it, expect, vi } from 'vitest'
import { mkdtempSync, rmSync, readdirSync, mkdirSync } from 'node:fs'
import { createContext, runInContext } from 'node:vm'
import { SQLiteMainInboxStore } from '../src/main/inbox.js'
import { CoordinationHost } from '../src/main/coordination/model-host.js'
import { HeldFakeExecutor } from '../src/main/coordination/fake.js'
import { createCoordinationPreview } from '../scripts/main-web-coordination.js'
import { saveOwnerContext } from '../src/main/owner-context.js'
import { demoModel } from '../scripts/main-web-coordination-demo.js'
import { coordinationCardsScript } from '../src/main/coordination/web-page.js'
import { safeFailedTurn, type ScopedState } from '../src/agent/scoped-turn.js'
import type { ModelReply, ScopedModel } from '../src/agent/scoped-protocol.js'

// Hoisted module trap: importing the synthetic composition must not evaluate
// dotenv at all, regardless of the verification process's dotenv path guard.
vi.mock('dotenv/config', () => { throw new Error('Synthetic import evaluated dotenv/config') })

vi.mock('node:fs', async original => {
  const fs = await original<typeof import('node:fs')>()
  return { ...fs, lstatSync: (...args: Parameters<typeof fs.lstatSync>) => {
    if (String(args[0]) === '/tmp/.git') throw Object.assign(new Error('fixture marker'), { code: 'ENOENT' })
    return fs.lstatSync(...args)
  } }
})
const until = async (condition: () => boolean) => { for (let i=0;i<200;i++){if(condition())return;await new Promise(r=>setTimeout(r,5))}throw new Error('condition timeout') }
const textModel: ScopedModel = { complete: async () => ({ content: '普通澄清：请确认范围' }) }

it('ordinary group clarification is text only; explicit group delegate and answer use trusted binding', async () => {
  let turns=0
  const model: ScopedModel={complete:async(_messages,tools)=>{
    expect(tools.map(t=>t.function.name)).toEqual(['directory','status','delegate','answer','cancel'])
    return ++turns===1 ? {content:'你想检查哪个合成样本？'} : {content:null,tool_calls:[{id:'group-delegate',type:'function',function:{name:'delegate',arguments:'{"objective":"样本 A","completionCriteria":["模拟证据"]}'}}]}
  }}
  const app=createCoordinationPreview({model:textModel,domainModel:model,executor:{identity:'FAKE',execute:async run=>({kind:run.input_version===1?'waiting_input':'completed',body:'合成问题/结果'})}})
  try {
    app.host.submit('fake-work','clarify','看看这个');await until(()=>app.store.coordination.history('fake-work').some(m=>m.presentation==='chat'))
    expect(app.store.coordination.assignments('fake-work')).toHaveLength(0)
    app.host.submit('fake-work','delegate','检查样本 A');await until(()=>app.store.coordination.questions('fake-work').length===1)
    const s=app.store.coordination,q=s.questions('fake-work')[0]!
    expect(s.assignments('fake-work')).toHaveLength(1)
    s.control('fake-work','answer','A','answer',q.id);app.host.pump()
    await until(()=>s.assignments('fake-work')[0]!.status==='completed')
    expect(s.questions('fake-work')[0]!.answer).toBe('A')
  } finally { await app.close();rmSync(app.directory,{recursive:true}) }
})

it('idle and held background pumps emit no invalidation storm', async () => {
  const owner=new SQLiteMainInboxStore(':memory:',{coordination:{mode:'preview-fresh'}}), fake=new HeldFakeExecutor();let changes=0
  const host=new CoordinationHost(owner.coordination,demoModel(),textModel,fake,()=>{changes++})
  try {host.start();for(let i=0;i<100;i++)host.pump();expect(changes).toBe(0)
    host.submit('main','work','sample');await until(()=>fake.started.length===1)
    const count=changes;for(let i=0;i<100;i++)host.pump();expect(changes).toBe(count)
  } finally {await host.close();owner.close()}
})

it.each([
  {content:null,tool_calls:[{id:'bad',type:'function',function:{name:'delegate',arguments:'{"objective":"missing criteria"}'}}]},
  {content:null,tool_calls:[{id:'bad',type:'function',function:{name:'ask',arguments:'{"body":"clarify"}'}}]},
  null,
])('invalid terminal protocol completes safely, preserves evidence, and cannot poison/reexecute on retry (%#)',async bad=>{
  const owner=new SQLiteMainInboxStore(':memory:',{coordination:{mode:'preview-fresh'}}),s=owner.coordination;let calls=0
  const host=new CoordinationHost(s,{complete:async()=>++calls===1?bad as ModelReply:{content:'next turn works'}},textModel,new HeldFakeExecutor())
  try {
    const input=s.admit('main','bad','request');host.start()
    await until(()=>s.history('main').some(m=>m.content===safeFailedTurn))
    const state=s.protocol<ScopedState>({conversation:'main',event:input.event,context:[]})!
    expect(state.failure?.kind).toBe('protocol');expect(state.rounds).toBe(1);expect(state.pending).toEqual(bad)
    host.retry('main');await new Promise(r=>setTimeout(r,30));expect(calls).toBe(1)
    host.submit('main','good','new input');await until(()=>s.history('main').some(m=>m.content==='next turn works'))
    expect(s.assignments('fake-work')).toHaveLength(0);expect(host.status('main')).toBe('idle')
  } finally {await host.close();owner.close()}
})

it('transient provider retry preserves attempt budget and releases conversation after three failures',async()=>{
  const owner=new SQLiteMainInboxStore(':memory:',{coordination:{mode:'preview-fresh'}}),s=owner.coordination;let calls=0
  const host=new CoordinationHost(s,{complete:async()=>{if(++calls<=3)throw Object.assign(new Error('synthetic transient'),{status:503});return {content:'after failure'}}},textModel,new HeldFakeExecutor())
  try {
    const input=s.admit('main','fail','request');host.start();await until(()=>host.status('main')==='blocked')
    host.retry('main');await until(()=>calls===2&&host.status('main')==='blocked')
    host.retry('main');await until(()=>s.history('main').some(m=>m.content===safeFailedTurn))
    host.retry('main');expect(calls).toBe(3)
    expect(s.protocol<ScopedState>({conversation:'main',event:input.event,context:[]})!.rounds).toBe(3)
    host.submit('main','next','continue');await until(()=>calls===4);expect(host.status('main')).not.toBe('blocked')
  } finally {await host.close();owner.close()}
})

it('saved owner checkpoint grounds main after reopen, never group or group-addressed main',async()=>{
  let app=createCoordinationPreview({model:textModel});const dir=app.directory
  const mainInputs:string[]=[],domainInputs:string[]=[]
  try {
    saveOwnerContext(dir,'PRIVATE_SYNTHETIC_OWNER_ONLY')
    await app.close()
    app=createCoordinationPreview({reopen:dir,model:{complete:async m=>{mainInputs.push(JSON.stringify(m));return {content:'main reply'}}},domainModel:{complete:async m=>{domainInputs.push(JSON.stringify(m));return {content:'group reply'}}}})
    app.host.submit('main','main','hello');await until(()=>mainInputs.length===1)
    app.host.submit('fake-work','group','hello');await until(()=>domainInputs.length===1)
    app.host.submit('fake-work','mention','@main hello');await until(()=>mainInputs.length===2)
    expect(mainInputs[0]).toContain('PRIVATE_SYNTHETIC_OWNER_ONLY')
    expect(mainInputs[1]).not.toContain('PRIVATE_SYNTHETIC_OWNER_ONLY');expect(domainInputs[0]).not.toContain('PRIVATE_SYNTHETIC_OWNER_ONLY')
  } finally {await app.close();rmSync(dir,{recursive:true})}
})

it('constructor failure cleans only the newly created directory and leaves parent content',()=>{
  const parent=mkdtempSync('/tmp/preview-failure-');mkdirSync(parent+'/.git')
  try {expect(()=>createCoordinationPreview({model:textModel,newDirectoryParent:parent})).toThrow('outside a Git')
    expect(readdirSync(parent)).toEqual(['.git'])
  } finally {rmSync(parent,{recursive:true})}
})

it('background interrupted run is unknown after reopen, never replayed; previous committed question survives',async()=>{
  const held=new HeldFakeExecutor();let app=createCoordinationPreview({model:demoModel(),executor:held});const dir=app.directory
  try {
    app.host.submit('main','wait','first');await until(()=>held.started.length===1)
    held.finish(held.started[0]!.id,{kind:'waiting_input',body:'Original durable question'})
    await until(()=>app.store.coordination.questions('fake-work').length===1)
    const q=app.store.coordination.questions('fake-work')[0]!
    app.host.submit('main','interrupt','second');await until(()=>held.started.length===2)
    const interrupted=held.started[1]!.id;await app.close()
    const restarted=new HeldFakeExecutor();app=createCoordinationPreview({reopen:dir,model:demoModel(),executor:restarted})
    for(let i=0;i<10;i++)app.host.pump()
    expect(restarted.started).toHaveLength(0)
    expect(app.store.coordination.runs('fake-work').find(r=>r.id===interrupted)!.status).toBe('unknown')
    expect(app.store.coordination.questions('fake-work')[0]).toMatchObject({id:q.id,body:'Original durable question',status:'pending'})
    // An obsolete completion from the closed scheduler cannot mutate reopened state.
    held.finish(interrupted,{kind:'completed',body:'late completion'});await Promise.resolve()
    expect(app.store.coordination.runs('fake-work').find(r=>r.id===interrupted)!.status).toBe('unknown')
  } finally {await app.close();rmSync(dir,{recursive:true})}
})

it('answer DOM nodes, drafts and focus survive unchanged/changed polls and conversation switches',()=>{
  let active: Element | undefined
  class Element {
    children:Element[]=[];dataset:Record<string,string>={};value='';textContent='';parent?:Element;selectionStart=0;selectionEnd=0;oninput?:()=>void
    append(...nodes:Element[]){for(const n of nodes){n.parent=this;this.children.push(n)}}
    replaceChildren(){this.children=[];active=undefined}
    remove(){if(this.parent)this.parent.children=this.parent.children.filter(n=>n!==this);if(active===this)active=undefined}
    focus(){active=this} setSelectionRange(a:number,b:number){this.selectionStart=a;this.selectionEnd=b} setAttribute(){}
  }
  const root=new Element(),document={get activeElement(){return active},createElement:()=>new Element(),querySelector:()=>root}
  const context=createContext({document,control:()=>{}})
  runInContext("let conversation='main',cardSnapshot='';"+coordinationCardsScript,context)
  const render=(status='running')=>runInContext(`renderCards({assignments:[{id:'a',status:'${status}'}],questions:[{id:'q',body:'question',status:'pending'}]})`,context)
  render();let field=root.children[1]!.children[1]!
  field.value='正在输入的回答';field.oninput!();field.focus();field.setSelectionRange(2,4)
  render();render();expect(root.children[1]!.children[1]).toBe(field)
  render('waiting_input');expect(active).toBe(field);expect(field.value).toBe('正在输入的回答');expect(field.selectionStart).toBe(2)
  runInContext("rememberAnswerFocus();conversation='fake-work';cardSnapshot='';document.querySelector('#coordination-cards').replaceChildren()",context);render()
  expect(root.children[1]!.children[1]!.value).toBe('')
  runInContext("conversation='main';cardSnapshot='';document.querySelector('#coordination-cards').replaceChildren()",context);render()
  field=root.children[1]!.children[1]!
  expect(field.value).toBe('正在输入的回答');expect(active).toBe(field);expect(field.selectionStart).toBe(2)
})

it('accepted tool survives reply-commit failure; explicit retry never changes decision or repeats model',async()=>{
  let fail=true,calls=0
  const owner=new SQLiteMainInboxStore(':memory:',{coordination:{mode:'preview-fresh'},coordinationFault:point=>{if(point==='front.message'&&fail){fail=false;throw new Error('synthetic reply commit failure')}}}),s=owner.coordination
  const model=demoModel(),host=new CoordinationHost(s,{complete:async(...args)=>{calls++;return model.complete(...args)}},textModel,new HeldFakeExecutor())
  try {
    host.submit('main','one','sample');await until(()=>host.status('main')==='blocked')
    expect(s.assignments('fake-work')).toHaveLength(1)
    host.retry('main');await until(()=>s.history('main').some(m=>m.presentation==='chat'))
    expect(calls).toBe(1);expect(s.assignments('fake-work')).toHaveLength(1)
    expect(s.history('main').find(m=>m.presentation==='chat')!.content).toContain('已记录受限操作')
  }finally{await host.close();owner.close()}
})

it('actual scoped domain adapter aborts on shutdown; interrupted model call is never resumed',async()=>{
  let domainCalls=0
  const model:ScopedModel={complete:async()=>{
    domainCalls++
    if(domainCalls===1)return {content:null,tool_calls:[{id:'question',type:'function',function:{name:'ask',arguments:'{"body":"Preserved actual domain question"}'}}]}
    return new Promise(()=>{})
  }}
  let app=createCoordinationPreview({model:demoModel(),domainModel:model});const dir=app.directory
  try {
    app.host.submit('main','first','sample');await until(()=>app.store.coordination.questions('fake-work').length===1)
    app.host.submit('main','second','sample');await until(()=>domainCalls===2)
    await app.close();app=createCoordinationPreview({reopen:dir,model:demoModel(),domainModel:model})
    for(let i=0;i<20;i++)app.host.pump()
    expect(domainCalls).toBe(2)
    expect(app.store.coordination.questions('fake-work')[0]!.body).toBe('Preserved actual domain question')
    expect(app.store.coordination.runs('fake-work').map(r=>r.status)).toEqual(['succeeded','unknown'])
  }finally{await app.close();rmSync(dir,{recursive:true})}
})
