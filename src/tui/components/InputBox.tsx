import { Box, Text, useInput } from 'ink'
import type React from 'react'
import { useState } from 'react'

export interface InputBoxProps {
  /** 提示语，如 "你>" 或 "回答: …>" */
  prompt: string
  promptColor?: string
  onSubmit: (text: string) => void
}

/** 底部输入框：自绘单行编辑（回车提交、退格删除），agent 工作期间始终可输入。 */
export function InputBox({ prompt, promptColor = 'green', onSubmit }: InputBoxProps): React.JSX.Element {
  const [value, setValue] = useState('')

  useInput((input, key) => {
    if (key.return) {
      const text = value
      setValue('')
      if (text.trim()) onSubmit(text)
      return
    }
    if (key.backspace || key.delete) {
      setValue(v => v.slice(0, -1))
      return
    }
    if (key.ctrl || key.meta || key.escape) return
    if (key.upArrow || key.downArrow || key.leftArrow || key.rightArrow) return
    // ink 不拆文本 chunk 里的 \r/\n（粘贴/管道输入可能带换行），整段到达时按行各自提交
    if (/[\r\n]/.test(input)) {
      const segments = input.split(/[\r\n]+/)
      const first = (value + (segments[0] ?? '')).trim()
      setValue('')
      if (first) onSubmit(first)
      for (const s of segments.slice(1)) {
        const line = s.trim()
        if (line) onSubmit(line)
      }
      return
    }
    // 过滤制表符等不可见字符；粘贴的多字符输入直接追加
    const printable = input.replace(/[^\x20-\x7e\u00a0-\uffff]/g, '')
    if (printable) setValue(v => v + printable)
  })

  return (
    <Box>
      <Text bold color={promptColor}>
        {prompt}
      </Text>
      <Text> {value}</Text>
      <Text color="gray">▌</Text>
    </Box>
  )
}
