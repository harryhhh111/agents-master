import type { Config } from '../config.js'
import { createLlmClient } from '../llm/client.js'
import type { ModelReply, ScopedModel, ToolDefinition, WireMessage } from '../agent/scoped-protocol.js'
export interface CoordinationClient {
  chat: { completions: { create(params: { model: string; messages: readonly WireMessage[]; tools: readonly ToolDefinition[]; stream: false; max_tokens: number; thinking: { type: 'disabled' } }, options: { signal: AbortSignal; timeout: number; maxRetries: number }): Promise<{ choices: { message: ModelReply }[] }> } }
}
/** Executable configured-client adapter; tests inject a client and never probe providers. */
export class CoordinationModel implements ScopedModel {
  constructor(private readonly client: CoordinationClient, private readonly model: string) {}
  async complete(messages: readonly WireMessage[], tools: readonly ToolDefinition[], signal: AbortSignal): Promise<ModelReply> {
    const result = await this.client.chat.completions.create({ model: this.model, messages, tools, stream: false, max_tokens: 1200, thinking: { type: 'disabled' } }, { signal, timeout: 15000, maxRetries: 0 })
    const message = result.choices[0]?.message
    if (!message) throw new Error('Missing model choice')
    return message
  }
}
export function createCoordinationModel(config: Config): ScopedModel {
  return new CoordinationModel(createLlmClient(config) as unknown as CoordinationClient, config.llm.model)
}
