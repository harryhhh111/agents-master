
===== [07-22 14:07:04] USER =====
你是什么模型，现在是在什么 agent 里面

===== [07-22 14:07:35] KIMI =====
我是 Kimi Code CLI 里的 AI 编程助手；当前运行在 **Kimi Code CLI agent** 会话中，工作目录是 `/home/vinci/projects/stock_data`。

具体底层模型版本我这里无法直接查看。

===== [07-22 18:14:37] USER =====
你看一下 /home/vinci/projects/stock_data/docs/core/US_REPORT_PERIOD_REPAIR_RUNBOOK.md，给出你的意见

===== [07-22 18:14:45] KIMI =====
我先读这份 runbook，再给你具体意见。

===== [07-22 18:15:07] KIMI =====
我会对照现有代码路径看这份 runbook 是否可执行。

===== [07-22 18:16:24] KIMI =====
我再验证一下测试覆盖和数据库现状，避免只评文档。

===== [07-22 18:19:30] KIMI =====
结论：这份 runbook 方向是对的，根因判断也和代码、数据库现状一致；但它现在更像“原则正确的修复方案”，还不够像“可直接执行的生产修复手册”。如果按它落地，我建议先补强几处，否则有二次污染历史数据的风险。

我核对到的事实：

- 根因确实存在：`core/fetchers/us_financial.py:631-634` 会在 `fp in ("FY", "", None)` 时把 `CY2025Q4I` 这种 instant frame 改成 `Q4`；后面 `core/transformers/us_gaap.py:433-437` 又只按 `fp` 走 `SEC_FP_MAP`，于是 `Q4 -> quarterly`。
- `form` 当前确实没有进入链路：`core/fetchers/us_financial.py:638-650` 的 records 没有收集 `entry["form"]`，pivot/groupby 后也没有保留；transformer 只保存了 `frame`，没有用 `form`。
- 数据库现状吻合：PLTR `2025-12-31` 同一 accession `0001321655-26-000011` 下，`income/cashflow = annual`，`balance = quarterly`。
- 不是孤例： dry-run 样例里 ARM、ACI、KMX、HD、LULU、CRM、CRWD 等最新年报期也出现 `balance:quarterly + income/cashflow:annual` 的同款组合。

这份 runbook 的亮点：

- 先证据、先测试、再改代码、再修历史，顺序正确。
- 明确禁止用 `report_date=12-31` 推断 annual，这点很关键。
- 把 `form + fp` 作为权威来源、`frame` 只辅助，这个原则应该定死。
- 已经意识到版本选择/PIT 问题：当前 `_dedup_and_pivot()` 按 `filed` 降序保留一条，`groupby` 又用 `filed/accn = last`，确实可能丢首次披露元数据。
- 有 dry-run、审计表、分批重建、回滚、下游刷新和 DoD，骨架完整。

我建议修改/补强的点：

1. **不要简单说“删除 FY + Q#I 覆盖”**  
   代码里这个覆盖原本是为了 MELI 这类“SEC 把季度 duration 误标成 FY”的 case。正确改法是：  
   - `start` 为空或 frame 以 `I` 结尾的 instant fact：绝不用 frame 把 `FY` 改成 `Q#`；
   - duration fact 才允许在“同一 tag/end 没有纯年度 frame”时做受控修正；
   - `_frame_has_q = "Q" in frame` 太粗，应改成明确 regex，并区分 `Q4` 与 `Q4I`。

2. **period kind 的判定要反过来以 start/end 为主**  
   runbook 写 `frame endswith I or start is null -> instant`，我建议改成：  
   - `start` 存在且 `end` 存在：`duration`；
   - `start` 缺失且 `end` 存在：`instant`；
   - `frame I` 只作为佐证和 quality flag，不作为第一判据。  
   否则某些无 frame 或异常 frame 的 SEC fact 会被误分类。

3. **Q4 standalone 的边界要更硬**  
   `10-K + fp=FY + CY2025Q4` 的 duration fact 应进入 annual 行的 `_standalone` 字段，不能生成一条 `report_type=quarterly` 的主报告记录。runbook 有这个意思，但应写成验收规则：修复后 `form=10-K/fp=FY` 的 balance sheet 不允许因为 `Q4I` 产生 quarterly 行。

4. **`form` 进链路时要加冲突检测，不能默默 first/last**  
   现在 `frame` 是靠 `frame_map + merge` 保下来的，`filed/accn` 又在 groupby 时用 `last`。如果加入 `form`，建议：同一 `(end, fp, accn)` 下 `form` 不一致时进入 `quality_flags`，不要用 `first()` 静默吞掉。

5. **fallback 不能继续“返回 None 丢记录”**  
   `core/transformers/us_gaap.py:435-437` 目前 `SEC_FP_MAP.get(fp)` 失败直接跳过。runbook 说“受控 fallback + flag”，还应明确：未知 `form/fp` 组合不落主表或落为待复核记录，不能无声丢失；否则覆盖率下降会很难发现。

6. **日期口径要在 runbook 里写死**  
   数据库查询把 `2025-12-31` 显示成 `2025-12-30T16:00:00.000Z`，这类 UTC 渲染很容易让验收误判。审计表和 fixture 应同时保存 SEC 原始 `end/start` 字符串和规范化后的 `report_date`，验收以原始字符串或统一时区规则为准。

7. **审计表字段还不够完整**  
   在现有字段基础上建议加：`operation`(insert/update/merge/skip)、`pk_conflict_target`、`dry_run`、`source_snapshot_path/hash`、`parser_git_sha`、`job/actor`、`row_checksum`。回滚不能只依赖 `batch_id`，还要防止后续批次又改了同一主键。

8. **Step 7 的扫描 SQL 要把“不限 accession”的检查提升为主检查**  
   runbook 已经提醒旧数据三表可能选了不同 accession；那主扫描就不应只按 `(stock, report_date, accession)` 分组。还应加一条利用已存 `frame` 的快速扫描，例如 balance 表 `report_type='quarterly'` 但 `frame ~ 'CY\d{4}Q[1-4]I$'` 且同 stock/report_date income 为 annual 的记录。

9. ** fixture 要覆盖 parser 的脆弱路径，不只是最小字段**  
   PLTR fixture 至少还要包含：多 accession 同 tag/end/fp、同值不同 filed、不同值重述、annual duration + Q4 standalone 并存、无 frame fact、缺失 start、amendment form、非 USD 单位被过滤。否则单测过了，全量重解析仍可能翻车。

