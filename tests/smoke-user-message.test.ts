import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { runSmokeUserMessage } from '../scripts/smoke-user-message.js'
import type { FrontBrainResponse } from '../src/frontbrain/types.js'
import type {
  MainAgentRuntime,
  MainAgentRuntimeResources,
} from '../src/main/index.js'
import type {
  InboxEvent,
  MainConversationMessage,
  ProcessNextUserMessageEventResult,
} from '../src/main/types.js'

const createdAt = '2026-09-15T00:00:00.000Z'

// Directories left behind by injected seams that failed before cleanup; the
// real rmSync default is exercised by the tests that use it, but these are
// belt-and-braces in case an assertion throws mid-test.
const leftoverDirectories: string[] = []

afterEach(() => {
  for (const dir of leftoverDirectories.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

function fakeProcessedResult(): ProcessNextUserMessageEventResult {
  const event: InboxEvent = {
    id: 'evt-1',
    conversationId: 'smoke',
    idempotencyKey: 'smoke-1',
    type: 'user-message',
    priority: 'normal',
    payload: { text: '你好' },
    status: 'processed',
    createdAt,
    updatedAt: createdAt,
    processedAt: createdAt,
  }
  const message: MainConversationMessage = {
    id: 'msg-1',
    role: 'assistant',
    content: '收到。',
    createdAt,
  }
  const response: FrontBrainResponse = {
    text: '收到。',
    finishReason: 'stop',
    latencyMs: 12.3,
    usage: { inputTokens: 5, outputTokens: 3, totalTokens: 8 },
  }
  return { event, message, response }
}

interface FakeBehavior {
  receiveError?: Error
  processError?: Error
  closeError?: Error
  /** Invoked at the start of close(), before any configured closeError. */
  onClose?: () => void
}

/** Builds a fake runtime that never touches the network or disk. */
function fakeResources(behavior: FakeBehavior = {}): {
  resources: MainAgentRuntimeResources
  receiveUserMessage: ReturnType<typeof vi.fn>
  processNextUserMessageEvent: ReturnType<typeof vi.fn>
  close: ReturnType<typeof vi.fn>
} {
  const receiveUserMessage = vi.fn(() => {
    if (behavior.receiveError) throw behavior.receiveError
  })
  const processNextUserMessageEvent = vi.fn(async () => {
    if (behavior.processError) throw behavior.processError
    return fakeProcessedResult()
  })
  const close = vi.fn(() => {
    behavior.onClose?.()
    if (behavior.closeError) throw behavior.closeError
  })
  const runtime = {
    receiveUserMessage,
    processNextUserMessageEvent,
  } as unknown as MainAgentRuntime
  // The smoke script only calls runtime.receiveUserMessage / runtime.processNextUserMessageEvent / close.
  const resources = { runtime, close } as unknown as MainAgentRuntimeResources
  return { resources, receiveUserMessage, processNextUserMessageEvent, close }
}

/** Real temp dirs whose creation and removal are recorded; removal really deletes. */
function makeTrackingDirectories() {
  const created: string[] = []
  const removed: string[] = []
  const makeDataDirectory = () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'smoke-user-message-test-'))
    created.push(dir)
    leftoverDirectories.push(dir)
    return dir
  }
  const removeDataDirectory = (directory: string) => {
    removed.push(directory)
    rmSync(directory, { recursive: true, force: true })
  }
  return { created, removed, makeDataDirectory, removeDataDirectory }
}

const silentLog = () => {}

