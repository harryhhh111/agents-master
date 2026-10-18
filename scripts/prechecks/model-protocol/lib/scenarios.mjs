// 场景实现。每个场景返回 { scenario, verdict, evidence, notes, automated: true }。
// verdict ∈ {PASS, FAIL, UNVERIFIED}：
//   - 请求失败/预算耗尽导致证据不足 → UNVERIFIED（绝不把"未观察到"当"通过"）；
//   - 断言基于实际观察（工具名、配对、链、参数 schema）而非无条件 PASS；
//   - S3 为观察性场景：全部调用成功即 PASS，行为分类写入 notes 供人工解释。
// 人工解释与自动判定分离：runner 产物只含自动判定，解释见 REPORT.md。
import { TOOL_DEFINITIONS, validateToolCall } from './tools.mjs'

const SYSTEM_PROMPT = [
  '你是主 Agent 的前台模型，负责理解用户输入，并通过工具完成领域查询与工作委派。',
  '可用工具：',
  '- query_domain_info：只读查询领域 Agent 目录或已绑定项目的信息。',
  '- delegate_work：提交一次结构化工作委派（目标 Agent、项目、目标、范围、完成标准、上下文引用）。',
  '- cancel_assignment：请求取消一个已提交的委派。',
  '规则：',
  '1. 用户明确要查询领域/项目信息时调用 query_domain_info。',
  '2. 用户明确提出要做某件具体工作时调用 delegate_work，参数必须严格符合 schema；scope 与 completionCriteria 是字符串数组。',
  '3. 用户明确要求取消已提交的委派时调用 cancel_assignment。',
  '4. 普通闲聊、不完整或仅设想中的请求，不调用工具，直接用文本回复。',
].join('\n')

export function conversation(userText) {
  return [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: userText },
  ]
}

function singleToolCall(completion) {
  const message = completion?.choices?.[0]?.message
  const toolCalls = message?.tool_calls ?? []
  return { message, toolCalls, content: message?.content ?? null }
}

// 工具回执为固定 JSON（无副作用，不执行任何真实操作）。
function fakeToolResult(name) {
  if (name === 'query_domain_info') {
    return { ok: true, domain: 'work-project', project: { key: 'stock_data', bound: true, status: 'active', recentCommits: 3, openQuestions: 0 } }
  }
  if (name === 'delegate_work') return { ok: true, assignmentId: 'asg-test-001', status: 'queued' }
  if (name === 'cancel_assignment') return { ok: true, assignmentId: 'asg-a-123', status: 'cancel_requested' }
  return { ok: true }
}

function unverified(scenario, reason, notes = []) {
  return { scenario, verdict: 'UNVERIFIED', reason, notes, evidence: [], automated: true }
}

/** 按 OpenAI 协议把 tool_calls 与配对的 tool 结果追加进 messages；返回是否全部合法配对。 */
function appendToolRound(messages, message, toolCalls) {
  const usedIds = new Set(messages.flatMap(m => (m.tool_calls ?? []).map(tc => tc.id)))
  for (const tc of toolCalls) {
    if (!validateToolCall(tc).valid || usedIds.has(tc.id)) return false
    usedIds.add(tc.id)
  }
  messages.push({
    role: 'assistant',
    content: message.content ?? '',
    tool_calls: toolCalls.map(tc => ({ id: tc.id, type: tc.type, function: { name: tc.function?.name, arguments: tc.function?.arguments } })),
  })
  for (const tc of toolCalls) {
    messages.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify(fakeToolResult(tc.function?.name)) })
  }
  let pairingOk = true
  for (let i = 0; i < messages.length; i += 1) {
    const m = messages[i]
    if (m.role === 'assistant' && Array.isArray(m.tool_calls)) {
      for (let k = 0; k < m.tool_calls.length; k += 1) {
        const expected = messages[i + 1 + k]
        if (!expected || expected.role !== 'tool' || expected.tool_call_id !== m.tool_calls[k].id) pairingOk = false
      }
      i += m.tool_calls.length
    }
  }
  return pairingOk
}

