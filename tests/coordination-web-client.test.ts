import { it, expect } from 'vitest'
import { randomUUID } from 'node:crypto'
import { createContext, runInContext } from 'node:vm'
import { coordinationPage } from '../src/main/coordination/web-page.js'

/** 在 node:vm 中用真实生成的整页脚本驱动最小 DOM stub，覆盖复核 U1/U2/U3：
 *  在途提交归位来源会话（延迟成功/确定拒绝/网络失败 + 自由切换）、
 *  待办定位真实调用 scrollIntoView、已就位卡片不重挂载保焦点、异常横幅按会话隔离。 */

const clientScript = coordinationPage().split('<script>')[1]!.split('</script>')[0]!

interface FetchCall {
  url: string
  options?: { method?: string; body?: string }
  resolve: (response: unknown) => void
  reject: (error: unknown) => void
}

function makeHarness() {
  let activeEl: StubEl | undefined
  class StubEl {
    children: StubEl[] = []
    parentNode?: StubEl
    dataset: Record<string, string> = {}
    style: Record<string, unknown> = {}
    className = ''
    hidden = false
    disabled = false
    value = ''
    textContent = ''
    placeholder = ''
    autocomplete = ''
    open = false
    title = ''
    status = ''
    selectionStart = 0
    selectionEnd = 0
    scrollTop = 0
    scrollHeight = 0
    clientHeight = 600
    clientWidth = 800
    appendCalls = 0
    scrollIntoViewCalls: unknown[] = []
    listeners: Record<string, Array<(event?: unknown) => unknown>> = {}
    classList = { add: () => {}, remove: () => {}, contains: () => false }
    field?: StubEl | null
    button?: StubEl | null
    titleEl?: StubEl
    metaEl?: StubEl
    bodyEl?: StubEl
    oninput?: () => void
    onclick?: () => void
    constructor(public tag = 'div') {}
    addEventListener(type: string, fn: (event?: unknown) => unknown): void { (this.listeners[type] ??= []).push(fn) }
    fire(type: string, event?: unknown): void { for (const fn of this.listeners[type] ?? []) fn(event) }
    contains(node: StubEl): boolean { return this.children.includes(node) || this.children.some(child => child.contains(node)) }
    append(...nodes: StubEl[]): void { this.appendCalls++; for (const node of nodes) { node.remove(); node.parentNode = this; this.children.push(node) } }
    replaceChildren(): void { for (const node of this.children) node.parentNode = undefined; this.children = []; if (activeEl && this.contains(activeEl)) activeEl = undefined }
    remove(): void {
      if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(node => node !== this)
      this.parentNode = undefined
      if (activeEl && (activeEl === this || this.contains(activeEl))) activeEl = undefined
    }
    focus(): void { activeEl = this }
    setSelectionRange(start: number, end: number): void { this.selectionStart = start; this.selectionEnd = end }
    setAttribute(): void {}
    scrollIntoView(options?: unknown): void { this.scrollIntoViewCalls.push(options) }
  }
  const byId = new Map<string, StubEl>()
  const el = (id: string): StubEl => {
    let element = byId.get(id)
    if (!element) { element = new StubEl('div'); byId.set(id, element) }
    return element
  }
  const document = {
    get activeElement() { return activeEl },
    createElement: (tag: string) => new StubEl(tag),
    querySelector: (selector: string) => (selector.startsWith('#') ? el(selector.slice(1)) : undefined),
    body: new StubEl('body'),
  }
  const fetchCalls: FetchCall[] = []
  let hold: (url: string) => boolean = () => false
  const defaultBody = (url: string): unknown => {
    const path = url.split('?')[0]
    if (path === '/api/auth') return { configured: true, authenticated: true }
    if (path === '/api/history') return { messages: [], cursor: 0 }
    if (path === '/api/owner-context') return { content: '' }
    if (path === '/api/status') return { state: 'idle', assignments: [], questions: [] }
    if (path === '/api/conversations') return { conversations: [{ id: 'main', pinned: true }, { id: 'fake-work', synthetic: true }] }
    return {}
  }
  const fetchStub = (url: string, options?: { method?: string; body?: string }): Promise<unknown> => new Promise((resolve, reject) => {
    fetchCalls.push({ url, options, resolve, reject })
    if (!hold(url)) resolve({ status: 200, ok: true, json: async () => defaultBody(url) })
  })
  const context = createContext({
    document,
    fetch: fetchStub,
    window: { addEventListener: () => {}, visualViewport: undefined },
    location: { hash: '', pathname: '/preview/', search: '' },
    history: { replaceState: () => {} },
    sessionStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    EventSource: class { constructor(public url: string) {} close() {} addEventListener() {} },
    confirm: () => true,
    crypto: { randomUUID },
    // 轮询定时器在 harness 中不点火；需要的刷新由测试显式调用。
    setTimeout: () => 0,
    clearTimeout: () => {},
    URLSearchParams,
    AbortSignal,
  })
  runInContext(clientScript, context)
  const run = <T = unknown>(code: string): T => runInContext(code, context) as T
  const settle = async (rounds = 60): Promise<void> => { for (let i = 0; i < rounds; i++) await Promise.resolve() }
  const bannerText = (): string => run("Array.from(document.querySelector('#control-banner').children).map(p=>p.textContent).join('|')")
  return {
    run, settle, el, fetchCalls, bannerText,
    setHold: (fn: (url: string) => boolean) => { hold = fn },
    activeElement: () => activeEl,
    async switchTo(conversation: string) { run(`switchConversation('${conversation}')`); await settle(); run('stopPolling()') },
  }
}

