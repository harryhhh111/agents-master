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
    /** 权限档位（docs/product-discovery-v0.md 2026-10-26）：
     *  readonly=只读视野，无写无执行；supervised=审批制（默认，写/执行逐项待确认）；
     *  workspace=授权目录内写与命令自动执行，越界仍逐项审批。
     *  界面切换的档位以预览数据目录内的覆盖文件为准，本配置是默认值。 */
    level: z.enum(['readonly', 'supervised', 'workspace']).default('supervised'),
  }),
  projects: z.array(
    z.object({
      name: z.string(),
      path: z.string(),
      /** 给主 Agent 的一句话项目说明（list_projects 返回）。 */
      summary: z.string().default(''),
      /** 是否允许 delegate_cli 真实执行；阅读范围不因 false 而收窄。 */
      delegable: z.boolean().default(false),
    }),
  ),
  /** 项目发现根：其下一级目录自动成为主 Agent 的可读项目（只读视野）；
   *  delegate_cli 可执行范围仍仅由 [[projects]] 的 delegable 决定。 */
  workspace: z.object({
    roots: z.array(z.string()).default([]),
  }).default({ roots: [] }),
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