export async function scenarioPing(probe) {
  const { completion, error, record } = await probe.call({ messages: [{ role: 'user', content: 'ping，回复 pong 即可' }], maxTokens: 16 })
  if (error) return unverified('ping', `请求失败，证据不足: ${error.name}`, [error.message])
  const text = completion?.choices?.[0]?.message?.content ?? ''
  return { scenario: 'ping', verdict: text.trim() ? 'PASS' : 'FAIL', evidence: [record.seq], notes: [`模型应答: "${text.trim()}"；finish_reason=${completion?.choices?.[0]?.finish_reason}`], automated: true }
}

/** S1：单次工具选择与参数解析。4 次独立调用，name 与 schema 全部正确才 PASS；任一请求失败 → UNVERIFIED。 */
export async function scenarioS1(probe) {
  const cases = [
    { expect: 'query_domain_info', user: '帮我查一下 work-project 领域 stock_data 项目目前的状态和最近动态。' },
    { expect: 'delegate_work', user: '把检查 stock_data 项目最近改动的任务委派给工作项目 Agent（targetAgentId 用 work-project），目标是确认最近一周的提交没有异常，完成标准是给出检查摘要并列出发现的问题。' },
    { expect: 'cancel_assignment', user: '等一下，先取消刚才那个委派，assignmentId 是 asg-a-123，理由是用户改主意了。' },
    { expect: 'delegate_work', user: '让 work-project 审查 stock_data 的配置与部署：范围包括 config.toml 和 deploy 目录，完成标准是列出所有配置问题并给出修复建议。' },
  ]
  const details = []
  const evidence = []
  let failures = 0
  for (const [index, testCase] of cases.entries()) {
    const { completion, error, record } = await probe.callWithRetry({ messages: conversation(testCase.user), tools: TOOL_DEFINITIONS })
    evidence.push(record.seq)
    if (error) {
      failures += 1
      details.push(`case${index + 1}(${testCase.expect}): 请求失败 ${error.name}: ${error.message}`)
      continue
    }
    const { toolCalls, content } = singleToolCall(completion)
    if (toolCalls.length !== 1) {
      details.push(`case${index + 1}(${testCase.expect}): 期望 1 个 tool call，实际 ${toolCalls.length}；文本=${JSON.stringify(content ?? '')}`)
      continue
    }
    const v = validateToolCall(toolCalls[0])
    const nameOk = v.name === testCase.expect
    details.push(`case${index + 1}: expect=${testCase.expect} got=${v.name} nameOk=${nameOk} schemaValid=${v.valid}${v.errors ? ` errors=${v.errors.join(';')}` : ''}`)
  }
  if (failures > 0) return unverified('S1-single-tool-selection', `${failures}/${cases.length} 次请求失败，证据不足`, details)
  const pass = details.filter(d => d.includes('nameOk=true') && d.includes('schemaValid=true')).length === cases.length
  return { scenario: 'S1-single-tool-selection', verdict: pass ? 'PASS' : 'FAIL', evidence, notes: details, automated: true }
}

/**
 * S2a：多轮配对循环（开放式指令）。语义修复：不再要求 >=2 轮工具调用。
 * 合法终态 = 拿到工具结果后继续调用，或产出最终/澄清文本；断言点为
 * >=1 轮工具、配对合法、以非空最终文本收尾。模型选择澄清是合法行为，
 * 分类写入 notes 供人工解释。
 */
