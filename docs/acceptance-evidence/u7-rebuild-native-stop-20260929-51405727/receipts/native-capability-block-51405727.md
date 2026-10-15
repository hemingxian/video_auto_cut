# 51405727 Computer Use 原生能力阻断收据

- Root 通过 `mcp__node_repl__js` 导入 `@oai/sky` 后调用 `sky.list_windows`；首次、同调用重试、`js_reset` 后重新导入并末次重试，共三次均返回：

```text
Computer Use native pipe is unavailable: failed to connect native pipe: 系统找不到指定的文件。 (os error 2)
```

- 阻断发生在产品启动之前：launch 0、GUI click 0、upload 0、model 0、manual retry 0。
- 唯一一次授权导入额度未消耗。
- 这是环境原生能力不可用，不是产品结果。当前保持 ACTIVE，等待 build/preflight 完成及 Root 后续 gate。
- 证据限度：本收据依据 Root 提供的三次工具结果记录，不是 native pipe 传输原始抓包。

