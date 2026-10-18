import { it, expect } from 'vitest'
import { ScopedDomainExecutor } from '../src/agent/scoped-domain.js'
import type { Run } from '../src/main/coordination/store.js'
it('domain adapter exposes only inspect/ask/finish with per-run frozen context', async () => {
  const executor = new ScopedDomainExecutor({complete:async(messages,tools)=>{
    expect(tools.map(t=>t.function.name)).toEqual(['synthetic_inspect','ask','finish'])
    expect(messages).toHaveLength(2);expect(messages[1]!.content).toBe('group-only')
    return {content:null,tool_calls:[{id:'q',type:'function',function:{name:'ask',arguments:'{"body":"synthetic question"}'}}]}
  }})
  expect(await executor.execute({id:'r',context:'group-only'} as Run)).toEqual({kind:'waiting_input',body:'synthetic question'})
})