async function settledHarness() {
  const harness = makeHarness()
  await harness.settle()
  harness.run('stopPolling()')
  return harness
}

it('U1 延迟发送成功：切换视图不丢结果，来源会话草稿清空，不会以新幂等键二次提交', async () => {
  const h = await settledHarness()
  await h.switchTo('fake-work')
  h.el('message').value = '延迟发送'
  h.setHold(url => url.includes('/api/messages'))
  h.run('void send()')
  const sendCall = h.fetchCalls.find(call => call.url.includes('/api/messages'))!
  expect(sendCall.url).toContain('conversation=fake-work')
  const firstKey = JSON.parse(sendCall.options!.body!).idempotencyKey
  // 在途切走：离开检查覆盖所有会话的在途发送
  await h.switchTo('main')
  expect(h.run('leaveBlock()')).toContain('发送尚未确认')
  // 迟到的 202 归位来源会话：来源草稿与失败列表都被清理
  sendCall.resolve({ status: 202, ok: true, json: async () => ({}) })
  await h.settle()
  expect(h.run("leaveBlock()")).toBeUndefined()
  expect(h.run("drafts.get('fake-work').text")).toBe('')
  expect(h.run("drafts.get('fake-work').failed")).toHaveLength(0)
  // 回到来源会话：输入框已清空，再点发送不产生第二次提交
  await h.switchTo('fake-work')
  expect(h.el('message').value).toBe('')
  h.run('void send()')
  const sends = h.fetchCalls.filter(call => call.url.includes('/api/messages'))
  expect(sends).toHaveLength(1)
  expect(JSON.parse(sends[0]!.options!.body!).idempotencyKey).toBe(firstKey)
})

it('U1+U3 延迟确定拒绝：切走不丢 409 原因，横幅只挂在来源会话，侧栏警示点独立', async () => {
  const h = await settledHarness()
  await h.switchTo('fake-work')
  h.run("void(globalThis.testButton=document.createElement('button'))")
  h.setHold(url => url.includes('/api/control'))
  h.run("void control('answer','q1','A',globalThis.testButton)")
  const controlCall = h.fetchCalls.find(call => call.url.includes('/api/control'))!
  expect(controlCall.url).toContain('conversation=fake-work')
  await h.switchTo('main')
  expect(h.run('leaveBlock()')).toContain('提交尚未确认')
  controlCall.resolve({ status: 409, ok: false, json: async () => ({ error: 'fixture refusal' }) })
  await h.settle()
  expect(h.run('rejectedControls.size')).toBe(1)
  // U3：当前在主聊，群聊的拒绝不出现在主聊横幅
  expect(h.bannerText()).toBe('')
  expect(h.el('control-banner').hidden).toBe(true)
  // 侧栏警示点仍标记来源会话（pollSidebar 周期计算）
  await h.run<Promise<void>>('pollSidebar(viewGeneration)')
  await h.settle()
  expect(h.run("convState.get('fake-work').warn")).toBe(true)
  expect(h.run("convState.get('main').warn")).toBe(false)
  // 全局 dirty 检查仍覆盖其他会话
  expect(h.run('leaveDirty()')).toBe(true)
  // 回到来源会话：拒绝原因横幅保留
  await h.switchTo('fake-work')
  expect(h.bannerText()).toContain('已确定被拒绝：fixture refusal')
})

