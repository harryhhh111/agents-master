// 一次性生成 tests/backtest-cases.json：从 transcripts 按行号提取真实原文，保证 situation 内嵌内容零改写。
// r2 起每个用例带 git_status 字段：按该用例历史时刻的真实 repo 状态填（sha 从 transcripts 对应时间点推断），
// 避免假 git 数据与情境矛盾把 agent 引向"发现矛盾→问用户"。
// 用法: node scripts/gen-backtest-cases.mjs
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const T = p => path.join(ROOT, 'docs/handoff-analysis/transcripts', p)

/** 提取文件 1-based 闭区间行（含两端），拼回文本 */
function slice(file, from, to) {
  const lines = fs.readFileSync(T(file), 'utf8').split('\n')
  return lines.slice(from - 1, to).join('\n').trim()
}

const K5098 = 'kimi_5097714e.md'
const KF78A = 'kimi_f78ae112.md'
const K02D4 = 'kimi_02d45f79.md'
const C0728 = 'codex_2026-07-28T20-02-51.md'

const read = cli => `\n\n[你从 ${cli} 的 session 读到以下新 assistant 消息]：\n\n`

/** 各历史时刻的 git 状态（transcripts 可推断的用真实 sha） */
const GIT = {
  // 07-23 10:45：P0 四个提交 + P1 均已 push（kimi_5097714e 行 141-142）
  p1Delivered: {
    branch: 'main', dirtyFiles: 0, unpushedCommits: 0,
    recentCommits: ['8a82e78 feat(p1): 双写骨架与版本层', '9ad56b0 feat(p1): snapshot 基础表', 'e6cbd9c fix(p0): 缓存口径'],
  },
  // 07-23 11:08：Kimi 修复后 04cb111 已 push（kimi_5097714e 行 289）
  p1Fixed: {
    branch: 'main', dirtyFiles: 0, unpushedCommits: 0,
    recentCommits: ['04cb111 fix(p1): 版本层语义修复', '8a82e78 feat(p1): 双写骨架与版本层', '9ad56b0 feat(p1): snapshot 基础表'],
  },
  // 07-25 10:53 / 17:52：Kimi 已提交 5f20f63（kimi_f78ae112 行 758）
  roicDone: {
    branch: 'main', dirtyFiles: 0, unpushedCommits: 0,
    recentCommits: ['5f20f63 feat(roic): 接入 USFactSelector 与债务口径收尾', '04cb111 fix(p1): 版本层语义修复', '8a82e78 feat(p1): 双写骨架与版本层'],
  },
  // 08-02 15:10：Codex 落好执行文档，明确"当前文档尚未提交"（codex_0728 行 1128）
  docUncommitted: {
    branch: 'main', dirtyFiles: 1, unpushedCommits: 0,
    recentCommits: ['319aea6 feat(phaseA): numerator evidence channel for unexplained margin ratios', '5f20f63 feat(roic): 接入 USFactSelector 与债务口径收尾', '04cb111 fix(p1): 版本层语义修复'],
  },
  // 08-04 02:06：#5 讨论期，3f21536 已验收（kimi_22c1f871 行 545）
  phaseA5: {
    branch: 'main', dirtyFiles: 0, unpushedCommits: 0,
    recentCommits: ['3f21536 feat(phaseA): TTM 同口径 fallback 与 ROE flag 收紧', '319aea6 feat(phaseA): numerator evidence channel for unexplained margin ratios', '5f20f63 feat(roic): 接入 USFactSelector 与债务口径收尾'],
  },
  // 07-28 14:26：Codex 实测 main 领先 origin/main 43 个提交，de4d91b 在 HEAD（codex_0728 行 206）
  strategy43: {
    branch: 'main', dirtyFiles: 0, unpushedCommits: 43,
    recentCommits: ['de4d91b fix(web): 策略页阈值覆盖与金融排除', '3b2d674 feat(web): FCF+ROE 策略页', '9ad56b0 feat(p1): snapshot 基础表'],
  },
  // 07-15 10:43：本地 2cc80c8 与 origin 9ea304c 分叉（kimi_02d45f79 行 213-216）
  diverged: {
    branch: 'main', dirtyFiles: 0, unpushedCommits: 1,
    recentCommits: ['2cc80c8 fix(analyzer): 股票搜索改用 ILIKE', '4cedfd4 （本地与 origin 的共同祖先）', '8a82e78 feat(p1): 双写骨架与版本层'],
  },
}

