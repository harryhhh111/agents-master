import { configDefaults, defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // .agent-artifacts 存放复核快照等产物，其中可能含 repo 拷贝，不是项目测试。
    exclude: [...configDefaults.exclude, '.agent-artifacts/**'],
  },
})