describe('smoke-user-message temp directory cleanup', () => {
  it('cleans the temp directory exactly once on a fully successful turn', async () => {
    const tracking = makeTrackingDirectories()
    const { resources, processNextUserMessageEvent } = fakeResources()
    const logged: string[] = []

    const result = await runSmokeUserMessage({
      createResources: () => resources,
      makeDataDirectory: tracking.makeDataDirectory,
      removeDataDirectory: tracking.removeDataDirectory,
      modelName: 'test-model',
      log: line => logged.push(line),
    })

    expect(result).toBe(false)
    expect(tracking.removed).toEqual(tracking.created)
    expect(existsSync(tracking.created[0])).toBe(false)
    expect(processNextUserMessageEvent).toHaveBeenCalledOnce()
    expect(logged[0]).toBe('model=test-model')
  })

  it('removes the directory with the default rmSync cleanup when setup fails before resources exist', async () => {
    const setupError = new Error('setup boom')
    const dir = mkdtempSync(path.join(tmpdir(), 'smoke-user-message-test-'))
    leftoverDirectories.push(dir)
    const errors: string[] = []

    const promise = runSmokeUserMessage({
      createResources: () => {
        throw setupError
      },
      makeDataDirectory: () => dir,
      error: line => errors.push(line),
      log: silentLog,
    })

    await expect(promise).rejects.toBe(setupError)
    expect(existsSync(dir)).toBe(false)
    expect(errors).toEqual([])
  })

  it('closes resources before removing the directory when the provider turn fails, preserving the provider error', async () => {
    const tracking = makeTrackingDirectories()
    const providerError = new Error('provider boom')
    const order: string[] = []
    const { resources } = fakeResources({
      processError: providerError,
      onClose: () => order.push('close'),
    })
    const errors: string[] = []

    const promise = runSmokeUserMessage({
      createResources: () => resources,
      makeDataDirectory: tracking.makeDataDirectory,
      removeDataDirectory: directory => {
        order.push('remove')
        tracking.removeDataDirectory(directory)
      },
      error: line => errors.push(line),
      log: silentLog,
    })

    await expect(promise).rejects.toBe(providerError)
    expect(resources.close).toHaveBeenCalledOnce()
    expect(tracking.removed).toEqual(tracking.created)
    expect(order).toEqual(['close', 'remove'])
    expect(errors).toEqual([])
  })

  it('rethrows a directory-creation failure unchanged without touching cleanup seams', async () => {
    const creationError = new Error('mkdtemp boom')
    const removeDataDirectory = vi.fn()

    const promise = runSmokeUserMessage({
      makeDataDirectory: () => {
        throw creationError
      },
      removeDataDirectory,
    })

    await expect(promise).rejects.toBe(creationError)
    expect(removeDataDirectory).not.toHaveBeenCalled()
  })

  it('flags cleanup failures on a successful turn without throwing', async () => {
    const tracking = makeTrackingDirectories()
    const closeError = new Error('close boom')
    const removeError = new Error('rm boom')
    const { resources } = fakeResources({ closeError })
    const errors: string[] = []

    const result = await runSmokeUserMessage({
      createResources: () => resources,
      makeDataDirectory: tracking.makeDataDirectory,
      removeDataDirectory: () => {
        throw removeError
      },
      error: line => errors.push(line),
      log: silentLog,
    })

    expect(result).toBe(true)
    expect(errors).toHaveLength(2)
    expect(errors[0]).toContain('关闭运行时资源失败')
    expect(errors[0]).toContain('close boom')
    expect(errors[1]).toContain('删除临时目录失败')
    expect(errors[1]).toContain('rm boom')
  })

  it('never masks the provider error when every cleanup step fails', async () => {
    const tracking = makeTrackingDirectories()
    const providerError = new Error('provider boom')
    const closeError = new Error('close boom')
    const { resources } = fakeResources({ processError: providerError, closeError })
    const errors: string[] = []

    const promise = runSmokeUserMessage({
      createResources: () => resources,
      makeDataDirectory: tracking.makeDataDirectory,
      removeDataDirectory: () => {
        throw new Error('rm boom')
      },
      error: line => errors.push(line),
      log: silentLog,
    })

    await expect(promise).rejects.toBe(providerError)
    expect(errors).toHaveLength(2)
  })

  it('never masks the original error even when the error sink itself throws', async () => {
    const tracking = makeTrackingDirectories()
    const providerError = new Error('provider boom')
    const { resources } = fakeResources({ processError: providerError })

    const promise = runSmokeUserMessage({
      createResources: () => resources,
      makeDataDirectory: tracking.makeDataDirectory,
      removeDataDirectory: () => {
        throw new Error('rm boom')
      },
      error: () => {
        throw new Error('broken error sink')
      },
      log: silentLog,
    })

    await expect(promise).rejects.toBe(providerError)
  })
})