export async function scenarioS2a(probe) {
  const messages = conversation(
    '我想跟进 stock_data 项目。先帮我查一下 work-project 领域这个项目的基本信息；如果项目状态正常，就再委派一次例行检查：目标是确认最近改动没有问题，范围是 src 目录和配置文件，完成标准是输出检查摘要和发现的问题清单。',
  )
  const evidence = []
  const turnLog = []
  const observedTools = []
  let finalText = null
  let toolRounds = 0
  let pairingOk = true
  let requestFailed = false

  for (let turn = 1; turn <= 4; turn += 1) {
    const { completion, error, record } = await probe.callWithRetry({ messages, tools: TOOL_DEFINITIONS })
    evidence.push(record.seq)
    if (error) {
      requestFailed = true
      turnLog.push(`turn${turn}: 请求失败 ${error.name}: ${error.message}`)
      break
    }
    const { message, toolCalls } = singleToolCall(completion)
    if (toolCalls.length === 0) {
      finalText = message?.content ?? ''
      turnLog.push(`turn${turn}: 最终文本（无 tool call），长度=${finalText.length}，finish_reason=${completion?.choices?.[0]?.finish_reason}`)
      break
    }
    toolRounds += 1
    observedTools.push(...toolCalls.map(tc => tc.function?.name))
    const validations = toolCalls.map(validateToolCall)
    turnLog.push(`turn${turn}: ${toolCalls.length} 个 tool call: ${validations.map(v => `${v.name}(schemaValid=${v.valid})`).join(', ')}`)
    if (toolCalls.some(tc => !['query_domain_info', 'delegate_work'].includes(tc.function?.name)) ||
        (toolRounds === 1 && toolCalls.some(tc => tc.function?.name !== 'query_domain_info'))) {
      pairingOk = false
      break
    }
    pairingOk = appendToolRound(messages, message, toolCalls) && pairingOk
    if (!pairingOk) break
  }

  if (requestFailed) return unverified('S2a-multi-turn-pairing', '请求失败，证据不足', turnLog)
  const endedWithText = finalText !== null && finalText.trim().length > 0
  const behavior = toolRounds >= 2 ? 'tool-chain' : endedWithText ? 'single-tool-then-final-text(可能是澄清式收尾)' : 'no-final-text'
  const pass = toolRounds >= 1 && pairingOk && endedWithText
  return {
    scenario: 'S2a-multi-turn-pairing',
    verdict: pass ? 'PASS' : 'FAIL',
    evidence,
    notes: [...turnLog, `toolRounds=${toolRounds} pairingOk=${pairingOk} finalText=${endedWithText} behavior=${behavior} observedTools=${observedTools.join('>') || '(无)'}`],
    automated: true,
  }
}

/**
 * S2b：显式两步指令（query → delegate）。断言实际工具链与期望链一致
 * （修复旧实现"声明 expectedTools 但不比较"的缺陷）。模型改为澄清时
 * 自动判 FAIL 并在 notes 标注"真实行为，供人工解释"，与配对破坏区分。
 */
export async function scenarioS2b(probe) {
  const expectedChain = ['query_domain_info', 'delegate_work']
  const messages = conversation(
    '分两步处理。第一步：调用 query_domain_info 查询 work-project 领域 stock_data 项目的基本信息。拿到结果后第二步：调用 delegate_work 向 work-project 提交例行检查委派，projectKey 是 stock_data，objective 是确认最近改动没有问题，scope 是 ["src", "config.toml"]，completionCriteria 是 ["输出检查摘要", "列出发现的问题"]，contextRefs 用空数组。两步都完成后用简短文本总结。',
  )
  const evidence = []
  const turnLog = []
  const observedTools = []
  let finalText = null
  let toolRounds = 0
  let pairingOk = true
  let requestFailed = false

  for (let turn = 1; turn <= 4; turn += 1) {
    const { completion, error, record } = await probe.callWithRetry({ messages, tools: TOOL_DEFINITIONS })
    evidence.push(record.seq)
    if (error) {
      requestFailed = true
      turnLog.push(`turn${turn}: 请求失败 ${error.name}: ${error.message}`)
      break
    }
    const { message, toolCalls } = singleToolCall(completion)
    if (toolCalls.length === 0) {
      finalText = message?.content ?? ''
      turnLog.push(`turn${turn}: 最终文本（无 tool call），长度=${finalText.length}`)
      break
    }
    toolRounds += 1
    observedTools.push(...toolCalls.map(tc => tc.function?.name))
    const validations = toolCalls.map(validateToolCall)
    turnLog.push(`turn${turn}: ${toolCalls.length} 个 tool call: ${validations.map(v => `${v.name}(schemaValid=${v.valid})`).join(', ')}`)
    if (toolCalls.length !== 1 || toolCalls[0].function?.name !== expectedChain[toolRounds - 1]) {
      pairingOk = false
      break
    }
    pairingOk = appendToolRound(messages, message, toolCalls) && pairingOk
    if (!pairingOk) break
  }

  if (requestFailed) return unverified('S2b-two-chained-tool-calls', '请求失败，证据不足', turnLog)
  const chainOk = expectedChain.length === observedTools.length && expectedChain.every((name, i) => name === observedTools[i])
  const endedWithText = finalText !== null && finalText.trim().length > 0
  if (toolRounds < 2 && endedWithText) {
    turnLog.push('注意：模型在两步完成前以文本收尾（澄清或拒绝），属真实行为；自动判定 FAIL，人工解释见 REPORT。')
  }
  const pass = toolRounds >= 2 && pairingOk && endedWithText && chainOk
  return {
    scenario: 'S2b-two-chained-tool-calls',
    verdict: pass ? 'PASS' : 'FAIL',
    evidence,
    notes: [...turnLog, `toolRounds=${toolRounds} pairingOk=${pairingOk} finalText=${endedWithText} chainOk=${chainOk} observedChain=${observedTools.join('>') || '(无)'} expectedChain=${expectedChain.join('>')}`],
    automated: true,
  }
}

