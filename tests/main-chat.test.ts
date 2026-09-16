import { describe, expect, it, vi } from 'vitest'
import {
  createMainChatHandlers,
  mainChatHelp,
  defaultMainChatDataDirectory,
  parseMainChatArguments,
} from '../scripts/main-chat.js'

describe('main chat argument helpers', () => {
  it('uses a documented private per-user default and accepts an explicit data directory', () => {
    expect(defaultMainChatDataDirectory('/home/alice')).toBe('/home/alice/.local/share/agents-master/main-chat')
    expect(parseMainChatArguments([], '/home/alice')).toEqual({
      dataDirectory: '/home/alice/.local/share/agents-master/main-chat',
    })
    expect(parseMainChatArguments(['--data-dir', '/secure/chat'], '/home/alice'))
      .toEqual({ dataDirectory: '/secure/chat' })
  })

  it('rejects missing or unknown arguments before creating a runtime', () => {
    expect(() => parseMainChatArguments(['--data-dir'], '/home/alice')).toThrow('--data-dir 需要一个非空目录')
    expect(() => parseMainChatArguments(['--unknown'], '/home/alice')).toThrow('未知参数: --unknown')
  })
})

describe('main chat line handlers', () => {
  it('rejects buffered lines after /exit and waits exactly once before closing resources', async () => {
    let finish!: () => void
    const drain = new Promise<void>(resolve => { finish = resolve })
    const host = { submit: vi.fn(), recover: vi.fn(), waitForIdle: vi.fn(() => drain) }
    const write = vi.fn()
    const closeResources = vi.fn()
    let closed!: Promise<void>
    const closeInput = vi.fn(() => { closed = handlers.onClose().then(closeResources) })
    const handlers = createMainChatHandlers(host, write, closeInput)

    handlers.onLine('/exit')
    handlers.onLine('buffered message')
    handlers.onLine('/help')
    handlers.onLine('/recover')
    handlers.onLine('/exit')
    expect(host.submit).not.toHaveBeenCalled()
    expect(host.recover).not.toHaveBeenCalled()
    expect(write).toHaveBeenCalledTimes(1)
    expect(closeInput).toHaveBeenCalledTimes(1)
    expect(handlers.onClose()).toBe(handlers.onClose())
    expect(host.waitForIdle).toHaveBeenCalledTimes(1)
    await Promise.resolve()
    expect(closeResources).not.toHaveBeenCalled()
    finish()
    await closed
    expect(closeResources).toHaveBeenCalledTimes(1)
  })

  it('preserves help, recovery and ordinary submission before closing', () => {
    const host = { submit: vi.fn(), recover: vi.fn(), waitForIdle: vi.fn(async () => {}) }
    const write = vi.fn()
    const handlers = createMainChatHandlers(host, write, vi.fn())
    handlers.onLine('  /help  ')
    expect(write).toHaveBeenLastCalledWith(mainChatHelp)
    handlers.onLine('/recover')
    expect(host.recover).toHaveBeenCalledTimes(1)
    expect(write).toHaveBeenLastCalledWith('未执行恢复：仅在前台回合失败且处理已结束后才能恢复。')
    host.recover.mockReturnValueOnce(1)
    write.mockClear()
    handlers.onLine('/recover')
    expect(write).not.toHaveBeenCalled()
    handlers.onLine('  hello  ')
    expect(host.submit).toHaveBeenCalledExactlyOnceWith({ content: '  hello  ', idempotencyKey: expect.any(String) })
    expect(host.waitForIdle).not.toHaveBeenCalled()
  })
})
