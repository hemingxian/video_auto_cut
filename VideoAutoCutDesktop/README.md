# VideoAutoCut Desktop

Electron + React + Vite desktop control app for VideoAutoCut.

## 开发

```bash
npm install
npm run dev
```

## 构建

```bash
npm run build
npm run dist
```

Windows 安装包和更新元数据输出到 `release/`。

## 软件更新

本项目已接入 `electron-updater`，使用 electron-builder 的 `generic` 更新源。

1. 在 `package.json` 的 `build.publish[0].url` 中配置真实 HTTPS 更新目录，或在用户配置 `app.env` 中设置 `VIDEOAUTO_UPDATE_URL` 覆盖。
2. 执行 `npm run dist`。
3. 将 `release/` 中的安装包、zip、`latest.yml` 和 `.blockmap` 文件上传到同一个更新目录。
4. 客户端启动后会自动后台检查，也可以在「软件更新」页面手动检查、下载并重启安装。

更多细节见 `build/README-updates.md`。