10. **补 MELI 回归样本**  
    代码注释明确提到 MELI 改财年 case。runbook 已提 HRB/AAPL/WMT 证明不依赖 12-31，但还必须加 MELI，防止修 PLTR 时把旧 MELI 修复删掉。

11. **下游刷新部分要更具体**  
    `REFRESH MATERIALIZED VIEW CONCURRENTLY` 不能在事务块内跑；需要列出唯一索引检查命令、刷新顺序、失败处理、前端/API 缓存 key 的失效方式。否则“数据库已修、页面仍旧”的验收会扯皮。

12. **缺少执行细节**  
    建议补上：具体要改的函数/文件、测试命令、dry-run 脚本入口、输出文件位置、批次大小、SEC refetch rate limit、 staging 验证流程、生产执行前快照/备份要求。现在这些还只是原则。

我的总体意见：这份 runbook 可以作为修复蓝图接受，但建议先把第 1、2、3、5、7、8 条改进去再执行历史修复。代码修复本身不难，真正高风险的是历史重建和版本选择；这部分必须从“UPDATE 三张宽表”升级成“从原始快照重解析 + staging/version 审计 + 可回滚批处理”。

===== [07-22 22:31:25] USER =====
我在选股筛选页面查看美股的 FCF+ROE 深度价值，筛选出来的公司，有的没有毛利率，是什么原因呢

===== [07-22 22:31:49] KIMI =====
我先定位筛选页面对应的接口和毛利率字段来源。

===== [07-22 22:32:51] KIMI =====
我继续看打分/过滤逻辑，并查几条实际样本确认。

===== [07-22 22:33:36] KIMI =====
上一个查询引用了物化视图里不存在的原始列，我换成回查利润表原始字段。

===== [07-22 22:34:30] KIMI =====
主要原因不是前端没显示，而是数据库里 `gross_margin` 本来就是 `NULL`。我按接近条件抽了美股样本：`FCF Yield >= 10% + 最新 annual ROE >= 12%` 的 53 只里，有 29 只毛利率为空，约 54.7%。典型如 CHTR、CMCSA、VZ、T、PGR、ALL、AMP、NTRS、ZION：`revenues` 有值，但 `cost_of_goods_sold` 和 `gross_profit` 都是 `NULL`。

链路是这样的：

- 美股筛选页用 `get_us_universe()` 取最新 annual 指标：`quant/screener/query.py:172-227`。
- `gross_margin` 来自 `mv_us_financial_indicator`：`scripts/materialized_views.sql:395-397`，公式是 `gross_profit / revenues`。
- `gross_profit` 来自 SEC `GrossProfit` 标签，或在有 `revenues + cost_of_goods_sold` 时 fallback 计算：`core/fetchers/us_financial.py:849-858`。
- 很多美股公司不披露标准 `GrossProfit`，也没有可比 `COGS`：银行、保险、券商/资管、REIT、部分电信/有线/服务公司。于是 `gross_profit = NULL`，毛利率自然为空。

为什么这些公司还能被筛出来：

- “FCF+ROE 深度价值”没有设 `gross_margin_min` 硬过滤，只把毛利率当 10% 打分因子：`quant/screener/presets.py:77-103`。
- 打分逻辑对缺失因子会做权重重分配，不会因为 `gross_margin = NaN` 剔除：`quant/screener/scorer.py:76-83`。
- 这个预设只对 A股/港股排除了银行/保险/地产等行业，美股没有配 `exclude_industries_by_market`，所以保险、银行、资管这类“毛利率本来就不适用”的公司也会进来。

还有两类次要原因：

- 标签映射缺口：比如样本里 TOL 有 `cost_of_goods_sold` 但 `revenues = NULL`，这更像收入标签没映射全，而不是公司业务没有收入。
- 报告期/年度数据缺口：如果某公司最新 annual 因 `10-K + Q4I` 分类问题没进物化视图，通常 ROE/annual 也会缺；能通过 ROE 过滤但只缺毛利率的，大概率还是上面第一类原因。

建议处理方式：

- 如果你认为“深度价值”不该混入无毛利率公司：给美股也加 `gross_margin_min`，或至少对美股排除银行/保险/REIT/资管。
- 如果想提高覆盖率：按行业补 SEC tag 映射，尤其是 revenue/COGS/gross profit 的别名；补完从原始 SEC JSON 重解析，不要硬填毛利率。
- 对金融/保险类公司，毛利率本身意义有限，页面上显示 `N/A` 比一个估算值更合理。

===== [07-22 23:44:16] USER =====
我的查询结果让另一个同事验证了一下，你看看是怎么回事：这是一份美股筛选表，包含30只股票。我先随机抽5只，然后逐只用 SEC EDGAR 官方财报数据交叉核对。
接口说明清楚了。现在我对5只股票逐一拉取 SEC EDGAR 最新年报三大报表，与表格数据交叉核对。
Verizon 数据已落盘（FY2023–FY2025 完整报表）。继续拉取其余4只：
Verizon 的关键数据已对上。现在系统地做五只股票的全面交叉验证：
核心比率已经能验证了。还差一步：表格里"ROE(前年)"需要用2023年末的净资产验证，我从 XBRL 时间序列补取这5家的更早净资产数据：
最后验证一下 PB 列到底是用什么算的（测试"市值/总资产"假设）：
核对完成。取一下各家年报的备案号与提交日期，用于标注数据来源：
# 抽查结果：数据大体真实，但部分列有硬伤

随机抽到的5只：**VZ、TDC、ACGL、GAP、AIZ**。我逐一从 SEC EDGAR 拉取了它们的最新 10-K 年报（三大报表 + 更早年份的净资产时间序列），把表里的每个比率按原始财报重新计算，逐项比对。

## 逐项核对（表值 vs 按年报重算）

