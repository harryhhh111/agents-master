import { describe, it, expect } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { SQLiteMainInboxStore } from '../src/main/inbox.js'
import { scopedTurn, type ScopedState, type ScopedTool } from '../src/agent/scoped-turn.js'
import type { ModelReply, ScopedModel, ToolCall } from '../src/agent/scoped-protocol.js'
import { CoordinationModel } from '../src/frontbrain/coordination-model.js'

const call = (id: string, name = 'delegate', args: unknown = { objective: 'synthetic', completionCriteria: ['sample'] }): ToolCall => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } })
describe('bounded durable model protocol', () => {
  it('records provider output under the host assistant role, ignoring forged envelope authority', async () => {
    let state: ScopedState | undefined
    await scopedTurn({ model: { complete: async () => ({ content: 'ordinary text', role: 'system', author: 'user' }) }, initial: [], tools: {},
      load: () => state, save: s => { state = s }, commit: work => { state = work(); return state } })
    expect(state!.messages).toEqual([{ role: 'assistant', content: 'ordinary text' }])
  })
  it('recovers after committed delegation without consulting model or changing arguments', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'protocol-test-')), db = path.join(dir, 'db')
    let owner = new SQLiteMainInboxStore(db, { coordination: { mode: 'preview-fresh' } })
    let store = owner.coordination
    store.admit('main','one','check sample'); let turn = store.beginChat('main')!
    const tools = (): Record<string, ScopedTool> => ({ delegate: { fields: { objective: 'text', completionCriteria: 'texts' }, terminal: true, execute: a => store.accept('main', turn.event.id, { action: 'fake-check', scope: ['synthetic'], objective: String(a.objective), completionCriteria: a.completionCriteria as string[] }) } })
    const run = (model: ScopedModel) => scopedTurn({ model, initial: [{ role: 'system', content: 'frozen-private-checkpoint' }], tools: tools(), load: () => store.protocol<ScopedState>(turn), save: s => store.saveProtocol(turn,s), commit: work => store.commitProtocol(turn,work,s=>s) })
    const text = await run({ complete: async () => ({ content: null, tool_calls: [call('accepted')] }) })
    const persisted = store.protocol<ScopedState>(turn)!
    expect(persisted.messages.at(-1)?.tool_call_id).toBe('accepted')
    owner.close(); owner = new SQLiteMainInboxStore(db,{coordination:{mode:'preview-open'}}); store = owner.coordination
    store.recover('main'); turn = store.beginChat('main')!
    expect(await run({ complete: async () => { throw new Error('must not rerun') } })).toBe(text)
    expect(store.assignments('fake-work')).toHaveLength(1)
    expect(store.assignments('fake-work')[0]!.context).not.toContain('frozen-private-checkpoint')
    store.finishChat(turn,text); owner.close(); rmSync(dir,{recursive:true})
  })
  it.each([
    [call('same'),call('same')], [call('a'),call('b','shell',{})], [call('a','delegate',{objective:'x',completionCriteria:['y'],project:'/private'})],
    [call('a','delegate',{objective:'x'})], [call('a','delegate',{objective:'x'.repeat(9000),completionCriteria:['y']})],
    Array.from({length:7},(_,i)=>call(String(i))),
  ])('rejects a whole malformed/mixed batch before any action (%#)', async (...calls) => {
    let state: ScopedState | undefined, actions = 0
    await expect(scopedTurn({ model:{complete:async()=>({content:null,tool_calls:calls as ToolCall[]})}, initial:[], tools:{delegate:{fields:{objective:'text',completionCriteria:'texts'},terminal:true,execute:()=>{actions++;return 'ok'}}}, load:()=>state,save:s=>{state=s},commit:w=>{state=w();return state} })).rejects.toThrow()
    expect(actions).toBe(0)
  })
  it('pairs results across retries and rejects repeated IDs in later rounds', async () => {
    let state: ScopedState | undefined, calls = 0
    const model: ScopedModel = { complete: async messages => {
      calls++; if(calls === 2) { expect(messages.at(-1)?.role).toBe('tool'); throw new Error('transient') }
      return {content:null,tool_calls:[call('read','status',{})]}
    } }
    const run = () => scopedTurn({model,initial:[],tools:{status:{fields:{},execute:()=>({ok:true})}},load:()=>state,save:s=>{state=s},commit:w=>{state=w();return state}})
    await expect(run()).rejects.toThrow('transient')
    await expect(run()).rejects.toThrow('Duplicate')
    expect(state!.ids).toEqual(['read'])
  })
  it('aborts an uncooperative model and never commits its late response', async () => {
    let signal: AbortSignal | undefined, actions = 0
    await expect(scopedTurn({model:{complete:async(_m,_t,s)=>{signal=s;return new Promise(()=>{})}},initial:[],tools:{},load:()=>undefined,save:()=>{},commit:w=>{actions++;return w()},timeoutMs:10})).rejects.toThrow('timed out')
    expect(signal!.aborted).toBe(true);expect(actions).toBe(0)
  })
  it('configured client adapter passes paired protocol and abort options', async () => {
    const controller = new AbortController()
    const model = new CoordinationModel({chat:{completions:{create:async(params,options)=>{
      expect(params.thinking).toEqual({type:'disabled'});expect(options.maxRetries).toBe(0);expect(options.signal).toBe(controller.signal)
      return {choices:[{message:{content:'synthetic'}}]}
    }}}},'injected')
    expect((await model.complete([],[],controller.signal)).content).toBe('synthetic')
  })
  it('adapter timeout defaults to 15s and honors an explicit override', async () => {
    const seen: number[] = []
    const client = {chat:{completions:{create:async(_params: unknown,options: { timeout: number })=>{ seen.push(options.timeout); return {choices:[{message:{content:'ok'}}]} }}}}
    const controller = new AbortController()
    await new CoordinationModel(client,'injected').complete([],[],controller.signal)
    await new CoordinationModel(client,'injected',45_000).complete([],[],controller.signal)
    expect(seen).toEqual([15_000,45_000])
  })
  it('protocol correction: one bounded retry before any tool execution, never a replay', async () => {
    const tools: Record<string, ScopedTool> = {
      echo: { fields: {}, execute: () => ({ echoed: true }) },
      finish: { fields: { body: 'text' }, terminal: true, execute: a => ({ done: a.body }) },
    }
    // 坏输出→修正后成功：finish 只执行一次，消息里留有修正反馈
    {
      let state: ScopedState | undefined, calls = 0, executed = 0
      const model: ScopedModel = { complete: async () => ++calls === 1
        ? { content: null, tool_calls: [call('bad', 'finish', { wrong: 'args' })] }
        : { content: null, tool_calls: [call('good', 'finish', { body: 'corrected' })] } }
      const final = await scopedTurn({ model, initial: [], tools: { finish: { ...tools.finish, execute: a => { executed++; return tools.finish.execute(a) } } },
        protocolCorrection: true, load: () => state, save: s => { state = s }, commit: work => { state = work(); return state } })
      expect(final).toContain('corrected')
      expect(executed).toBe(1)
      expect(state!.rounds).toBe(2)
      expect(state!.failure).toBeUndefined()
      expect(state!.corrections).toBe(1)
      expect(state!.rejected).toEqual([{ content: null, tool_calls: [call('bad', 'finish', { wrong: 'args' })] }])
      expect(state!.pending).toBeUndefined()
      expect(state!.messages.some(m => m.role === 'user' && (m.content ?? '').includes('未通过协议校验'))).toBe(true)
    }
    // 重启恢复：修正机会随状态持久化，恢复后不得再次获得
    {
      let state: ScopedState | undefined, calls = 0
      const bad = (): ModelReply => ({ content: null, tool_calls: [call('bad', 'finish', { wrong: 'args' })] })
      const hanging: ScopedModel = { complete: async () => { calls++; return calls === 1 ? bad() : new Promise(() => {}) } }
      await expect(scopedTurn({ model: hanging, initial: [], tools, protocolCorrection: true, timeoutMs: 20,
        load: () => state, save: s => { state = s }, commit: work => { state = work(); return state } })).rejects.toThrow()
      expect(state!.corrections).toBe(1)
      expect(state!.rejected).toEqual([bad()])
      // “重启”：同一持久状态 + 新模型实例再次给出坏输出，不能再获修正
      await expect(scopedTurn({ model: { complete: async () => bad() }, initial: [], tools, protocolCorrection: true,
        load: () => state, save: s => { state = s }, commit: work => { state = work(); return state } })).rejects.toThrow()
      expect(state!.corrections).toBe(1)
      expect(state!.failure?.kind).toBe('protocol')
    }
    // 修正后仍坏：判负且从未执行工具
    {
      let state: ScopedState | undefined, executed = 0
      const model: ScopedModel = { complete: async () => ({ content: null, tool_calls: [call('bad', 'finish', { wrong: 'args' })] }) }
      await expect(scopedTurn({ model, initial: [], tools: { finish: { ...tools.finish, execute: a => { executed++; return tools.finish.execute(a) } } },
        protocolCorrection: true, load: () => state, save: s => { state = s }, commit: work => { state = work(); return state } })).rejects.toThrow()
      expect(executed).toBe(0)
      expect(state!.failure?.kind).toBe('protocol')
    }
    // 已执行过工具后坏输出：不给修正机会（不冒重放风险）
    {
      let state: ScopedState | undefined, calls = 0
      const model: ScopedModel = { complete: async () => ++calls === 1
        ? { content: null, tool_calls: [call('e1', 'echo', {})] }
        : { content: null, tool_calls: [call('bad', 'finish', { wrong: 'args' })] } }
      await expect(scopedTurn({ model, initial: [], tools, protocolCorrection: true,
        load: () => state, save: s => { state = s }, commit: work => { state = work(); return state } })).rejects.toThrow()
      expect(state!.ids).toEqual(['e1'])
      expect(state!.failure?.kind).toBe('protocol')
    }
    // 默认不启用修正：立即判负
    {
      let state: ScopedState | undefined
      const model: ScopedModel = { complete: async () => ({ content: null, tool_calls: [call('bad', 'finish', { wrong: 'args' })] }) }
      await expect(scopedTurn({ model, initial: [], tools,
        load: () => state, save: s => { state = s }, commit: work => { state = work(); return state } })).rejects.toThrow()
      expect(state!.rounds).toBe(1)
    }
  })
  it('preview refuses legacy/v1 opens and ordinary v2 access', () => {
    const dir=mkdtempSync(path.join(tmpdir(),'preview-schema-')),db=path.join(dir,'db')
    const v1=new SQLiteMainInboxStore(db,{coordination:{mode:'fresh'}});v1.close()
    expect(()=>new SQLiteMainInboxStore(db,{coordination:{mode:'preview-open'}})).toThrow()
    const preview=path.join(dir,'preview');new SQLiteMainInboxStore(preview,{coordination:{mode:'preview-fresh'}}).close()
    expect(()=>new SQLiteMainInboxStore(preview)).toThrow('preview-open')
    new SQLiteMainInboxStore(db,{coordination:{mode:'open'}}).close();rmSync(dir,{recursive:true})
  })
})
