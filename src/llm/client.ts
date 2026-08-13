import OpenAI from 'openai'
import type { Config } from '../config.js'

export function createLlmClient(config: Config): OpenAI {
  const apiKey = process.env.DEEPSEEK_API_KEY
  if (!apiKey) {
    throw new Error('DEEPSEEK_API_KEY 未配置（写在 agents-master/.env 里）')
  }
  return new OpenAI({ baseURL: config.llm.base_url, apiKey })
}

export async function pingLlm(config: Config): Promise<string> {
  const client = createLlmClient(config)
  const resp = await client.chat.completions.create({
    model: config.llm.model,
    messages: [{ role: 'user', content: 'ping，回复 pong 即可' }],
    max_tokens: 16,
  })
  return resp.choices[0]?.message?.content ?? '(empty)'
}