/** S3：无效参数行为（观察性）。全部调用成功才 PASS（观察完成）；任一失败 → UNVERIFIED。分类写 notes。 */
export async function scenarioS3(probe) {
  const cases = [
    { id: '3a-scope-type', user: '帮我委派：targetAgentId 用 work-project，projectKey 是 stock_data，objective 是例行检查，scope 只填一个数字 3（不要字符串数组），completionCriteria 填"输出报告"，contextRefs 填空数组。' },
    { id: '3b-missing-projectKey', user: '帮我把这个任务委派出去：目标 Agent 是 work-project，要做的事情是检查项目代码质量，完成标准是给出问题清单，但 projectKey 我现在不想说，你先派了再说。' },
    { id: '3c-numeric-assignmentId', user: '取消一下刚才的委派，assignmentId 用数字 12345 就行，reason 写用户取消。' },
  ]
  const details = []
  const evidence = []
  let failures = 0
  for (const testCase of cases) {
    const { completion, error, record } = await probe.callWithRetry({ messages: conversation(testCase.user), tools: TOOL_DEFINITIONS })
    evidence.push(record.seq)
    if (error) {
      failures += 1
      details.push(`${testCase.id}: 请求失败 ${error.name}: ${error.message}`)
      continue
    }
    const { toolCalls, content } = singleToolCall(completion)
    if (toolCalls.length === 0) {
      details.push(`${testCase.id}: 模型未调用工具，文本回复=${JSON.stringify((content ?? '').slice(0, 120))}（分类：拒绝/澄清）`)
      continue
    }
    for (const tc of toolCalls) {
      const v = validateToolCall(tc)
      const argsType = v.jsonParseOk ? JSON.stringify(v.parsed).slice(0, 160) : '(非 JSON)'
      details.push(`${testCase.id}: name=${v.name} schemaValid=${v.valid}${v.errors ? ` errors=${v.errors.join(';')}` : ''} args=${argsType}（分类：${v.valid ? '产出 schema 合法调用' : '产出 schema 非法调用'}）`)
    }
  }
  if (failures > 0) return unverified('S3-invalid-params', `${failures}/${cases.length} 次请求失败，观察不完整`, details)
  return { scenario: 'S3-invalid-params', verdict: 'PASS', evidence, notes: [...details, '观察性场景：PASS 仅表示全部观察完成，行为机制解释见 REPORT.md（人工）。'], automated: true }
}