| 股票 | 指标 | 表值 | 财报重算 | 判定 |
|---|---|---|---|---|
| **VZ** | 净利率 | 12.43% | 12.43%（17.17B/138.19B）| ✅ 精确一致 |
| | ROE | 16.24% | 16.24% | ✅ 精确一致 |
| | ROE上年 | 17.41% | 17.41% | ✅ 精确一致 |
| | ROE前年 | **70.38%** | **12.38%**（11.61B/93.80B）| ❌ 严重错误 |
| | FCF收益率 | **18.24%** | **11.02%**（(371.4-170.1)/1828亿）| ❌ 错误 |
| | PE | 10.68 | 10.64 | ✅ |
| | PB | **0.49** | **1.73** | ❌ 错误 |
| **TDC** | 净利率 / 毛利率 | 7.82% / 59.35% | 7.82% / 59.35% | ✅ 精确一致 |
| | ROE三年 | 56.5% / 85.7% / 45.9% | 完全一致 | ✅ 精确一致 |
| | FCF收益率 | 10.36% | 10.36% | ✅ 精确一致 |
| | PE | **6.71** | **21.2**（27.6亿/1.3亿）| ❌ 差3倍 |
| | PB | **3.04** | **12.0** | ❌ 错误 |
| **ACGL** | 净利率 / ROE / ROE上年 / FCF收益率 | — | 全部精确一致 | ✅ |
| | ROE前年 | **15.92%** | **24.20%**（44.4B/183.5B）| ❌ 错误 |
| | PE | 7.73 | 7.99 | ✅ 基本吻合 |
| | PB | **0.55** | **1.45** | ❌ 错误 |
| **AIZ** | 净利率 / ROE三年 / FCF收益率 | — | 全部精确一致 | ✅ |
| | PE | 14.14 | 15.66 | ⚠️ 差约10%，或为其用了TTM盈利口径 |
| | PB | **0.45** | **2.33** | ❌ 错误 |
| **GAP** | 净利率 / 毛利率 / ROE / ROE上年 / FCF收益率 | — | 全部精确一致 | ✅ |
| | ROE前年 | 22.04% | 19.35% | ⚠️ 偏差约14% |
| | PE | 7.78 | 8.65 | ⚠️ 同TTM口径问题 |
| | PB | **3.33** | **1.86** | ❌ 错误 |

数据来源：VZ 10-K（备案号 0000732712-26-000007，2026-02-17 提交）、TDC 10-K（0001628280-26-012671，2026-02-27）、ACGL 10-K（0000947484-26-000017，2026-02-26）、GAP 10-K（0001628280-26-018573，2026-03-17，财年截至 2026-01-31）、AIZ 10-K（0001267238-26-000010，2026-02-19）[Source: SEC EDGAR — 10-K XBRL 财务报表，FY2025/FY2026 年报，截至各备案日]。

## 结论

**不是编造的，但也不是完全可信的。** 判断依据：

1. **造假的反证极强**：净利率、毛利率、ROE（当年+上年）、FCF收益率这些指标与 SEC 原始财报在小数点后 **6–10 位** 上完全一致（例如 TDC 净利率 0.07817197835237523 = 1.30亿/16.63亿 分毫不差）。编造的数据不可能做到这种精度，说明底层财务数据确实来自真实财报。

2. **但表格有明显的公式/口径 bug**：
   - **PB 列整列不可信**——抽查的5只全部对不上（既不是市值/净资产，也不是市值/总资产）。VZ 真实 PB 约 1.7，表里写 0.49；TDC 真实约 12，表里写 3.04。
   - **ROE(前年) 列部分错误**——VZ 写 70.4% 而实际只有 12.4%，ACGL、GAP 也对不上。
   - **个别单元格错误**——VZ 的 FCF 收益率（18.2% vs 实际 11.0%）、TDC 的 PE（6.71 vs 实际约 21，这个错误会让 TDC 看起来异常便宜，**最容易误导决策**）。

**使用建议**：这张表的净利率、毛利率、ROE（当年/上年）、FCF收益率可以放心用；**PB 列整列作废**，PE 和 ROE(前年) 用前需要复核。另外提醒一句：排名第3的 CHTR 市值 157 亿美元这个数也值得怀疑（Charter 流通盘约 1.4 亿股，即便股价大跌这个市值也偏低，但我没抽查到它，仅供你复核时参考）。

===== [07-22 23:45:36] KIMI =====
我会沿着 PB、ROE(前年)、FCF Yield、PE/market_cap 四条线查数据源。

===== [07-22 23:46:45] KIMI =====
我已经确认 PB 来自 `daily_quote.pb`，不是物化视图重算的 PB；继续查美股行情入库。

===== [07-22 23:48:33] KIMI =====
现在重点核 VZ 现金流 CapEx 和股本来源，这两个能解释 FCF 与市值疑点。

===== [07-22 23:49:47] KIMI =====
还剩两个源头要确认：CapEx 标签冲突、stock_share 股本口径。

===== [07-22 23:52:51] KIMI =====
你同事的判断基本是对的：这张表不是整体编造，而是**财务三表比率大多来自 SEC，估值列和部分展示列却有独立的数据源/口径 bug**。我核了代码和数据库，异常能分成四类。

## 1) PB 整列错：筛选页用了腾讯 `daily_quote.pb`，没用 SEC 重算 PB

美股筛选在 `get_us_universe()` 里直接取：

- `q.pe_ttm`
- `q.pb`

见 `quant/screener/query.py:188-193`。而 `q.pb` 来自腾讯美股接口字段映射：`core/fetchers/daily_quote.py:598-604` 把 `parts[38]` 当 PB、`parts[39]` 当 PE，再在 `core/fetchers/daily_quote.py:886-889` 写入 `daily_quote.pb/pe_ttm`。

数据库里表值正好等于 `daily_quote.pb`：

- VZ `0.49`
- TDC `3.04`
- ACGL `0.55`
- AIZ `0.45`
- GAP `3.33`

但同一个物化视图 `mv_us_fcf_yield` 里用 SEC 年报重算的 PB 是：

- VZ `1.7497`
- TDC `12.0381`
- ACGL `1.5303`
- AIZ `2.3710`
- GAP `1.9234`

这基本对应你同事算的 `1.73 / 12.0 / 1.45 / 2.33 / 1.86`。剩余小差主要来自 `mv_us_fcf_yield` 用 `close / book_value_per_share`，而 BVPS 分母是年报 `weighted_avg_shares_basic`；更稳的口径应是：

```text
PB = latest market_cap / latest annual parent_equity
```

对 ACGL/GAP 这种回购较多的公司，`market_cap / total_equity` 更接近你同事的复核值。

## 2) PE 也不该用腾讯字段：TDC 是典型

TDC 当前：

- `daily_quote.market_cap = 2.759953B`
- `mv_us_fcf_yield.net_profit_ttm = 130M`
- 自算 PE = `2.759953B / 130M = 21.23`
- 但 `daily_quote.pe_ttm = 6.71`

所以你同事说 TDC PE 错 3 倍，是成立的。VZ PE 碰巧对上，是因为 VZ 的 `market_cap / net_profit_ttm ≈ 10.64`，和腾讯 PE 接近；不能因为 VZ 对就认为 PE 列可靠。

建议美股筛选页 PE 也改成自算：

```text
PE = market_cap / net_profit_ttm    -- net_profit_ttm > 0 才显示
```

## 3) ROE(前年) 是最严重的逻辑 bug：不是“前年”，是“第三条非空 ROE”

