import { render } from 'ink'
import React from 'react'
import { loadConfig } from '../config.js'
import { App } from './App.js'

/** 启动 Ink TUI：agent <项目名> 的默认入口。 */
export async function runTui(projectName: string): Promise<void> {
  const config = loadConfig()
  if (!config.projects.some(p => p.name === projectName)) {
    const names = config.projects.map(p => p.name).join(', ')
    throw new Error(`配置里找不到项目「${projectName}」（config.toml 里有: ${names}）`)
  }
  const { waitUntilExit } = render(React.createElement(App, { config, projectName }))
  await waitUntilExit()
}
