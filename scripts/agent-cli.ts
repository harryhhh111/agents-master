import 'dotenv/config'
import readline from 'node:readline'
import { AgentCore, type AgentEvent } from '../src/agent/loop.js'
import { loadConfig } from '../src/config.js'

// M3 的 headless 测试前端（不是正式 TUI）：逐行读输入喂给 AgentCore，事件打印到 stdout。
// 用法：tsx scripts/agent-cli.ts <项目名>，或 bin/agent.ts 的 `agent chat <项目名>`。

export async function runAgentCli(projectName: string): Promise<void> {
  const config = loadConfig()
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  const ask = (q: string) => new Promise<string>(resolve => rl.question(q, resolve))

  const onEvent = (e: AgentEvent): void => {
    switch (e.type) {
      case 'text':
        console.log(`agent> ${e.text}`)
        break
      case 'tool_start':
        console.log(`[tool] ${e.name} ${JSON.stringify(e.args)}`)
        break
      case 'tool_end':
        console.log(`[tool ${e.ok ? 'ok' : 'fail'}] ${e.name}: ${e.summary}`)
        break
      case 'ask':
        // 提示语由 askUser 回调统一打印，这里不重复
        break
      case 'error':
        console.error(`[error] ${e.message}`)
        break
    }
  }

  const core = new AgentCore({
    config,
    projectName,
    onEvent,
    askUser: async (question, context) => {
      if (context) console.log(`\n[背景] ${context}`)
      return ask(`\n[agent 提问] ${question}\n你> `)
    },
  })

  console.log(`已连接项目「${projectName}」。输入目标开始，输入 exit 退出。`)
  for (;;) {
    const line = (await ask('你> ')).trim()
    if (!line) continue
    if (line === 'exit') break
    await core.handleUserMessage(line)
  }
  rl.close()
}

// 直接运行（tsx scripts/agent-cli.ts <项目名>）时进入 CLI
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const projectName = process.argv[2]
  if (!projectName) {
    console.log('用法: tsx scripts/agent-cli.ts <项目名>')
    process.exit(1)
  }
  await runAgentCli(projectName)
}
