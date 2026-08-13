import { Box, Text } from 'ink'
import type React from 'react'
import type { ChatItem } from '../messages.js'

function ToolLine({ item }: { item: Extract<ChatItem, { kind: 'tool' }> }): React.JSX.Element {
  if (!item.done) {
    const args = JSON.stringify(item.args) ?? ''
    const compact = args.length > 100 ? args.slice(0, 100) + '…' : args
    return (
      <Text color="gray">
        {'⏺ '}
        <Text color="cyan">{item.name}</Text> {compact}
      </Text>
    )
  }
  const icon = item.ok ? '✓' : '✗'
  return (
    <Text color={item.ok ? 'gray' : 'red'} wrap="truncate-end">
      {icon} <Text color={item.ok ? 'cyan' : 'red'}>{item.name}</Text>: {item.summary}
    </Text>
  )
}

function AskCard({ item }: { item: Extract<ChatItem, { kind: 'ask' }> }): React.JSX.Element {
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={item.answer === undefined ? 'yellow' : 'gray'}
      paddingX={1}
      marginY={0}
    >
      <Text bold color="yellow">
        决策点 — agent 在等你拍板
      </Text>
      <Text>{item.question}</Text>
      {item.context ? <Text color="gray">背景: {item.context}</Text> : null}
      {item.answer !== undefined ? (
        <Text color="green">你的回答: {item.answer}</Text>
      ) : (
        <Text color="yellow" dimColor>
          直接在下方输入框输入回答，回车提交
        </Text>
      )}
    </Box>
  )
}

/** 单条对话区消息的渲染：四类气泡/区块的视觉区分都在这里。 */
export function MessageView({ item }: { item: ChatItem }): React.JSX.Element {
  switch (item.kind) {
    case 'user':
      return (
        <Text>
          <Text bold color="green">
            你{'> '}
          </Text>
          {item.text}
        </Text>
      )
    case 'agent':
      return (
        <Text>
          <Text bold color="magenta">
            agent{'> '}
          </Text>
          {item.text}
        </Text>
      )
    case 'tool':
      return <ToolLine item={item} />
    case 'ask':
      return <AskCard item={item} />
    case 'error':
      return <Text color="red">✗ {item.text}</Text>
    case 'system':
      return <Text color="blue">{item.text}</Text>
  }
}