/** S4：普通聊天不误触发。任一请求失败 → UNVERIFIED；0 触发 → PASS；有触发 → FAIL 并记录参数。 */
export async function scenarioS4(probe) {
  const statements = [
    '今天天气怎么样？适合出门跑步吗？',
    '帮我看看项目',
    '以后可以检查一下 stock_data',
    '晚上吃什么好呢？随便推荐一下。',
    '记得提醒我明天下午三点开会。',
    'stock_data 那个项目最近有什么动静吗？有空的时候再看看吧。',
  ]
  let triggered = 0
  const details = []
  const evidence = []
  let failures = 0
  for (const [index, text] of statements.entries()) {
    const { completion, error, record } = await probe.callWithRetry({ messages: conversation(text), tools: TOOL_DEFINITIONS })
    evidence.push(record.seq)
    if (error) {
      failures += 1
      details.push(`stmt${index + 1}: 请求失败 ${error.name}: ${error.message}`)
      continue
    }
    const { toolCalls, content } = singleToolCall(completion)
    if (toolCalls.length > 0) {
      triggered += 1
      const v = validateToolCall(toolCalls[0])
      details.push(`stmt${index + 1}(${text}): 误触发 ${v.name} args=${JSON.stringify(v.parsed ?? v.argumentsRaw)}`)
    } else {
      details.push(`stmt${index + 1}(${text.slice(0, 18)}…): 无 tool call，文本长度=${(content ?? '').length}`)
    }
  }
  if (failures > 0) return unverified('S4-chat-no-trigger', `${failures}/${statements.length} 次请求失败，误触发率证据不足`, details)
  return { scenario: 'S4-chat-no-trigger', verdict: triggered === 0 ? 'PASS' : 'FAIL', evidence, notes: [...details, `误触发率=${triggered}/${statements.length}（本测试集口径，非生产误触发率）`], automated: true }
}

/** S5：超时与恢复。断言恢复后的工具名必须是 delegate_work；超时调用的 usage 记为未知。 */
export async function scenarioS5(probe) {
  const messages = conversation(
    '把检查 stock_data 项目最近改动的任务委派给工作项目 Agent（targetAgentId 用 work-project），目标是确认最近一周的提交没有异常，完成标准是给出检查摘要并列出发现的问题。',
  )
  const evidence = []
  const { error: timeoutErrorResult, record: timeoutRecord } = await probe.call({ messages, tools: TOOL_DEFINITIONS, timeoutMs: 1 })
  evidence.push(timeoutRecord.seq)
  const timeoutShape = timeoutErrorResult
    ? { name: timeoutErrorResult.name, type: timeoutErrorResult.type, message: timeoutErrorResult.message, latencyMs: timeoutRecord.response.latencyMs }
    : null
  if (!timeoutErrorResult) {
    return { scenario: 'S5-timeout-recovery', verdict: 'FAIL', evidence, notes: ['timeoutMs=1 未触发超时错误（意外成功），无法验证超时形状'], automated: true }
  }
  const retry = await probe.call({ messages, tools: TOOL_DEFINITIONS, timeoutMs: 30_000 })
  evidence.push(retry.record.seq)
  if (retry.error) {
    return unverified('S5-timeout-recovery', `超时形状已记录，但正常重发失败，恢复性证据不足: ${retry.error.name}`, [
      `超时形状=${JSON.stringify(timeoutShape)}`,
      retry.error.message,
      '注意：超时调用的服务端 usage 未知（transcript 记为 usageUnknown），不按零计。',
    ])
  }
  const { toolCalls } = singleToolCall(retry.completion)
  const v = toolCalls.length === 1 ? validateToolCall(toolCalls[0]) : null
  const recovered = v !== null && v.valid === true && v.name === 'delegate_work'
  return {
    scenario: 'S5-timeout-recovery',
    verdict: recovered && timeoutErrorResult.name === 'APIConnectionTimeoutError' ? 'PASS' : 'FAIL',
    evidence,
    notes: [
      `超时形状=${JSON.stringify(timeoutShape)}`,
      '超时调用的服务端 usage 未知（transcript 记 usage: null + usageUnknown: true），不按零计。',
      `正常 timeout 重发: toolCall=${v?.name} schemaValid=${v?.valid} latencyMs=${retry.latencyMs}（断言: 必须是 delegate_work 且 schemaValid=true）`,
    ],
    automated: true,
  }
}

export const SCENARIOS = {
  ping: scenarioPing,
  s1: scenarioS1,
  s2a: scenarioS2a,
  s2b: scenarioS2b,
  s3: scenarioS3,
  s4: scenarioS4,
  s5: scenarioS5,
}