`get_roe_history()` 先过滤了 `roe IS NOT NULL`，再 `ROW_NUMBER()`：

- `quant/screener/query.py:155-162`

然后 `filter_consecutive_roe()` / `pivot_roe_history()` 直接 `head(3)` / `cumcount`：

- `quant/screener/filters.py:37-47`
- `quant/screener/filters.py:145-168`

问题是很多美股 annual 行的 `total_equity` 缺失，导致 ROE 为 NULL；这些 NULL 被跳过后，后面的老 ROE 会顶上来，被错误命名成 `roe_2y_ago`。

证据：

- VZ 非空 annual ROE 只有 `2025=16.24%`、`2024=17.41%`、`2014=70.38%`、`2007=6.66%`。表里 `ROE(前年)=70.38%` 其实是 **FY2014**，不是 FY2023。
- ACGL 表值 `ROE(前年)=15.92%` 正好等于库里 **FY2021** ROE；因为 FY2023/FY2022 的 `total_equity` 是 NULL。
- GAP 表值 `22.04%` 正好等于库里 **FY2009** ROE；因为 FY2024–FY2020 的 equity 也大面积 NULL。

底层原因是 annual balance sheet 有行但权益字段缺：比如 VZ 2020–2023 annual 行 `total_assets` 有值，但 `total_liabilities/total_equity` 为 NULL；同期 quarterly 行反而常有 `total_equity`。这和你前面那份 US report period/equity 修复问题是同一条线上的。

这里必须改成“按真实财年连续”判断，而不是“非空 ROE 连续”。缺少年份应该显示 NULL/不达标，不能跳档。

## 4) VZ FCF Yield 错：CapEx 标签被污染

VZ 2025 annual 现金流在库里是：

```text
CFO = 37.137B
CapEx = 3.8B
FCF = 33.337B
```

但你同事按 SEC 重算是：

```text
CFO 37.14B - CapEx 17.01B = FCF 20.13B
FCF Yield ≈ 11.02%
```

表里 `18.24%` 正是用错误 FCF `33.337B / market_cap 182.806B` 算出来的。

CapEx 映射在 `core/fetchers/us_financial.py:581-586`，其中把：

```python
"CapitalExpendituresIncurredButNotYetPaid": "capital_expenditures"
```

也映射成了 CapEx。这个标签更像“已发生但未支付的资本开支”，不是现金流量表里实际支付的 CapEx。多个别名又映射到同一个 `capital_expenditures` 字段时，当前 pivot/dedup 没有明确优先级，可能把 `3.8B` 这种补充口径当成主 CapEx。

建议：`CapitalExpendituresIncurredButNotYetPaid` 从 `capital_expenditures` 移除或单独成字段；CapEx 只允许现金支付类标签，并加 VZ fixture 回归测试。

## 5) CHTR 市值：不如 PB/PE 那么铁证，但口径确实不稳

CHTR 表值市值 `15.716B`，隐含股本约 `122.98M`。最新 `stock_share` 是 `125.49M`，但来源是 `WeightedAverageNumberOfSharesOutstandingBasic`，不是期末流通股。用最新 stock_share 算是 `16.04B`，差约 `-2.0%`，不是数量级错误。

但风险在于：美股 spot 市值主要来自腾讯 `总市值` 字段；`correct_market_cap()` 只在历史回填路径用，`core/sync/daily_quote.py:90`，且只在偏差 `>10%` 时修。实时同步路径主要靠 `guard_us_market_cap()` 做日环比跳变拦截，挡不住“持续偏低/偏高”的股本口径错误。

股本优先级其实已经有定义：`scripts/backfill_us_equity.py:4-7` 是 `EntityCommonStockSharesOutstanding > CommonStockSharesOutstanding > WeightedAverageNumberOfSharesOutstandingBasic`。市值校验也应该按这个优先级做 PIT 对照。

## 当前使用建议

你同事的使用建议可以再加严一点：

- 可相对信任：净利率、毛利率、当年 ROE、上年 ROE——但前提是该公司最近三年 annual equity 没缺。
- 暂不直接用：PB、PE、ROE(前年)、FCF Yield 里 CapEx 可能被污染的公司。
- 美股筛选页应尽快改成自算：
  - `PB = market_cap / parent_equity`
  - `PE = market_cap / net_profit_ttm`
  - `FCF Yield = (CFO - cash CapEx) / market_cap`
  - ROE 连续年按真实 report_date 连续判断，缺年即失败/显示 NULL。

修复顺序我建议是：先改筛选页 PB/PE 自算和 ROE 连续年逻辑，再修 CapEx 标签与 balance equity 回补，最后加 market_cap vs SEC shares 的校验规则。

===== [07-23 11:13:30] USER =====
好的，那么我们先停用腾讯 PB/PE，建立统一 PE/PB/ROE 计算模块，修复 ROE NULL 被老年份顶替的问题。不过你判断一下，修改这些内容会不会跟现在 workspace 在改的内容冲突

===== [07-23 11:15:49] KIMI =====
我先看当前 workspace 有哪些未提交改动，再判断冲突面。

===== [07-23 11:16:13] KIMI =====
`git status --short` 是空的；我再看分支、最近提交和 stash，确认是不是在干净基线上。

===== [07-23 11:16:42] KIMI =====
工作区是干净的；我再看最近几个提交碰了哪些文件，评估方向性冲突。

===== [07-23 11:17:35] KIMI =====
最近提交主要在美股财报版本层；我确认一下它是否改了三张宽表写入路径。

===== [07-23 11:20:00] KIMI =====
判断结论：**不会和当前 workspace 的未提交改动冲突**，因为现在工作区是干净的：`main` 在 `04cb111`，`git status --short` 为空，也没有 stash。  
但要注意：**最近几个提交正在做美股财报 period/version 层**，所以这次的修改要刻意避开那条线，否则会变成方向性冲突。

最近提交主要碰了这些文件：

- `core/fetchers/us_financial.py`
- `core/sync/us_market.py`
- `db.py`
- `scripts/us_financial_versioning.sql`
- `tests/test_fetchers/test_us_financial_versioning.py`

你这次要做的“停用腾讯 PB/PE + 统一 PE/PB/ROE 模块 + 修 ROE NULL 顶替”，我建议把改动面控制在这里：

- 新增：`quant/metrics.py` 或 `core/metrics/valuation.py`
- 修改：`quant/screener/query.py`
- 修改：`quant/screener/filters.py`
- 新增测试：`tests/test_screener/test_metrics.py`、`tests/test_screener/test_roe_history.py`

**第一版不要碰**：