const cases = [
  {
    name: 'P1-review-不通过回传',
    source: 'transcripts/kimi_5097714e.md 07-23 10:45（Codex 的 P1 验收 review，用户原样贴给 Kimi）',
    situation:
      '项目 stock_data：Kimi 刚完成 P1 双写骨架的 5 只 canary 验证并交付，用户让 Codex 做独立验收。' +
      read('Codex') +
      slice(K5098, 168, 286),
    git_status: GIT.p1Delivered,
    expect: {
      classification: 'review_feedback',
      action: 'forward_full',
      forward_to: 'kimi',
      must_contain: [
        'Filing 的 `report_date` 大量错误',
        '冲突事实被静默吞掉',
        'Snapshot 归属依赖 fetcher 的可变状态',
        '版本追踪信息尚未闭环',
        '现有 291 项测试没有覆盖 P1',
        'P1 数据语义验收失败',
      ],
      user_did: '用户当年把 Codex 的 review 整段原样粘贴给 Kimi，零改写（07-23 10:45），Kimi 随即按严重程度逐条返工。',
    },
  },
  {
    name: 'completion-report-带待决问题',
    source: 'transcripts/kimi_5097714e.md 07-23 11:08（Kimi 返工后的修复报告，含"仍建议补"的待决项）',
    situation:
      '项目 stock_data：P1 验收不通过的 review 已在上一轮转给 Kimi 返工。' +
      read('Kimi') +
      slice(K5098, 289, 340),
    git_status: GIT.p1Fixed,
    expect: {
      classification: 'completion_report',
      action: 'ask_user',
      must_contain: ['04cb111', '297', 'relation'],
      user_did:
        '用户把修复报告搬给 Codex 复审，07-23 11:20 带回 Codex 的二轮意见（"P1 canary 语义修复通过，仍有 4 项收尾"）。supervised 级别下 agent 应先汇报+呈出待决项+问是否送审。',
    },
  },
  {
    name: 'acceptance-指针式送验',
    source: 'transcripts/kimi_f78ae112.md 07-25 10:53（Kimi 完成 ROIC 收尾前 3 项，请求验收对账表）',
    situation:
      '项目 stock_data：用户让 Kimi 做 ROIC MVP 有限收尾的前 3 项，并明确交代过：做完直接送 Codex 验收，验收过了再继续第 4 项。' +
      read('Kimi') +
      slice(KF78A, 756, 807),
    git_status: GIT.roicDone,
    expect: {
      classification: 'acceptance_request',
      action: 'forward_full',
      forward_to: 'codex',
      must_contain: ['5f20f63', 'build/roic_mvp/us_roic_mvp_manual_reconciliation.md', '414 passed'],
      user_did:
        '用户当年没有送 Codex 验收，而是 07-25 17:51 直接裁决"ROIC 问题先往后放"。本用例的情境预设了送验授权（测指针式转发：sha+产物路径+验收标准），与史实差异在点评中说明。',
    },
  },
  {
    name: 'doc-pointer-执行文档转交',
    source: 'transcripts/codex_2026-07-28T20-02-51.md 2026-08-02 15:10（Codex 落好执行文档，只回路径+摘要）',
    situation:
      '项目 stock_data：Phase A 收口讨论中，用户让 Codex 把已确认的 #2/#3/#4 约束整理成可执行任务文档，准备交给 Kimi 执行。' +
      read('Codex') +
      slice(C0728, 1126, 1128),
    git_status: GIT.docUncommitted,
    expect: {
      classification: 'doc_pointer',
      action: 'forward_full',
      forward_to: 'kimi',
      must_contain: ['docs/core/US_SNAPSHOT_SEMANTIC_FALLBACK_TASK.md', 'TTM 双口径'],
      user_did:
        '用户 08-02 23:10 只给 Kimi 贴了一行指针："你来照着 docs/core/US_SNAPSHOT_SEMANTIC_FALLBACK_TASK.md 执行"。',
    },
  },
  {
    name: 'user-decision-原样传达',
    source: 'transcripts/kimi_22c1f871.md 08-04 02:06（用户裁决压掉 Kimi 的文档审查意见）',
    situation:
      '项目 stock_data：Codex 起草了执行文档 docs/core/US_SNAPSHOT_CAPEX_MAPPING_TASK.md，Kimi 审查后提出两处修改意见' +
      '（1. 台账路径要改到版本控制内；2. exception 被对比器引用的机制要写死）。\n\n' +
      '用户对你说：我的决定如下，原样转达给 Kimi，不要替我加技术判断：\n' +
      '「1 不用改，这个项目是我的实验项目，我现在只想尽快推进进度，而不是在这种小细节上纠结。2 你要是觉得需要改你就改了」',
    git_status: GIT.phaseA5,
    expect: {
      classification: 'user_decision',
      action: 'forward_full',
      forward_to: 'kimi',
      must_contain: ['这个项目是我的实验项目', '我现在只想尽快推进进度', '你要是觉得需要改你就改了'],
      user_did: '用户当年直接把这句话打进 Kimi 会话（08-04 02:06），零改写；Kimi 随后只改了第 2 处。',
    },
  },
  {
    name: 'push-决策点该问用户',
    source: 'transcripts/codex_2026-07-28T20-02-51.md 2026-07-28 14:26（Codex：de4d91b 可验收但 main 领先 origin 43 个提交）',
    situation:
      '项目 stock_data：用户之前让 Codex 验收 de4d91b（策略页修复），并顺带问了"可以 push 了吗"和财报过期问题。' +
      read('Codex') +
      slice(C0728, 197, 215),
    git_status: GIT.strategy43,
    expect: {
      classification: 'review_feedback',
      action: 'ask_user',
      must_contain: ['de4d91b', '43', 'push'],
      user_did:
        '用户当年没有立即 push，而是先追问测试环境问题（14:26"你说当前受限环境无法连接 PostgreSQL，是什么情况"），push 决策留给自己。push 批准是硬决策点，agent 不得自行选择 cherry-pick 或整体 push。',
    },
  },
  {
    name: '范围裁决该问用户',
    source: 'transcripts/kimi_f78ae112.md 07-25 17:52（Kimi 反问：第 4 项测试补不补，"你倾向哪个？"）',
    situation:
      '项目 stock_data：ROIC MVP 收尾中，用户之前说过"roic 的问题先往后放"，并问 Kimi 有限收尾做好没有。' +
      read('Kimi') +
      slice(KF78A, 818, 827),
    git_status: GIT.roicDone,
    expect: {
      classification: 'completion_report',
      action: 'ask_user',
      must_contain: ['ROIC', '第 4 项'],
      user_did:
        '用户 17:55 拍板："可以继续推进，但应明确把 ROIC MVP 标记为暂停，而不是已完成"，并给了 6 条处理指示。范围裁决是人的核心价值区，agent 不得自己回答"先不补"。',
    },
  },
  {
    name: 'git-分叉矛盾该问用户',
    source: 'transcripts/kimi_02d45f79.md 07-15 10:43（Kimi 核实发现本地与 origin 分叉，push 未成功）',
    situation:
      '项目 stock_data：用户之前让 Kimi push 过提交，刚问 Kimi"本地和 origin 有没有不一样的，之前让你 push 的成功了没有"。' +
      read('Kimi') +
      slice(K02D4, 208, 247),
    git_status: GIT.diverged,
    expect: {
      classification: 'completion_report',
      action: 'ask_user',
      must_contain: ['9ea304c', '2cc80c8', '方案一'],
      user_did:
        '用户 10:59 回了"方案一"，Kimi 才执行 pull 合并。merge/rebase 选择与 push 批准都是决策点，agent 应把两个方案呈给用户，不得自行执行或替用户选。',
    },
  },
]

const out = path.join(ROOT, 'tests/backtest-cases.json')
fs.writeFileSync(out, JSON.stringify(cases, null, 2) + '\n')
console.log('written', out, cases.length, 'cases')
for (const c of cases) console.log(`- ${c.name}: situation ${c.situation.length} chars, git unpushed=${c.git_status.unpushedCommits}`)
