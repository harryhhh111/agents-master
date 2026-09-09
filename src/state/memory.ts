import { promises as fs } from 'node:fs'
import path from 'node:path'

// memory/：agent 的经验沉淀，纯 markdown。
// 规则（见 findings 文档）：启动时读、任务后由 agent 提议追加、人审后才落盘。

/** 读取 memory 目录下全部 .md，按文件名排序拼接；目录不存在返回空串。 */
export async function loadMemory(memoryDir: string): Promise<string> {
  let files: string[]
  try {
    files = (await fs.readdir(memoryDir)).filter(f => f.endsWith('.md')).sort()
  } catch {
    return ''
  }
  const parts: string[] = []
  for (const f of files) {
    const content = await fs.readFile(path.join(memoryDir, f), 'utf8')
    if (content.trim()) parts.push(`### ${f}\n${content.trim()}`)
  }
  return parts.join('\n\n')
}

/** 追加一条 memory（人审通过后调用），返回写入的文件路径。 */
export async function appendMemory(
  memoryDir: string,
  title: string,
  content: string,
): Promise<string> {
  await fs.mkdir(memoryDir, { recursive: true })
  const date = new Date().toISOString().slice(0, 10)
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9一-鿿]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
  const filePath = path.join(memoryDir, `${date}-${slug || 'note'}.md`)
  const body = `# ${title}\n\n${content.trim()}\n`
  // 同名文件已存在则追加（同一天可能有多条相关经验）
  try {
    await fs.appendFile(filePath, `\n---\n\n${body}`)
  } catch {
    await fs.writeFile(filePath, body)
  }
  return filePath
}