- `core/fetchers/us_financial.py`
- `db.py`
- `scripts/us_financial_versioning.sql`
- `core/sync/us_market.py`
- `scripts/materialized_views.sql`

原因是 P1 版本层已经在 `us_financial.py` 里双写 `us_financial_fact_version`，现在改 tag mapping / equity / CapEx 会同时影响旧宽表和新版本层，应该单独作为一个数据修复 PR 做，不要和估值口径模块混在一起。

具体冲突点判断：

1. **停用腾讯 PB/PE：低冲突**  
   只改 `get_us_universe()` 的输出列：不再把 `q.pe_ttm/q.pb` 作为最终结果，改为用 `market_cap + net_profit_ttm + parent_equity` 自算。`daily_quote` 表里的原始腾讯 PE/PB 可以保留，但筛选页不用。前端类型已经是 `number | null`，不需要改。

2. **统一 PE/PB/ROE 模块：低冲突，但 ROE 公式别顺手改**  
   现在同事验证过的 VZ ROE `16.24%` 是 `net_income / 期末 equity`，不是平均 equity。统一模块第一版应保持这个口径，否则会把已验证对的值改错。  
   如果想引入平均 ROE，另加 `roe_avg`，不要替换现有 `roe`。

3. **修 ROE NULL 被老年份顶替：低冲突，主要改 screener**  
   根因在 `get_roe_history()` 先过滤 `roe IS NOT NULL`，再 row_number；老年份 ROE 会顶进 `roe_2y_ago`。  
   修法是：inner query 只按 `report_type='annual'` 取最近 N 个报告期，不过滤 ROE NULL；然后在 `filter_consecutive_roe()` 里要求这 N 个真实报告期全部 `roe notna and roe >= min`。`pivot_roe_history()` 前也显式按 `report_date DESC` 排序。  
   这样 VZ 的 `roe_2y_ago` 会变成 NULL/不达标，而不是 FY2014 的 70.38%。

4. **一个残余风险：market_cap 还是腾讯/股本口径**  
   停用腾讯 PE/PB 后，PE/PB 仍依赖 `market_cap`。CHTR 这种市值疑点不会因为这次修改自动消失。建议这次只在模块里做无效输入保护：`market_cap <= 0`、`net_profit_ttm <= 0`、`parent_equity <= 0` 时返回 NULL；市值对 SEC shares 的校验放到下一步。

推荐拆分：

- PR 1：新增 metrics 模块 + screener 改用自算 PE/PB + ROE history 不再跳 NULL + 测试。这个安全，基本不碰 P1。
- PR 2：再处理 CapEx 标签、balance equity 缺失、版本层/宽表重建。这个会碰 `us_financial.py` 和版本层，需要单独评审。

所以你可以先做 PR 1；我现在没看到它会和当前 workspace 或最近 P1 提交产生实际冲突。

===== [07-23 11:21:26] USER =====
好的，那就做一下 PR 1

===== [07-23 11:26:10] KIMI =====
我开始做 PR 1：先确认测试目录结构，再落代码。

===== [07-23 11:31:15] KIMI =====
先落统一指标模块，再改 screener 查询。

===== [07-23 11:42:39] KIMI =====
ROE 逻辑已改；现在补 PR1 测试。

===== [07-23 11:44:41] KIMI =====
我现在运行筛选相关测试。

===== [07-23 11:45:08] KIMI =====
相关测试通过；再跑 lint 和全量测试确认没有连带影响。

===== [07-23 11:45:55] KIMI =====
全量测试通过。最后用真实筛选入口做一次只读冒烟，并看 diff。

===== [07-23 11:46:43] KIMI =====
冒烟正常；我最后看一遍 diff，确认改动范围干净。

===== [07-23 11:47:16] KIMI =====
`git diff` 里突然出现了 `core/fetchers/us_financial.py`，我先确认它不是我这轮改出来的。

===== [07-23 11:48:48] KIMI =====
PR 1 已完成，没碰 P1 版本层文件。

改动内容：

- 新增统一指标模块 `quant/metrics.py:27-61`
  - `compute_pb = market_cap / parent_equity`，仅市值和净资产都为正时返回；
  - `compute_pe = market_cap / net_profit_ttm`，亏损或盈利缺失返回 `None`；
  - `compute_roe_annual = net_income / ending_equity`，保持当前已验证口径，不改平均 ROE。
- 美股筛选停用腾讯 PE/PB：`quant/screener/query.py:192-195` 不再取 `q.pe_ttm/q.pb`，`quant/screener/query.py:253-263` 改为自算 `pb/pe_ttm`。
- 修复 ROE NULL 跳档：
  - `quant/screener/query.py:138-169` 的 `get_roe_history()` 不再过滤 `roe IS NOT NULL`；
  - `quant/screener/filters.py:37-48` 明确按报告期倒序，且最近 N 年任一 ROE 缺失即不连续；
  - `quant/screener/filters.py:160-165` pivot 前强制按 `report_date DESC`，避免“上年/前年”错位。
- 新增测试：
  - `tests/test_screener/test_metrics.py`
  - `tests/test_screener/test_roe_history.py`
  - `tests/test_screener/test_us_valuation.py`

验证结果：

- 相关测试：21 passed
- 全量测试：314 passed
- 真实入口冒烟：`run_screener("US", "fcf_roe_value", 10)` 正常返回；`total_before=1003, total_after=26`。
- `ruff` 没跑成：当前 venv 里没有 `ruff` 模块。

行为变化要注意：

- 美股筛选里的 `pe_ttm/pb` 现在来自统一计算，不再是腾讯字段；负盈利、负净资产、缺市值时会显示 `NULL` 而不是 vendor 值。
- “连续 3 年 ROE”现在按真实报告期判断；缺一年就失败，不会再像 VZ 那样把 FY2014 的 70.38% 顶成“前年”。

另外提醒：工作区里还有一个我这轮没有改的 `core/fetchers/us_financial.py` 变动，内容是 `psycopg2.extras.execute_values(..., fetch=True)` 返回值处理。我把它留在原状了；提交 PR 1 时建议不要把它混进去，单独确认来源。

===== [07-23 11:53:31] USER =====
好的，那是不是需要 commit + push 一下

===== [07-23 11:54:10] KIMI =====
我只暂存 PR 1 相关文件，排除那个无关的 `us_financial.py` 改动。

===== [07-23 11:54:34] KIMI =====
暂存区只有 PR 1 文件。现在提交并推送。

===== [07-23 11:55:18] KIMI =====
已提交并推送。

- Commit: `511aea1 fix(screener): self-compute US PE/PB and preserve ROE year continuity`
- Push: `main -> origin/main` 成功
- 当前工作区干净：`## main...origin/main`

