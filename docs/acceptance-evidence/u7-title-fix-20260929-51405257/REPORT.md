# U7 标题保护窄修（51405257）

## 结果

本轮只修改 `VideoAutoCut/tools/script_card_fields.py` 的一处 foreign-values 保护条件，并新增 3 个离线回归测试。没有正式导入脚本、调用模型、启动 GUI、重跑 U7、构建引擎、执行 U7/pipeline 渲染或执行 W6，也未修改既有成片。全量单测按既有行为在临时目录生成少量媒体夹具并覆盖编码 fallback；这属于获准的离线单测，不是产品流水线或 U7 重跑。

当且仅当脚本走表格路由、表头明确识别出 `title` 角色、当前标题格 `present` 且 `reliable` 时，可靠的分镜标题列不再被“plan 值也出现在未知字段”保护挡住。原有整表冻结、单格可靠性和镜号内容锚点均先行；`card_content`、`card_hint` 与纯文本标题仍保留原保护。

## 红测

新增测试直接读取原 `07_表格版_混合_show判定_食品码垛_CN.xlsx` 与 U7 首次正式导入的 tracked captured plan。修改生产代码前，当前逻辑返回 `corrections=[]`，期望第 4、6 镜两条 `title rewritten`，因此 1/1 FAIL。原重定向日志按 CP936 字节原样保留为 `logs/red-u7-title-test.log`；不把终端替换字符当原文。

## 绿测与全量

聚焦用例 3 条：真实 U7 第 4/6 镜纠正、表格卡片 foreign 保护不变、纯文本标题 foreign 保护不变。最终 Ran 3，OK。

冻结 embedded Python 3.11.9（同历史 W1 runner）全量结果：

- 基线 `ebab5575`：Ran 636，failures 0，errors 0，skipped 2；
- 当前修改：Ran 639，failures 0，errors 0，skipped 2；实际通过 637、跳过 2；
- 新增恰好 3 条，skip ID 清单不变；两边均走既有“缺运行组件”分支。由于 detached baseline worktree 与当前工作区可见组件不同，具体缺失组件文字不同。

两项 skip 都是仓库工作区缺少完整 HyperFrames 运行组件时的既有真 lint：

1. `test_packaging_agent.PagedCompositionTests.test_real_hyperframes_lint_accepts_the_paged_composition`
2. `test_script_card_fields.ScriptLayoutRenderTests.test_real_hyperframes_lint_accepts_the_headline_card`

基线两项已在同 worktree/runner 下单独以 verbose 运行，见 `logs/baseline-skips-v-final.log`：基线缺内置 Node、HyperFrames 0.7.3、GSAP 3.14.2、Chrome Headless Shell；当前全量日志中缺内置 Node、Chrome Headless Shell。skip ID 和测试内的既有缺组件分支相同，不宣称 reason 字符串逐字相同。第一次按模块名直调基线 skip 因 embedded Python 路径未注入而产生两个 loader error，仅属测试入口准备失败，不作为用例结果。

## 测试环境尝试

系统 Python 3.12 没有 pytest，也缺 `dotenv`，因此它的全量尝试出现 `test_qwen_cloud_embedder` 导入错误，不作为验收结果。第一次 git archive 基线只复制了 `VideoAutoCut`，遗漏 tracked docs fixtures，产生额外失败，同样不作为验收结果。之后改用完整 detached worktree `D:\vac\u7b` 和冻结 embedded Python；没有安装依赖，也没有修改生产或嵌入环境。

新增纯文本保护测试的第一次 fixture 只有一镜，触发已有“无有效 markers”零动作；第二次 fixture 未填已有卡片，触发无关的 `card_content missing`。这两次都只修正新测试夹具，未为其扩大生产条件。最终聚焦与全量均通过。

## 工作区边界

`VideoAutoCutDesktop/package.json` 与 `package-lock.json` 是用户既有修改，本轮未覆盖、未暂存。提交和推送须在 root 最终复核后执行。