it('U1+U3 网络失败：未确认归位来源会话，横幅按会话隔离且不被轮询清空', async () => {
  const h = await settledHarness()
  await h.switchTo('fake-work')
  h.run("void(globalThis.testButton=document.createElement('button'))")
  h.setHold(url => url.includes('/api/control'))
  h.run("void control('cancel','a1','请求取消模拟任务',globalThis.testButton)")
  const controlCall = h.fetchCalls.find(call => call.url.includes('/api/control'))!
  await h.switchTo('main')
  controlCall.reject(new Error('network down'))
  await h.settle()
  expect(h.run('uncertainControls.size')).toBe(1)
  expect(h.bannerText()).toBe('')
  await h.switchTo('fake-work')
  expect(h.bannerText()).toContain('是否送达未知（可重试，相同提交不会重复执行）')
  // 轮询渲染不清空未确认提示
  h.run('renderState()')
  expect(h.bannerText()).toContain('是否送达未知')
  expect(h.run('leaveDirty()')).toBe(true)
})

it('U2 待办定位：parentNode 语义下点击「待办 n」真实调用 scrollIntoView', async () => {
  const h = await settledHarness()
  await h.switchTo('fake-work')
  // 锚消息未加载：未完成卡片归入待办区
  h.run("renderCards({assignments:[{id:'a1',status:'waiting_input'}],questions:[{id:'q1',assignment_id:'a1',run_id:'r1',body:'问题',status:'pending'}],execution:'synthetic'})")
  const todo = h.el('todo-area')
  expect(h.run("cardNodes.get('q:q1').parentNode===document.querySelector('#todo-area')")).toBe(true)
  expect(todo.hidden).toBe(false)
  expect(h.el('todo-jump').textContent).toBe('待办 2')
  h.el('todo-jump').fire('click')
  // 定位到第一张未完成卡片（任务卡先于问题卡插入）
  expect(h.run("cardNodes.get('a:a1').scrollIntoViewCalls.length")).toBe(1)
  expect(h.run("cardNodes.get('a:a1').scrollIntoViewCalls[0].block")).toBe('center')
})

it('U2 已就位卡片不重挂载：新消息触发 placeCards 时回答框焦点保留', async () => {
  const h = await settledHarness()
  await h.switchTo('fake-work')
  h.run("renderCards({assignments:[{id:'a1',status:'waiting_input'}],questions:[{id:'q1',assignment_id:'a1',run_id:'r1',body:'问题',status:'pending'}],execution:'synthetic'})")
  // 锚消息到达：卡片移入消息流
  h.run(`(()=>{const flow=document.querySelector('#messages');
    const dispatch=document.createElement('div');dispatch.dataset.presentation='dispatch';dispatch.dataset.assignmentId='a1';dispatch.dataset.objective='样本';flow.append(dispatch);
    const receipt=document.createElement('div');receipt.dataset.presentation='receipt';receipt.dataset.assignmentId='a1';receipt.dataset.runId='r1';flow.append(receipt);
    placeCards()})()`)
  const anchor = h.el('messages').children[1]!
  expect(h.run("cardNodes.get('q:q1').parentNode===document.querySelector('#messages').children[1]")).toBe(true)
  const field = h.run("cardNodes.get('q:q1').field") as { focus(): void; value: string; oninput?: () => void }
  field.value = '正在输入的回答'
  field.oninput?.()
  field.focus()
  const appendsBefore = anchor.appendCalls
  // 新消息到来路径再次定位：已就位的卡片保持原样，焦点与草稿不受影响
  h.run('placeCards()')
  expect(anchor.appendCalls).toBe(appendsBefore)
  expect(h.run("cardNodes.get('q:q1').parentNode===document.querySelector('#messages').children[1]")).toBe(true)
  expect(h.activeElement()).toBe(field)
  expect(field.value).toBe('正在输入的回答')
})