提交里只包含 PR 1 的 6 个文件；之前那个无关的 `core/fetchers/us_financial.py` 改动没有进入本次提交。提交前已跑过全量测试：314 passed。

===== [07-23 14:42:01] USER =====
然后 PR2 适合在什么时候开始做呢，目前 P1B 还在收尾

===== [07-23 14:42:33] KIMI =====
我先看一下当前工作区/分支状态，再判断 PR2 的切入点。

===== [07-23 14:43:01] KIMI =====
现在工作区有 P1B 未提交改动；我看一下 P1B 剩余内容和 PR2 是否同文件。

===== [07-23 14:43:33] KIMI =====
我再对一下 P1B runbook 的完成定义，避免只凭感觉排期。

===== [07-23 14:44:41] KIMI =====
建议：**PR2 不要现在正式开工改行为；可以现在做 PR2 前置侦察和失败测试。**  
原因是 P1B 还在工作区里未提交，且 PR2 很可能会碰同一批 selector/relation/事实口径文件，现在并行做容易互相踩。

我看到当前工作区已有 P1B 相关改动：`core/selectors/us_financial.py`、`core/relations/us_financial.py`、`scripts/run_us_fact_selector.py`、`scripts/us_financial_phase1b.sql` 以及对应测试/文档都还没提交。PR2 如果涉及 CapEx、equity、latest-restated selector，最自然的落点也是这些文件，所以最好等 P1B 收尾合并。

PR2 的正式开启门槛我建议定为：

- P1B 已 commit + push，工作区干净；
- relation / selection run / audit 迁移可重复；
- `first-reported`、`latest-restated`、`as-of` 三类 selector 的时间线测试通过；
- canary 影子选择完成，新旧结果差异报告已解释；
- selector 重跑幂等、checksum 稳定；
- VZ/ACGL/GAP/TDC/AIZ/CHTR 这组问题样本纳入影子验证。

现在可以并行做的 PR2 前置工作，不改生产行为：

- 写 VZ CapEx 失败 fixture：证明 `CapitalExpendituresIncurredButNotYetPaid` 不得进入现金 CapEx；
- 盘点 `total_equity/total_liabilities` 缺失的 annual 行，区分“标签未映射”和“版本选择错误”；
- 起草 parent/common/NCI/preferred equity 口径拆分方案；
- 加只读校验 SQL/脚本：CapEx sanity、PB=market_cap/equity 偏差、ROE 年份连续性，只报告不修改；
- 设计 PR2 的 selector/mapping diff 报告格式。

不建议现在做：

- 改 `core/fetchers/us_financial.py` 的 CapEx/equity 映射并直接生效；
- 改 selector 让生产筛选/分析切换输入；
- 重建全市场宽表或刷新下游物化视图。

一句话：**P1B 合并 + canary shadow 绿了之后，再开 PR2；如果 P1B 还要拖一两天以上，就先开 PR2-prep 分支，只放测试、盘点和文档，不改行为。**

===== [07-23 21:12:52] USER =====
看一下 /home/vinci/projects/stock_data/docs/core/US_FINANCIAL_VERSIONING_PHASE2_RUNBOOK.md，评价一下

===== [07-23 21:13:17] KIMI =====
我先读 Phase 2 runbook，再结合当前 P1B 状态给评价。

===== [07-23 21:15:03] KIMI =====
总评：这份 Phase 2 runbook 质量很高，边界比之前的修复文档更清楚，尤其是“只做全市场版本层和影子选择，不切换生产消费者”这条定得对。它已经具备进入开发评审的基础；但还不到能批准生产 apply 的程度，有几个关键缺口必须先补，否则全市场回填时会把 P1A/P1B 已经控制住的问题重新放大。

## 主要亮点

- **非目标写得硬**：明确禁止改旧三张宽表、禁止跑 `reparse_us_all.py`、禁止刷新生产物化视图/消费者。这个能防止 Phase 2 变成又一次隐性生产切换。
- **证据等级正确**：`raw_snapshot_version` 最高，legacy/current refetch 只算 reconstruction，且禁止伪造历史 `fetched_at`。这符合 SEC 数据语义。
- **`us_financial_fact_source` 必须做是对的**：P1A 的事实唯一键不含 snapshot，后续 snapshot 重复观察同一事实时，如果没有关联表，证据关系会丢。这一点抓住了版本层的核心漏洞。
- **manifest/canonical hash/apply 批准**设计完整，尤其是 deterministic payload 和 runtime metadata 分离。
- **Gate A–E 准入**合理，canary 之外还强制补 10-K/A、10-Q/A、tag migration、unknown change、多 dimensions、非 USD、Q4I 异常样本。
- **验证 SQL 可执行化**的要求对：禁止手工复制 batch id 后漏检。
- 明确写了 P1B v1 不自动兼容 52/53 周和 `context_changed`，Phase 2 不得临时放宽 selector。这个克制是对的。

## 必须先补的关键缺口

1. **“rejected 事实如何不被 selector 选中”没有落地机制**  
   文档说默认不删除错误 parser 产生的事实，而是标记 batch `rejected`，selector 排除 rejected/superseded。但现在 `us_financial_fact_version` 本身没有 `status/superseded_by` 一类字段，仅靠 batch 状态不够。  
   必须补一种硬机制，例如：
   - `us_financial_fact_version` 增加 `fact_status` / `superseded_by_fact_id`；或
   - 新增 `us_financial_fact_exclusion(fact_version_id, reason, batch_id)`，selector 强制 anti-join。  
   否则错误事实一旦写入，仍然可能被 latest-restated/as-of 选中。

2. **`us_financial_fact_source` 缺在线双写和存量回填规则**  
   只要求 Phase 2 写关联表还不够。P1A 之后在线同步仍会继续双写版本层；如果在线路径不写 `fact_source`，Phase 2 之后的新 repeat 证据又会继续丢。  
   需要明确：
   - Phase 2 上线同时，在线 ingest 也写 `fact_source`；
   - 已存在的 P1A/P1B facts 如何回填首条 `fact_source`；
   - repeated/conflict/staging 的幂等唯一键分别是什么。

3. **旧宽表“只读”没有强制手段**  
   Step 0 说要确认旧三表和物化视图只读，但没有写怎么强制。生产 US sync 如果在 Phase 2 期间照常跑，旧宽表 checksum 会变，验证会误判 Phase 2 污染。  
   必须补一种执行机制：暂停 scheduler、数据库角色只读、表级 lock、trigger 拒绝写入，或明确 freeze window 和负责人。

