# 51405257 U7 窄修独立只读范围审查

审查基线：`ebab5575b53c0d1241adde7941db001ace381739`。本文件只记录静态结论；未修改产品或测试，未运行 GUI、导入、模型、引擎或重复测试。

## 原失败事实

- 冻结输入：`docs/packaging-test-scripts-2026-09-21/07_表格版_混合_show判定_食品码垛_CN.xlsx`，历史证据 SHA-256 `32928ce140c3d8b25ad0b5ac482896b3698417f7de8401920c9129c3b030697e`。
- 原 U7 证据：`.codex-handoff/u7-title-stop-51392529-report.md:13-18` 与 `docs/acceptance-evidence/u7-title-stop-20260928-51392529/README.md:19-24`。
- 第4镜作者标题为“包装落到托盘以后还要核对排列方向垛层边缘和抓具退出的路径”，实际 title 为同一行章节标签“落盘确认”；第6镜作者标题为“开场”，实际 title 为同一行章节标签“工位衔接”。标题 5/7，card_content 与 card_hint 均 7/7。

## 可靠来源链与最窄修法

- `VideoAutoCut/tools/script_card_fields.py:762` 的 `column_role` 识别“分镜标题”列。
- `block_from_rows` 在 `:926-992` 只把唯一、非 ambiguous、非 doubtful 的作者格标为 `reliable`；`extract_table_card_fields` 在 `:998-1028` 保存已识别角色。
- 工作簿还须通过 `table_certainty_problems`，见 `:1260-1266`；逐镜身份仍须通过 `anchor_verdict`，见 `:1287-1301`。
- 原阻断在 `:1415-1422`：实际 title 与本镜未识别列值相同即受 `foreign_values` 保护，只告警、不纠正。
- 51405257 的最窄可靠修法是：仅当字段为 `title`、route 为 `table`、表头明确含 title、该镜 title 格存在且可靠时，允许绕过这一条 foreign-value 阻断。card_content/card_hint、纯文本/Markdown 路径及其它保护条件保持不变。无需把章节标签扩成新的生产字段。

当前主实施工作树的未提交差异符合上述边界，并增加三组回归：原 07 fixture/U7 captured plan 的第4/6镜纠正；表格未知列仍不能改 card；纯文本未知字段仍不能改 title。

## 最终两文件差异复核

- `VideoAutoCut/tools/script_card_fields.py` 相对 `ebab557` 为 7 行新增、1 行替换；唯一行为变化就是上述 table/reliable/title 例外，没有改变 `anchor_verdict`、字段抽取、card 分支、纯文本分支或提交纠正的逻辑。
- `VideoAutoCut/tests/test_script_card_fields.py` 为 39 行纯新增：增加 captured-plan 路径和3个测试；没有删除或改写旧断言，没有新增 `skip`/`skipUnless`/`skipIf`。
- 新测试分别锁定 U7 第4/6镜精确纠正、未知表格列不解除 card 保护、纯文本标题不适用例外。生产条件中的 `field == "title"` 和 `route == "table"` 与两条负向回归互相对应。
- `git diff --check` 对这两个文件为 exit 0。全量测试次数、结果与两个既有 skip 的直接证据由主实施收据负责；本独立复核按要求未重复运行测试。

## 回归风险

- 不可全局删除 `foreign_values` 保护，否则 `test_a_column_this_table_does_not_know_protects_a_correct_plan` 所覆盖的未知“花字文案”会被误清或误改。
- 不可把例外扩展到 card 字段、纯文本路或 `module_label`；`test_module_label_is_never_touched` 明确章节标签不在本校验器修改范围。
- `anchor_matches` 对至少6字符的锚点允许包含关系，理论上长标题本身可能让身份判定为 ok；本次第4/6镜实际章节标签不包含作者标题，因此 U7 的 ok 仍需口播/字幕锚点成立。按 Mac 指令不新增额外身份门槛，保留既有 anchor 规则，由全量既有测试覆盖。
- 应保留并执行既有未知列保护、title-only/镜号错位、表头 ambiguous/doubtful、表格与纯文本等价性测试；不得删除或放宽断言，skip 清单不得变化。
