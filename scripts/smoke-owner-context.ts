#!/usr/bin/env tsx
// Explicit opt-in: makes four paid model requests with synthetic data only.
// CLI exit 1 = failure; exit 2 = automated checks passed, manual review pending.
import { pathToFileURL } from 'node:url'
import { loadConfig } from '../src/config.js'
import { composeFrontBrainContext, createFrontBrain } from '../src/frontbrain/index.js'
import { defaultMainAgentInstructions } from '../src/main/foreground.js'
import { ownerContextCheckpoint } from '../src/main/owner-context.js'
import type { FrontBrain } from '../src/frontbrain/index.js'
import type { MainConversationMessage } from '../src/main/types.js'

const checkpoint = '合成验收资料（虚构主人）：主人目前居住在青岛。此资料仅用于 smoke 验收。'
const question: MainConversationMessage = {
  id: 'synthetic-question',
  role: 'user',
  content: '根据主人上下文，我目前居住在哪个城市？只输出城市名称，不加说明。',
  createdAt: '2026-10-08T00:02:00.000Z',
}
const priorHistory: MainConversationMessage[] = [
  { id: 'synthetic-prior-question', role: 'user', content: '你对我有了解吗？', createdAt: '2026-10-08T00:00:00.000Z' },
  { id: 'synthetic-prior-error', role: 'assistant', content: '没有，我没有收到任何主人背景。', createdAt: '2026-10-08T00:01:00.000Z' },
]

// Entirely fictional facts, independent of any owner's saved data.
const broadCheckpoint = ownerContextCheckpoint([
  '合成验收资料（完全虚构主人，仅用于 smoke）：',
  '目前居住在云岬市。职业是天文馆讲解员。项目名称：纸月观测日志。',
  '沟通偏好是先结论后细节。',
].join('\n'))
const repeatedHistory: MainConversationMessage[] = [
  ...priorHistory,
  { id: 'synthetic-followup', role: 'user', content: '我之前提供的背景呢？', createdAt: '2026-10-08T00:02:00.000Z' },
  { id: 'synthetic-error-2', role: 'assistant', content: '我看不到任何关于你的背景，无法了解你的城市、工作或偏好。', createdAt: '2026-10-08T00:03:00.000Z' },
  { id: 'synthetic-followup-2', role: 'user', content: '你再确认一下。', createdAt: '2026-10-08T00:04:00.000Z' },
  { id: 'synthetic-error-3', role: 'assistant', content: '确认过了，我仍然没有你的背景。请重新告诉我你的情况。', createdAt: '2026-10-08T00:05:00.000Z' },
]
const broadQuestion: MainConversationMessage = {
  id: 'synthetic-broad-question',
  role: 'user',
  content: '现在你对我有什么了解？\n请只输出一个 JSON 对象：city、occupation、project、communicationPreference 分别填写你已知的城市、职业、项目名称、沟通偏好，未知填 null；priorDenialWasWrong 填布尔值，表示先前声称没有背景是否错误。不要添加其他字段或说明。',
  createdAt: '2026-10-08T00:06:00.000Z',
}
const naturalQuestion: MainConversationMessage = {
  ...broadQuestion,
  id: 'synthetic-natural-question',
  content: '现在你对我有什么了解？',
}

export function isExpectedCity(text: string): boolean {
  const normalized = text.replace(/[\s。，、！？；：,.!?;:'"“”‘’（）()【】\[\]《》<>]/gu, '')
  return normalized === '青岛' || normalized === '青岛市'
}

/** Exact structured assertions, not keyword matching that can accept denials. */
export function isExpectedOwnerKnowledge(text: string): boolean {
  try {
    const value: unknown = JSON.parse(text)
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false
    const expected = {
      city: '云岬市',
      occupation: '天文馆讲解员',
      project: '纸月观测日志',
      communicationPreference: '先结论后细节',
      priorDenialWasWrong: true,
    }
    return Object.keys(value).length === Object.keys(expected).length
      && Object.entries(expected).every(([key, fact]) => (value as Record<string, unknown>)[key] === fact)
  } catch {
    return false
  }
}

/** Imports stay offline; only the explicit CLI entrypoint creates a real client. */
export async function runOwnerContextSmoke(
  setup: () => FrontBrain | Promise<FrontBrain>,
  log: (line: string) => void = console.log,
): Promise<'fail' | 'needs-review'> {
  log('Synthetic owner-context smoke: four paid requests. Natural answers require manual review; automated PASS is not acceptance with real history.')
  try {
    const brain = await setup()
    let passedAll = true
    for (const [label, history, context, prompt, check, maxOutputTokens] of [
      ['fresh', [], checkpoint, question, isExpectedCity, 128],
      ['prior-incorrect-assistant', priorHistory, checkpoint, question, isExpectedCity, 128],
      ['repeated-incorrect-assistant-broad', repeatedHistory, broadCheckpoint, broadQuestion, isExpectedOwnerKnowledge, 512],
      ['repeated-incorrect-assistant-natural', repeatedHistory, broadCheckpoint, naturalQuestion, undefined, 512],
    ] as const) {
      const response = await brain.complete({
        messages: composeFrontBrainContext({
          instructions: defaultMainAgentInstructions,
          checkpoint: context,
          groundCurrentTurn: true,
          messages: [...history, prompt],
        }),
        maxOutputTokens,
      })
      if (!check) {
        if (!response.text.trim()) {
          log(`${label}: FAIL | empty reply`)
          passedAll = false
        } else {
          log(`${label}: NEEDS_REVIEW | ${response.text}`)
          log('Manual review: substantively states 云岬市 / 天文馆讲解员 / 纸月观测日志 / 先结论后细节; corrects prior denials without inventing their cause; no unsupported facts or authority. Keywords alone do not pass.')
        }
        continue
      }
      const passed = check(response.text)
      log(`${label}: ${passed ? 'PASS' : 'FAIL'} | ${response.text}`)
      if (!passed) passedAll = false
    }
    log(passedAll ? 'NEEDS_REVIEW: automated checks passed; natural answer has not been accepted.' : 'FAIL: at least one automated check failed.')
    return passedAll ? 'needs-review' : 'fail'
  } catch {
    // Provider/SDK errors may include headers or credentials: never print them.
    log('FAIL: owner-context smoke setup or provider request failed.')
    return 'fail'
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await runOwnerContextSmoke(async () => {
    await import('dotenv/config')
    return createFrontBrain(loadConfig())
  })
  process.exitCode = result === 'fail' ? 1 : 2
}
