#!/usr/bin/env tsx
// Stage 1.2b 本地冒烟：用临时 SQLite 和配置好的 FrontBrain 处理一条合成用户
// 消息的完整前台闭环（收件 → 领取 → 稳定前缀+锚定主对话组装 → 前台模型 →
// 单事务持久化 assistant 回复与 processed 状态），只打印响应元数据与文本。
// 无论 setup 或 provider 失败，临时目录都会清理、原始错误原样输出（清理失败
// 只记录、绝不掩盖原始错误；目录创建本身失败则原样抛出，无路径可清理）。
// 花真钱，仅在明确需要时手动运行：
// npm run smoke:user-message
import 'dotenv/config'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { loadConfig } from '../src/config.js'
import { createFrontBrain } from '../src/frontbrain/index.js'
import {
  createMainAgentRuntime,
  type MainAgentRuntimeResources,
} from '../src/main/index.js'

const instructions = '你是 agents-master 的主 Agent 前台。保持回复简短、直接。'
const checkpoint = '冒烟检查点 v1：只回复，不行动。'
const userText = '你好，这是一条本地冒烟测试消息，请用一句话确认收到。'

export interface SmokeUserMessageOptions {
  /** Test seam: builds runtime resources for the prepared temp directory. */
  createResources?: (dataDirectory: string) => MainAgentRuntimeResources
  /** Test seam: pairs with removeDataDirectory; defaults to mkdtempSync in os.tmpdir(). */
  makeDataDirectory?: () => string
  /**
   * Test seam: invoked exactly once whenever the temp directory path is known,
   * including failures that happen before runtime resources exist. Not invoked
   * when directory creation itself threw (there is no path to clean).
   */
  removeDataDirectory?: (dataDirectory: string) => void
  /** Model name printed on the first line; used only by the injected path. */
  modelName?: string
  log?: (line: string) => void
  error?: (line: string) => void
}

/**
 * One smoke turn against a throwaway data directory. The setup error or the
 * provider error is always rethrown unchanged; cleanup failures on that path
 * are logged, never thrown over the original error. Resolves `true` when the
 * turn succeeded but a cleanup step failed (the CLI then exits non-zero),
 * `false` on a fully clean run.
 */
export async function runSmokeUserMessage(options: SmokeUserMessageOptions = {}): Promise<boolean> {
  const log = options.log ?? console.log
  const errorLog = options.error ?? console.error
  let dataDirectory: string | undefined
  let resources: MainAgentRuntimeResources | undefined
  let cleanupFailed = false
  try {
    dataDirectory =
      options.makeDataDirectory?.() ?? mkdtempSync(path.join(tmpdir(), 'agents-master-smoke-'))
    let modelName = options.modelName
    if (options.createResources) {
      resources = options.createResources(dataDirectory)
      modelName ??= '?'
    } else {
      const config = loadConfig()
      modelName = config.llm.model
      resources = createMainAgentRuntime({
        dataDirectory,
        databaseFileName: 'smoke.sqlite',
        frontBrain: createFrontBrain(config),
      })
    }
    resources.runtime.receiveUserMessage({
      conversationId: 'smoke',
      idempotencyKey: 'smoke-1',
      content: userText,
    })
    const result = await resources.runtime.processNextUserMessageEvent({
      instructions,
      checkpoint,
      maxOutputTokens: 256,
    })
    if (!result) {
      throw new Error('没有可处理的 pending 用户消息事件（不应发生）')
    }
    const usage = result.response.usage
    const cache =
      usage.cachedInputTokens !== undefined || usage.uncachedInputTokens !== undefined
        ? ` cache hit=${usage.cachedInputTokens ?? '未上报'} miss=${usage.uncachedInputTokens ?? '未上报'}`
        : ''
    log(`model=${modelName}`)
    log(`latencyMs=${result.response.latencyMs.toFixed(1)}`)
    log(
      `usage in=${usage.inputTokens ?? '?'} out=${usage.outputTokens ?? '?'}` +
        ` total=${usage.totalTokens ?? '?'}${cache}`,
    )
    log(`finishReason=${result.response.finishReason ?? '?'}`)
    log(`reply=${result.message.content}`)
  } finally {
    // Cleanup must never mask the original setup/provider error, which
    // propagates unchanged; a cleanup failure only flags the success path.
    // The directory is removed whenever its path is known, even when the
    // failure happened before the runtime resources were created.
    try {
      resources?.close()
    } catch (cleanupError) {
      cleanupFailed = true
      reportCleanupError(errorLog, `关闭运行时资源失败：${String(cleanupError)}`)
    }
    if (dataDirectory !== undefined) {
      try {
        const remove = options.removeDataDirectory
          ?? ((directory: string) => rmSync(directory, { recursive: true, force: true }))
        remove(dataDirectory)
      } catch (cleanupError) {
        cleanupFailed = true
        reportCleanupError(errorLog, `删除临时目录失败：${String(cleanupError)}`)
      }
    }
  }
  return cleanupFailed
}

/**
 * Reports a cleanup failure without ever throwing: a broken error sink must
 * not mask the original setup/provider error that is already propagating.
 */
function reportCleanupError(errorLog: (line: string) => void, message: string): void {
  try {
    errorLog(message)
  } catch {
    // Swallow: the original error must keep propagating unchanged.
  }
}

function isMainEntry(): boolean {
  const entry = process.argv[1]
  if (!entry) return false
  return pathToFileURL(path.resolve(entry)).href === import.meta.url
}

if (isMainEntry()) {
  runSmokeUserMessage().then(
    cleanupFailed => {
      if (cleanupFailed) process.exitCode = 1
    },
    error => {
      console.error(error)
      process.exitCode = 1
    },
  )
}