4. **CLI 少了 `approve`**  
   状态机强制 `staged -> verified -> approved -> applying`，但 CLI 只有 scan/stage/apply/verify/rollback/resume，没有 `approve`。应补：
   ```bash
   python scripts/backfill_us_financial_versions.py approve \
     --batch-id <uuid> --manifest <path> --by <name> --note "<审批说明>"
   ```
   并要求 apply 校验 `approved_by/approved_at` 与 manifest hash 匹配。

5. **状态机缺 `interrupted`**  
   第 8 节要求 SIGINT 后标记 interrupted，但第 5 节状态列表没有 `interrupted/paused`。需要补状态、resume 入口、心跳/超时规则：多久无心跳的 `applying/running` 可接管，advisory lock 如何释放。

6. **selector 命名有漂移**  
   P1B 范围是 `first-reported/latest-restated/as-of`，Phase 2 Step 7 又出现 `latest-observed`。需要统一：要么定义 `latest-observed`，要么改成 P1B 已批准的 selector 名。否则 shadow 结果无法复现。

7. **conflict/staging 幂等键不足**  
   文档强调第二次 `facts_inserted=0`，但 conflict/staging 也可能在重跑、resume、child batch 中重复。需要给 conflict/staging 也定义幂等唯一键或去重策略，不能只保证正式 fact 不翻倍。

8. **relation 构建的全市场复杂度没量化**  
   5 只 canary 已有 3.48 万 facts；全市场可能是数百万级。relation builder 如果按字段/期间做笛卡尔比较会炸。需要写清：
   - 只处理本批次 stock_scope 及必要邻接 filing；
   - 候选对生成规则；
   - 每批最大 relation 数、预期耗时、索引依赖；
   - 失败后半批 relation 如何重跑。

9. **stage 到 apply 的来源漂移要锁死**  
   dry-run manifest 里的 `expected_counts` 只有在 apply 使用完全相同 source snapshot/content hash 时才有效。需要明确：stage 后不得重新 refetch；apply 时发现 source hash 变化或新增网络来源，必须失败并重新 stage。

10. **legacy `raw_snapshot` 的映射还要更细**  
    禁止把 legacy 当历史时点快照是对的，但应补字段级规则：legacy 没有原始 `fetched_at` 时，`source_fetched_at` 置 NULL 还是 legacy `updated_at`？我的建议是置 NULL 并打 `RECONSTRUCTED_FROM_LEGACY_SNAPSHOT`，不要把覆盖式缓存时间冒充采集时间。

## 较小但值得补的点

- 增加 `post_verify_failed` 到异常状态列表，正文已使用但状态机没列全。
- 明确批次股票范围重叠规则：两个 in-flight batch 不得包含同一 stock，除非显式 parent/child。
- 明确磁盘/TOAST/索引策略：大批量 JSONB/raw_data 写入时是否延迟建索引、批量 commit 大小、`work_mem/maintenance_work_mem` 建议。
- 补 chaos/中断测试：`kill -9`、数据库连接断开、SEC 429 持续、磁盘满，验证不会遗留 running。
- 补 property-based 测试：canonical JSON 对 Decimal/date/None/嵌套 key 排序稳定。
- 验收报告增加“重建来源比例”和“quality flag top N”，这对判断全市场可信度很关键。

## 我的准入建议

这份文档可以作为 Phase 2 的设计基线，但建议先修订后再批准 Gate A。至少要关闭这 5 件事再允许测试库 apply：

1. rejected/superseded fact 的 selector 排除机制进 DDL 和测试；
2. `us_financial_fact_source` 覆盖在线双写、Phase 2 回填和存量回填；
3. 旧宽表只读的强制执行方案；
4. CLI `approve`、状态机 `interrupted/post_verify_failed` 和重叠 scope 规则；
5. conflict/staging 幂等键与 relation 全市场性能方案。

如果这些补齐，这份 runbook 是可以支撑全市场回填的；如果不补，风险主要不在“写不进去”，而在“写进去之后错误事实仍被 selector 当成最新事实”。当前 P1B 还在收尾，Phase 2 生产 apply 应严格等 P1B v1 关闭后再谈。

===== [07-24 11:08:38] USER =====
你看一下当前的项目开发进展

===== [07-24 11:09:25] KIMI =====
我先看当前分支、未提交改动和最近提交，再判断进展卡点。

===== [07-24 11:09:50] KIMI =====
现在只剩一个文档改动；我核对它内容，并跑一次全量测试确认当前状态。

===== [07-24 11:11:15] KIMI =====
当前进展很快，主线已经从 PR1 走到 Phase 2 Gate A 了。我看到的状态是：

- 分支：`main == origin/main`，HEAD 在 `54908f0 feat(us): finalize Gate A post-verify workflow`
- 未提交改动：只有 1 个文档文件  
  `docs/quant/QUANT_SYSTEM_PLAN.md`：把美股 PE/PB 描述改成自算口径，并更新 ROE 年份连续性说明。看起来是 PR1 后的文档同步，尚未提交。
- 测试：全量 `380 passed`，只有一个 `py_mini_racer` 的 deprecation warning，不影响功能。

按 `docs/core/US_FINANCIAL_DATA_GOVERNANCE_PROGRESS.md` 当前口径：

- P0 报告期解析/隔离：已关闭
- Phase 1A 不可变版本层：已关闭
- PR1 生产筛选 PE/PB + ROE 年份连续性：已修复并推送（`511aea1`）
- Phase 1B relation / selector / selection audit：已关闭
- Phase 2 历史回填：🟡 Gate A 第一批已完成，下一步是 Gate A 剩余测试库演练与 Gate B 准入验收
- 生产消费者：尚未切换；latest-restated、PIT 回测、ROIC 都还没正式接入

最近提交也印证了这个状态：`223e4ce` 起做 Phase 2 backfill 基础设施，后续 `bd41612/a606511/d2cb5b3/54908f0` 连续补了 heartbeat/lease/advisory lock、Gate A blocker、exclusion rollback 和 post-verify workflow。

我的判断：

1. **现在最该收尾的是那个未提交文档。**  
   它只是 docs 同步，建议单独小提交，例如：  
   `docs(quant): record US PE/PB self-computation and ROE continuity fix`  
   不要和 Phase 2 代码混在一起。

2. **PR2 不宜再定义为“改生产筛选口径”，而应并入 Phase 2 / Gate B 的指标前置治理。**  
   因为 P1B 已关闭、Phase 2 Gate A 第一批也完成了。接下来 CapEx、common equity、NCI/preferred、平均权益 ROE 这些都应该在 selector/manifest/差异报告框架里做，先做影子差异，再决定生产切换。

