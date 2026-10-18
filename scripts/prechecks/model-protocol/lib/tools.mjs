// 合成工具定义与参数校验（zod）。工具只做无副作用回执：探针不"执行"工具，
// 只校验参数并返回固定 JSON。形状与 2026-10-15 预检一致（DelegateWork 镜像
// docs/agent-system-first-slice-proposal.md 3.1 节）。
import { z } from 'zod'

export const TOOL_DEFINITIONS = [
  {
    type: 'function',
    function: {
      name: 'query_domain_info',
      description: '查询领域 Agent 目录或已绑定项目的当前信息（只读）',
      parameters: {
        type: 'object',
        properties: {
          domain: { type: 'string', description: '领域标识，如 work-project' },
          projectKey: { type: 'string', description: '已绑定项目 key，如 stock_data' },
        },
        required: ['domain'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'delegate_work',
      description: '向指定领域 Agent 提交一次结构化工作委派；仅当用户明确提出工作委托时调用',
      parameters: {
        type: 'object',
        properties: {
          targetAgentId: { type: 'string' },
          projectKey: { type: 'string' },
          objective: { type: 'string' },
          scope: { type: 'array', items: { type: 'string' } },
          completionCriteria: { type: 'array', items: { type: 'string' } },
          contextRefs: { type: 'array', items: { type: 'string' } },
        },
        required: ['targetAgentId', 'projectKey', 'objective', 'scope', 'completionCriteria', 'contextRefs'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'cancel_assignment',
      description: '请求取消一个已提交的委派',
      parameters: {
        type: 'object',
        properties: {
          assignmentId: { type: 'string' },
          reason: { type: 'string' },
        },
        required: ['assignmentId'],
      },
    },
  },
]

export const DelegateWorkSchema = z.object({
  targetAgentId: z.string(),
  projectKey: z.string(),
  objective: z.string(),
  scope: z.array(z.string()),
  completionCriteria: z.array(z.string()),
  contextRefs: z.array(z.string()),
})

const QueryDomainInfoSchema = z.object({
  domain: z.string(),
  projectKey: z.optional(z.string()),
})

const CancelAssignmentSchema = z.object({
  assignmentId: z.string(),
  reason: z.optional(z.string()),
})

export const TOOL_SCHEMAS = {
  query_domain_info: QueryDomainInfoSchema,
  delegate_work: DelegateWorkSchema,
  cancel_assignment: CancelAssignmentSchema,
}

/** 校验单个 tool_call：名称已知、arguments 可解析为 JSON、符合 zod schema。 */
export function validateToolCall(toolCall) {
  const name = toolCall?.function?.name
  const schema = Object.hasOwn(TOOL_SCHEMAS, name) ? TOOL_SCHEMAS[name] : null
  const result = {
    name,
    known: Boolean(schema),
    argumentsRaw: toolCall?.function?.arguments,
    toolCallId: toolCall?.id,
  }
  if (!schema) {
    result.valid = false
    result.errors = [`unknown tool name: ${String(name)}`]
    return result
  }
  if (toolCall.type !== 'function' || typeof toolCall.id !== 'string' || !toolCall.id.trim()) {
    return { ...result, valid: false, errors: ['Invalid tool call type/id'] }
  }
  let parsed
  try {
    parsed = JSON.parse(toolCall.function.arguments)
    result.jsonParseOk = true
  } catch (error) {
    result.valid = false
    result.jsonParseOk = false
    result.errors = [`arguments is not valid JSON: ${error.message}`]
    return result
  }
  result.parsed = parsed
  const check = schema.safeParse(parsed)
  result.valid = check.success
  if (!check.success) {
    result.errors = check.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`)
  }
  return result
}
