import { Box, Static, Text, useApp } from 'ink'
import type React from 'react'
import { useEffect, useRef, useState } from 'react'
import { AgentCore, type AgentEvent } from '../agent/loop.js'
import type { Config } from '../config.js'
import { runSlashCommand } from './commands.js'
import { InputBox } from './components/InputBox.js'
import { MessageView } from './components/MessageView.js'
import { StatusBar } from './components/StatusBar.js'
import { pendingAsk, reduceChat, splitLive, type ChatAction, type ChatItem } from './messages.js'

export interface AppProps {
  config: Config
  projectName: string
}

/** TUI 主组件：长驻一个 AgentCore，事件经 reduceChat 折成消息数组渲染。
 * 布局：Static 渲染已落定历史，动态区 = 状态栏 + 进行中 tool + 输入框。
 */
export function App({ config, projectName }: AppProps): React.JSX.Element {
  const { exit } = useApp()
  const project = config.projects.find(p => p.name === projectName)
  const [items, setItems] = useState<ChatItem[]>(() =>
    reduceChat([], {
      type: 'system',
      text: `已连接项目「${projectName}」。输入目标开始；/help 查看命令；Ctrl+C 或 /exit 退出。`,
    }),
  )
  const [busyCount, setBusyCount] = useState(0)
  const [now, setNow] = useState(() => new Date())
  const [runningRuns, setRunningRuns] = useState(0)
  const [sessionStatus, setSessionStatus] = useState('kimi/codex: 探测中…')

  const askResolverRef = useRef<((answer: string) => void) | null>(null)
  const coreInitErrorRef = useRef<string | null>(null)
  const coreRef = useRef<AgentCore | null>(null)
  if (coreRef.current === null && coreInitErrorRef.current === null) {
    try {
      coreRef.current = new AgentCore({
        config,
        projectName,
        onEvent: (e: AgentEvent) => dispatch({ type: 'event', event: e }),
        askUser: (question, context) =>
          new Promise<string>(resolve => {
            // 'ask' 事件已先把卡片插进对话区，这里只等用户在输入框提交回答
            void question
            void context
            askResolverRef.current = resolve
          }),
      })
    } catch (e) {
      // 典型情况：DEEPSEEK_API_KEY 未配置。TUI 照常可用（斜杠命令不依赖 LLM），
      // 用户发消息时才以 error 事件提示。
      coreInitErrorRef.current = e instanceof Error ? e.message : String(e)
    }
  }

  function dispatch(action: ChatAction): void {
    setItems(prev => reduceChat(prev, action))
  }

  // 时钟 + run 数 + 两边 CLI 的 session 钉住状态，低频刷新
  useEffect(() => {
    const tick = (): void => {
      setNow(new Date())
      const core = coreRef.current
      if (!core) {
        setSessionStatus('agent 未启动')
        return
      }
      setRunningRuns(core.context.runs.list().filter(r => r.status === 'running').length)
      void (async () => {
        const [kimi, codex] = await Promise.all([
          core.context.pins.getPin(projectName, 'kimi'),
          core.context.pins.getPin(projectName, 'codex'),
        ])
        const fmt = (p: { sessionId: string } | null): string =>
          p ? `钉住(${p.sessionId.slice(0, 8)})` : '未钉住'
        setSessionStatus(`kimi: ${fmt(kimi)} codex: ${fmt(codex)}`)
      })()
    }
    tick()
    const timer = setInterval(tick, 1000)
    return () => clearInterval(timer)
  }, [projectName])

  const runCommand = (input: string): void => {
    if (!project) return
    void runSlashCommand(input, {
      projectPath: project.path,
      runs: coreRef.current?.context.runs ?? null,
    })
      .then(text => dispatch({ type: 'system', text }))
      .catch((e: unknown) =>
        dispatch({
          type: 'system',
          text: `命令执行失败: ${e instanceof Error ? e.message : String(e)}`,
        }),
      )
  }

  const handleSubmit = (raw: string): void => {
    const text = raw.trim()
    if (!text) return
    if (text === '/exit') {
      exit()
      return
    }
    if (text.startsWith('/')) {
      runCommand(text)
      return
    }
    // 决策点待答：输入即答案
    if (askResolverRef.current) {
      const resolve = askResolverRef.current
      askResolverRef.current = null
      dispatch({ type: 'answer', text })
      resolve(text)
      return
    }
    dispatch({ type: 'user', text })
    const core = coreRef.current
    if (!core) {
      dispatch({
        type: 'event',
        event: {
          type: 'error',
          message: `agent 大脑未启动（${coreInitErrorRef.current ?? '未知原因'}），当前只能用斜杠命令`,
        },
      })
      return
    }
    setBusyCount(c => c + 1)
    void core.handleUserMessage(text).finally(() => setBusyCount(c => c - 1))
  }

  const ask = pendingAsk(items)
  const { settled, liveTools } = splitLive(items)

  return (
    <Box flexDirection="column">
      <Static items={settled}>{item => <MessageView key={item.id} item={item} />}</Static>
      {coreInitErrorRef.current ? (
        <Text color="red">LLM 不可用: {coreInitErrorRef.current}（斜杠命令不受影响）</Text>
      ) : null}
      <StatusBar
        projectName={projectName}
        sessionStatus={sessionStatus}
        runningRuns={runningRuns}
        busy={busyCount > 0}
        delegation={config.delegation.level}
        now={now}
      />
      {liveTools.map(item => (
        <MessageView key={item.id} item={item} />
      ))}
      <InputBox
        prompt={ask ? `回答「${ask.question.slice(0, 30)}${ask.question.length > 30 ? '…' : ''}」>` : '你>'}
        promptColor={ask ? 'yellow' : 'green'}
        onSubmit={handleSubmit}
      />
    </Box>
  )
}
