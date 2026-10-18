// 被测组合：镜像 config.toml [llm] + src/frontbrain/deepseek.ts + src/llm/client.ts
// 的当前形状（2026-10-16 核对）。这些值只读抄录；live 传输层另设端点白名单，
// 不允许环境变量把请求改发到任意端点。
export const COMBO = {
  baseUrl: 'https://api.deepseek.com', // config.toml [llm].base_url
  model: 'deepseek-flash', // config.toml [llm].model
  stream: false, // deepseek.ts: stream: false
  thinking: { type: 'disabled' }, // deepseek.ts: 每个请求显式发送，禁 reasoning tokens
  timeoutMs: 30_000, // deepseek.ts: SDK timeout 30s + AbortController 30s
  maxRetries: 0, // deepseek.ts: maxRetries: 0（本 runner 也不依赖 SDK 重试）
  openaiSdkVersion: '7.4.0', // package.json 依赖 openai ^7.4.0
  apiKeyEnv: 'DEEPSEEK_API_KEY',
  apiKeySource: '.env（仅 live 模式显式 --live 时经 dotenv 载入内存，绝不落盘）',
}

export const BUDGET = {
  maxTotalCalls: 40, // 同一 ledger 上累计的 chat.completions 尝试上限（含失败尝试）
  maxTokensPerCall: 2048, // 每次 max_tokens 上限
  maxRetriesPerRequest: 2, // 同一请求异常重试上限（runner 层；超时与 4xx 不重试）
}

export const DEFAULT_RUNTIME_BUDGET_MS = 600_000 // 单次 runPrecheck 的墙钟上限