it('U1-a 跨登录：旧请求结束不误清新登录的同会话在途占用，旧 401 不踢掉新登录', async () => {
  const h = await settledHarness()
  await h.switchTo('fake-work')
  h.el('message').value = '旧登录消息'
  h.setHold(url => url.includes('/api/messages'))
  h.run('void send()')
  const oldCall = h.fetchCalls.find(call => call.url.includes('/api/messages'))!
  // 旧登录结束（如 401 驱动的登出），用户随即重新登录
  h.run('showLogin()')
  h.run('loginPanel.hidden=true;void load()')
  await h.settle()
  h.run('stopPolling()')
  expect(h.run('loaded')).toBe(true)
  // 新登录在同会话发送新消息并保持在途
  h.el('message').value = '新登录消息'
  h.run('void send()')
  const newCall = h.fetchCalls.filter(call => call.url.includes('/api/messages'))[1]!
  expect(JSON.parse(newCall.options!.body!).idempotencyKey).not.toBe(JSON.parse(oldCall.options!.body!).idempotencyKey)
  expect(h.run('leaveBlock()')).toContain('发送尚未确认')
  // 旧请求以 401 迟到：不能触发登出副作用，也不能清掉新请求的在途占用
  oldCall.resolve({ status: 401, ok: false, json: async () => ({ error: '未授权。' }) })
  await h.settle()
  expect(h.run('privatePanel.hidden')).toBe(false)
  expect(h.run('leaveBlock()')).toContain('发送尚未确认')
  // 旧请求结束后新请求仍独占同会话：重复点击不再产生第三个请求
  h.el('message').value = '新登录消息'
  h.run('void send()')
  expect(h.fetchCalls.filter(call => call.url.includes('/api/messages'))).toHaveLength(2)
  // 新请求成功归位：占用释放、草稿清空
  newCall.resolve({ status: 202, ok: true, json: async () => ({}) })
  await h.settle()
  expect(h.run('leaveBlock()')).toBeUndefined()
  expect(h.el('message').value).toBe('')
})

it('U1-b 提交期间往返同一会话：迟到的失败立即显示错误与重试按钮', async () => {
  const h = await settledHarness()
  await h.switchTo('fake-work')
  h.el('message').value = '往返失败'
  h.setHold(url => url.includes('/api/messages'))
  h.run('void send()')
  const sendCall = h.fetchCalls.find(call => call.url.includes('/api/messages'))!
  // 提交在途时切走再切回（viewGeneration 已两次推进）
  await h.switchTo('main')
  await h.switchTo('fake-work')
  expect(h.el('message').value).toBe('往返失败')
  // 随后才返回 500：失败记录归位并立即渲染，无需再次离开返回
  sendCall.resolve({ status: 500, ok: false, json: async () => ({ error: 'server boom' }) })
  await h.settle()
  expect(h.run('failedSends.length')).toBe(1)
  expect(h.run("document.querySelector('#send-errors').children.length")).toBe(1)
  expect(h.run("document.querySelector('#send-errors').children[0].children[0].textContent")).toContain('尚未确认是否送达')
  expect(h.run("Array.from(document.querySelector('#send-errors').children[0].children).some(n=>n.textContent==='重试发送')")).toBe(true)
  // 占用已释放，离开检查不再拦截
  expect(h.run('leaveBlock()')).toBeUndefined()
})

it('存量信封消息展示层剥壳：气泡显示正文，非信封 JSON 原样显示', async () => {
  const h = await settledHarness()
  const envelope = { id: 'env-m1', conversation_id: 'main', author: 'main-agent', role: 'assistant', presentation: 'chat', content: '{"author":"main-agent","text":"剥壳后的正文"}', createdAt: '2026-10-22T01:00:00.000Z' }
  const plainJson = { ...envelope, id: 'env-m2', content: '{"foo":1}' }
  h.run(`add(${JSON.stringify(envelope)});add(${JSON.stringify(plainJson)})`)
  const texts = h.run(`(function(){const out=[];const walk=n=>{if(String(n.className||'').includes('bubble-text'))out.push(n.textContent);for(const c of n.children)walk(c)};walk(document.querySelector('#messages'));return out})()`) as string[]
  expect(texts).toEqual(['剥壳后的正文', '{"foo":1}'])
})
