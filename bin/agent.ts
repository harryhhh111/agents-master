#!/usr/bin/env tsx
import 'dotenv/config'
import { execa } from 'execa'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { loadConfig } from '../src/config.js'
import { pingLlm } from '../src/llm/client.js'

// 环境自检：对应 AGENTS.md 行为规范"先感知当前机器环境再动手"。
// 所有事实现场实测，不套用其他机器的结论。

async function checkBinary(name: string): Promise<string> {
  try {
    const { stdout } = await execa(name, ['--version'], { reject: false, timeout: 15000 })
    return stdout.trim().split('\n')[0] || '(found, no version output)'
  } catch {
    return 'NOT FOUND'
  }
}

async function doctor(): Promise<void> {
  let failures = 0
  const ok = (label: string, detail: string, good = true) => {
    if (!good) failures++
    console.log(`${good ? '✓' : '✗'} ${label}: ${detail}`)
  }

  console.log('== CLI ==')
  ok('codex', await checkBinary('codex'), true)
  ok('kimi', await checkBinary('kimi'), true)

  console.log('\n== session 目录 ==')
  const codexSessions = path.join(os.homedir(), '.codex/sessions')
  const kimiSessions = path.join(os.homedir(), '.kimi-code/sessions')
  ok('codex sessions', codexSessions, fs.existsSync(codexSessions))
  ok('kimi sessions', kimiSessions, fs.existsSync(kimiSessions))

  console.log('\n== 配置 ==')
  let config
  try {
    config = loadConfig()
    ok('config.toml', `model=${config.llm.model}, base_url=${config.llm.base_url}, delegation=${config.delegation.level}`)
  } catch (e) {
    ok('config.toml', String(e), false)
  }

  console.log('\n== 项目 ==')
  if (config) {
    for (const p of config.projects) {
      const exists = fs.existsSync(p.path)
      let gitInfo = ''
      if (exists) {
        const r = await execa('git', ['-C', p.path, 'status', '--porcelain'], { reject: false })
        const dirty = r.stdout.trim().split('\n').filter(Boolean).length
        gitInfo = `, git 脏文件=${dirty}`
      }
      ok(p.name, `${p.path}${gitInfo}`, exists)
    }
  }

  console.log('\n== LLM ==')
  ok('DEEPSEEK_API_KEY', process.env.DEEPSEEK_API_KEY ? '已配置' : '未配置', Boolean(process.env.DEEPSEEK_API_KEY))
  if (config && process.env.DEEPSEEK_API_KEY) {
    try {
      const pong = await pingLlm(config)
      ok('LLM ping', pong.trim())
    } catch (e) {
      ok('LLM ping', String(e), false)
    }
  }

  console.log(failures === 0 ? '\ndoctor 全绿' : `\n${failures} 项未通过`)
  process.exit(failures === 0 ? 0 : 1)
}

const cmd = process.argv[2]
if (cmd === 'doctor') {
  await doctor()
} else if (cmd === 'chat') {
  const projectName = process.argv[3]
  if (!projectName) {
    console.log('用法: agent chat <项目名>')
    process.exit(1)
  }
  const { runAgentCli } = await import('../scripts/agent-cli.js')
  await runAgentCli(projectName)
} else if (cmd) {
  // 默认子命令：agent <项目名> 启动 Ink TUI
  const { runTui } = await import('../src/tui/launcher.js')
  try {
    await runTui(cmd)
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e))
    process.exit(1)
  }
} else {
  console.log('用法: agent <项目名> | agent doctor | agent chat <项目名>')
}
