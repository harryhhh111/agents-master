#!/usr/bin/env tsx
import 'dotenv/config'
import { randomUUID } from 'node:crypto'
import { createInterface } from 'node:readline'
import { homedir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { loadConfig } from '../src/config.js'
import { createFrontBrain } from '../src/frontbrain/index.js'
import {
  createMainAgentRuntime,
  MainAgentForegroundHost,
  type ForegroundHostEvent,
} from '../src/main/index.js'

export interface MainChatArguments {
  dataDirectory: string
}

/**
 * Default is intentionally outside a repository: factory creates it as 0700
 * and creates its SQLite file as 0600. Pass --data-dir to use another private
 * directory, for example one covered by an encrypted backup policy.
 */
export function defaultMainChatDataDirectory(homeDirectory = homedir()): string {
  return path.join(homeDirectory, '.local', 'share', 'agents-master', 'main-chat')
}

/** Pure argument parser, kept separate from readline and process state. */
export function parseMainChatArguments(args: readonly string[], homeDirectory = homedir()): MainChatArguments {
  let dataDirectory = defaultMainChatDataDirectory(homeDirectory)
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg !== '--data-dir') throw new Error(`未知参数: ${arg ?? ''}`)
    const value = args[index + 1]
    if (!value || !value.trim()) throw new Error('--data-dir 需要一个非空目录')
    dataDirectory = value
    index += 1
  }
  return { dataDirectory }
}

export const mainChatHelp = [
  '可用命令：',
  '  /help     显示本帮助',
  '  /recover  显式恢复失败后仍处于 claimed 的用户消息并重试',
  '  /exit     等待当前前台回合结束后退出',
].join('\n')

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function printHostEvent(write: (line: string) => void, event: ForegroundHostEvent): void {
  switch (event.type) {
    case 'submitted':
      write(`用户: ${event.result.message.content}${event.result.duplicate ? '（已存在）' : ''}`)
      return
    case 'reply':
      write(`主 Agent: ${event.result.message.content}`)
      return
    case 'error':
      write(`运行错误: ${errorText(event.error)}；该消息保持 claimed。输入仍可保存；使用 /recover 才会重试。`)
      return
    case 'recovered':
      write(`${event.source === 'startup' ? '启动恢复' : '已恢复'}：${event.count} 条 claimed 用户消息已回到 pending。`)
  }
}

/** Stop admission immediately on /exit; close waits for the host only once. */
export function createMainChatHandlers(
  host: Pick<MainAgentForegroundHost, 'submit' | 'recover' | 'waitForIdle'>,
  write: (line: string) => void,
  closeInput: () => void,
): { onLine(line: string): void; onClose(): Promise<void> } {
  let accepting = true
  let closing: Promise<void> | undefined
  return {
    onLine(line) {
      if (!accepting) return
      const text = line.trim()
      if (!text) return
      if (text === '/help') {
        write(mainChatHelp)
        return
      }
      if (text === '/recover') {
        try {
          if (host.recover() === undefined) {
            write('未执行恢复：仅在前台回合失败且处理已结束后才能恢复。')
          }
        } catch (error) {
          write(`运行错误: ${errorText(error)}`)
        }
        return
      }
      if (text === '/exit') {
        write('正在等待当前前台回合结束后退出。')
        accepting = false
        closeInput()
        return
      }
      try {
        host.submit({ content: line, idempotencyKey: randomUUID() })
      } catch (error) {
        write(`运行错误: ${errorText(error)}`)
      }
    },
    onClose() {
      accepting = false
      closing ??= host.waitForIdle().catch(error => {
        write(`运行错误: ${errorText(error)}`)
      })
      return closing
    },
  }
}

/**
 * Thin terminal adapter. readline handlers never await model work: every line
 * receives a UUID and is submitted synchronously to the durable inbox, while
 * MainAgentForegroundHost serialises provider calls in the background.
 */
export async function runMainChat(args = process.argv.slice(2)): Promise<void> {
  const { dataDirectory } = parseMainChatArguments(args)
  const config = loadConfig()
  const resources = createMainAgentRuntime({
    dataDirectory,
    frontBrain: createFrontBrain(config),
  })
  const write = (line: string) => process.stdout.write(`${line}\n`)
  const host = new MainAgentForegroundHost(resources.runtime, {
    onEvent: event => printHostEvent(write, event),
  })
  const readline = createInterface({ input: process.stdin, output: process.stdout })
  write(`主 Agent 终端聊天已启动。数据目录: ${dataDirectory}`)
  write(mainChatHelp)

  try {
    await new Promise<void>(resolve => {
      const handlers = createMainChatHandlers(host, write, () => readline.close())
      readline.on('line', handlers.onLine)
      readline.once('close', () => { void handlers.onClose().then(resolve) })
      // Register readline before recovery/drain: input remains receivable even
      // if recovered work immediately starts a provider request.
      host.start()
    })
  } finally {
    resources.close()
  }
}

function isMainEntry(): boolean {
  const entry = process.argv[1]
  return entry !== undefined && pathToFileURL(path.resolve(entry)).href === import.meta.url
}

if (isMainEntry()) {
  runMainChat().catch(error => {
    console.error(`运行错误: ${errorText(error)}`)
    process.exitCode = 1
  })
}
