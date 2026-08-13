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
    })
    .default({ codex: { sandbox_mode: 'workspace-write' }, kimi: {} }),
})

export type Config = z.infer<typeof ConfigSchema>

export function loadConfig(configPath = path.resolve(process.cwd(), 'config.toml')): Config {
  const raw = fs.readFileSync(configPath, 'utf-8')
  return ConfigSchema.parse(parse(raw))
}
