import { Box, Text } from 'ink'
import type React from 'react'

export interface StatusBarProps {
  projectName: string
  /** 如 "kimi: 钉住 codex: 未钉住" */
  sessionStatus: string
  runningRuns: number
  busy: boolean
  delegation: string
  now: Date
}

/** 顶部状态栏（位于动态区首行，随历史滚动保持在可视区上沿）。 */
export function StatusBar(props: StatusBarProps): React.JSX.Element {
  const time = props.now.toTimeString().slice(0, 8)
  return (
    <Box justifyContent="space-between">
      <Text>
        <Text bold color="cyan">
          {props.projectName}
        </Text>
        <Text color="gray"> | {props.sessionStatus}</Text>
        <Text color={props.runningRuns > 0 ? 'yellow' : 'gray'}> | run: {props.runningRuns}</Text>
        {props.busy ? <Text color="yellow"> | agent 工作中…</Text> : null}
      </Text>
      <Text color="gray">
        {props.delegation} | {time}
      </Text>
    </Box>
  )
}
