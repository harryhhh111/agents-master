import fs from 'node:fs'
import path from 'node:path'
import { parse } from 'smol-toml'
import { z } from 'zod'

const ConfigSchema = z.object({
  llm: z.object({
    base_url: z.string().url(),
    model: z.string(),
  }),
  delegation: z.object({
    level: z.enum(['supervised']).default('supervised'),
  }),
  projects: z.array(
    z.object({
      name: z.string(),
      path: z.string(),
    }),
  ),
  backends: z
    .object({
      codex: z
        .object({
          sandbox_mode: z.string().default('workspace-write'),
        })
        .default({ sandbox_mode: 'workspace-write' }),
      kimi: z.object({}).default({}),
      claude: z
        .object({
          /** claude 二进制（PATH 里的命令名或绝对路径），环境变量 CKRUNNER_CLAUDE_BINARY 优先 */
          binary: z.string().default('claude'),
          /**
           * 非交互委派编码任务默认 acceptEdits：可在目标工作区编辑而不等待 TTY 确认，
           * 但不等同 bypassPermissions，不会一并授予命令或其他更广泛权限。
           */
          permission_mode: z.string().default('acceptEdits'),
        })
        .default({ binary: 'claude', permission_mode: 'acceptEdits' }),
    })
    .default({
      codex: { sandbox_mode: 'workspace-write' },
      kimi: {},
      claude: { binary: 'claude', permission_mode: 'acceptEdits' },
    }),
})

export type Config = z.infer<typeof ConfigSchema>

export function loadConfig(configPath = path.resolve(process.cwd(), 'config.toml')): Config {
  const raw = fs.readFileSync(configPath, 'utf-8')
  return ConfigSchema.parse(parse(raw))
}
