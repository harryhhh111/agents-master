// 零网络默认剧本：`node run.mjs`（不带 --live）用它跑通全部场景的 happy path。
// 全部为合成响应；顺序必须与场景执行顺序（ping→s1→s2a→s2b→s3→s4→s5）一致，
// 共 21 条，形状对齐 2026-10-15 历史 21 次调用的结构（不声称复现其结果）。
function usage(prompt = 12, completion = 8) {
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: prompt + completion,
    prompt_cache_hit_tokens: 0,
    prompt_cache_miss_tokens: prompt,
  }
}

export function textResponse(content) {
  return {
    choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content } }],
    usage: usage(),
  }
}

export function toolCallResponse(id, name, args) {
  return {
    choices: [
      {
        index: 0,
        finish_reason: 'tool_calls',
        message: {
          role: 'assistant',
          content: '',
          tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }],
        },
      },
    ],
    usage: usage(),
  }
}

export function timeoutError() {
  return { error: { name: 'APIConnectionTimeoutError', type: 'Error', message: 'Foreground request deadline exceeded', retriable: false } }
}

const DELEGATE_ARGS = {
  targetAgentId: 'work-project',
  projectKey: 'stock_data',
  objective: '确认最近一周的提交没有异常',
  scope: ['检查最近提交'],
  completionCriteria: ['给出检查摘要', '列出发现的问题'],
  contextRefs: [],
}

export function defaultOfflineQueue(names = ['ping', 's1', 's2a', 's2b', 's3', 's4', 's5']) {
  const full = [
    // ping
    textResponse('pong'),
    // s1 ×4
    toolCallResponse('call_s1_1', 'query_domain_info', { domain: 'work-project', projectKey: 'stock_data' }),
    toolCallResponse('call_s1_2', 'delegate_work', DELEGATE_ARGS),
    toolCallResponse('call_s1_3', 'cancel_assignment', { assignmentId: 'asg-a-123', reason: '用户改主意了' }),
    toolCallResponse('call_s1_4', 'delegate_work', {
      ...DELEGATE_ARGS,
      objective: '审查配置与部署',
      scope: ['config.toml', 'deploy 目录'],
      completionCriteria: ['列出所有配置问题', '给出修复建议'],
    }),
    // s2a ×2：query → 最终文本（一轮工具后即收尾，语义修复的覆盖点）
    toolCallResponse('call_s2a_1', 'query_domain_info', { domain: 'work-project', projectKey: 'stock_data' }),
    textResponse('已查到 stock_data 项目状态正常（合成回执），并按你的约定提交例行检查委派。'),
    // s2b ×3：query → delegate → 最终文本
    toolCallResponse('call_s2b_1', 'query_domain_info', { domain: 'work-project', projectKey: 'stock_data' }),
    toolCallResponse('call_s2b_2', 'delegate_work', DELEGATE_ARGS),
    textResponse('两步均完成（合成回执）：已查询项目信息并提交例行检查委派。'),
    // s3 ×3：拒绝文本 ×2 + 合法字符串 assignmentId
    textResponse('scope 必须是字符串数组，请把范围改写成字符串数组后我再提交委派。'),
    textResponse('缺少 projectKey：请补充已绑定项目 key（如 stock_data）后再委派。'),
    toolCallResponse('call_s3_1', 'cancel_assignment', { assignmentId: '12345', reason: '用户取消' }),
    // s4 ×6：全部无 tool call（happy path 基线；误触发 FAIL 由测试注入）
    ...[1, 2, 3, 4, 5, 6].map(i => textResponse(`日常回复 ${i}（合成）`)),
    // s5 ×2：超时错误 + 正常恢复
    timeoutError(),
    toolCallResponse('call_s5_1', 'delegate_work', DELEGATE_ARGS),
  ]
  const ranges = { ping: [0, 1], s1: [1, 5], s2a: [5, 7], s2b: [7, 10], s3: [10, 13], s4: [13, 19], s5: [19, 21] }
  return names.flatMap(name => {
    if (!Object.hasOwn(ranges, name)) throw new Error('Unknown offline scenario')
    return full.slice(...ranges[name])
  })
}