3. **Gate B 前建议把问题样本固定进验收。**  
   除了 PLTR/MELI/ONTO/SAM/HRB，还应把 VZ、ACGL、GAP、TDC、AIZ、CHTR 加进 shadow/差异清单，分别覆盖：
   - VZ：CapEx 口径错误、annual equity 缺失导致 ROE 断档
   - ACGL/GAP：annual equity 缺失导致 ROE 历史跳档
   - TDC：vendor PE 误导
   - AIZ/CHTR：金融/电信类口径与市值股本校验

4. **当前不要做的事：**  
   不要切换生产 analyzer/screener 到 latest-restated，不要刷新/替换生产物化视图，不要全市场 apply。先完成 Gate A 剩余演练和 Gate B 准入证据。

===== [07-25 10:29:55] USER =====
你再看一下最新的进展

===== [07-25 10:30:19] KIMI =====
我重新拉一下当前分支状态和最近提交。

===== [07-25 10:30:45] KIMI =====
有 9 个本地提交未推送，其中一个提交显示删除了 `quant/metrics.py`。我先确认 PR1 的依赖是否被安全迁移。

===== [07-25 10:31:05] KIMI =====
`quant/metrics.py` 被迁移成了 `quant/metrics/` 包，PR1 导入路径仍兼容。我再跑测试并看 ROIC/Gate B 文档状态。

===== [07-25 10:31:44] KIMI =====
最新本地提交已经走到 Gate B 证据和 ROIC MVP shadow；我再抓这两个文档的结论。

===== [07-25 10:32:24] KIMI =====
最新状态有两个关键点：**本地已经往前走了很多，但还没 push**；另外有一个文档改动一直未提交。

当前 git 状态：

- `main` 比 `origin/main`  ahead 9
- HEAD：`518109a docs(quant): record delivery SHA in ROIC MVP runbook`
- `origin/main` 仍在：`54908f0 feat(us): finalize Gate A post-verify workflow`
- 未提交改动仍只有：`docs/quant/QUANT_SYSTEM_PLAN.md`（PR1 的 PE/PB/ROE 文档同步）
- 我刚跑全量测试：`414 passed`，无失败。

新增进展主要是两线：

1. **Phase 2 Gate B 证据包已经形成**
   - 新增/更新：`US_FINANCIAL_PHASE2_GATE_B_ACCEPTANCE.md`
   - Round 2 / Round 3 使用相同 snapshot identity 重跑：
     - `facts_inserted = 0`
     - `facts_repeated = 60,379`
     - `facts_conflicted = 0`
     - `facts_staged = 410`
     - fact / relation / latest-restated / as-of checksum 全部一致
     - 旧三张宽表 checksum 前后不变
   - 样本扩展到 CRM/CRWD/LULU 这三类 Q4I 异常，另加 DIM1 验证多 dimensions。
   - 还补了 worker role 权限收紧和 SAVEPOINT-based verification。

2. **ROIC MVP shadow 已交付，但不是完成态**
   - 新增 `quant/metrics/` 包和 ROIC MVP：`quant/metrics/roic.py`、`quant/metrics/us_roic_mvp.py`、`scripts/run_us_roic_mvp.py`
   - 之前 PR1 的 `quant/metrics.py` 被 `87f0f88` 删除，但已经迁移成 `quant/metrics/__init__.py`，`quant/screener/query.py` 的 `from quant.metrics import compute_pb, compute_pe` 仍可用，测试也过。
   - ROIC runbook 状态明确是：**部分完成 / 债务数据阻塞**。
     - PLTR、VZ、ONTO 因核心债务输入缺失被评为 `INVALID`，没有强行按 0 估算；
     - HRB、MELI 短期债缺失，仅标记 `MISSING_SHORT_TERM_DEBT`；
     - lease 缺失标记 `MISSING_LEASE`。
   - 这说明 ROIC 算法框架通了，但债务/租赁事实覆盖率还不够，离正式 ROIC 还远。

需要注意的不一致：

- `docs/core/US_FINANCIAL_DATA_GOVERNANCE_PROGRESS.md` 还没更新到本地最新状态；它仍写 Phase 2 “Gate A 第一批完成”、ROIC “方案完成”。但本地提交已经有 Gate B 证据包和 ROIC MVP shadow。这个进度总览需要同步更新，否则会误导排期。
- 本地 ahead 9 还没 push；如果同事或服务器拉 `origin/main`，看不到 Gate B 证据和 ROIC MVP。

我建议下一步顺序：

1. 先处理那个未提交的 `docs/quant/QUANT_SYSTEM_PLAN.md`：要么作为 PR1 文档同步单独提交，要么丢弃。
2. 更新 `US_FINANCIAL_DATA_GOVERNANCE_PROGRESS.md`，把 Gate B 证据、ROIC MVP 部分完成/债务阻塞写进去。
3. 确认这 9 个本地提交都是要发的，再 push；不要把它们长期留在本地。
4. Gate B 证据已经足够进入“准入评审”，但在负责人明确批准前，仍不应执行生产 apply 或切换消费者。

===== [07-25 10:34:17] USER =====
好的，你先把 1 和 2 处理一下。我正在让同事收尾 Gate B

===== [07-25 10:35:02] KIMI =====
我来处理这两项：先提交 PR1 文档同步，再更新治理进度总览。

===== [07-25 10:37:25] KIMI =====
进度总览已改；我检查 diff 后提交。

===== [07-25 10:37:54] KIMI =====
已处理完，都是文档提交，未 push。

新增两个本地提交：

- `cf1a69b docs(quant): record US PE/PB self-computation and ROE continuity fix`
  - 提交之前遗留的 `docs/quant/QUANT_SYSTEM_PLAN.md` 修改：美股 PE/PB 改为自算口径，并记录 ROE 年份连续性修复。
- `c55101e docs(us): sync governance progress with Gate B evidence and ROIC MVP`
  - 更新 `docs/core/US_FINANCIAL_DATA_GOVERNANCE_PROGRESS.md`：
    - Phase 2 状态改为 Gate B 准入证据已形成、待批准；
    - ROIC 改为 MVP shadow 部分完成、受债务/租赁输入阻塞；
    - 补充 Gate B 证据、ROIC MVP、`cf1a69b` 的提交记录；
    - 明确这些提交目前还在本地 `main`，生产 apply 仍需负责人批准。

当前状态：

- 工作区干净
- `main` 领先 `origin/main` 11 个提交
- 没跑新测试，因为这两次都是 docs-only；上一次全量测试是 `414 passed`

这两个提交只动文档，不影响你同事收尾 Gate B。
