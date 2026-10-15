# VideoAutoCut Studio 发布说明

软件包含两个可以独立更新的部分：

- 桌面壳：安装包、自动更新文件和远程配置，上传到 COS 的 `updates/`。
- 视频生成引擎：运行环境压缩包和版本清单，上传到 COS 的 `runtime/`。

两者不要求同时发布。只修改了其中一个时，只打包并上传对应部分，不会改动另一部分的线上版本清单。

## 1. 本机配置

新建或修改 `VideoAutoCutDesktop/release-upload.local.json`：

```json
{
  "secretId": "腾讯云 SecretId",
  "secretKey": "腾讯云 SecretKey",
  "bucket": "完整存储桶名称，例如 vacut-1250000000",
  "region": "地域，例如 ap-chengdu",
  "publicBaseUrl": "",
  "desktopPrefix": "updates",
  "runtimePrefix": "runtime"
}
```

该文件已经被 `.gitignore` 忽略，不会提交。`publicBaseUrl` 留空时使用 COS 默认访问域名；使用 CDN 或自定义下载域名时，在这里填写完整 HTTPS 域名。

SecretId/SecretKey 需要具备目标对象的上传和分块上传权限。客户端还必须能公开读取更新目录，或者通过已配置的 CDN 下载。

## 2. 打包并上传

Windows 下可以直接双击 `VideoAutoCutDesktop/release.bat`，然后在菜单中选择要发布的部分并输入版本号，不需要手动修改配置或输入发布命令。直接按回车会使用菜单显示的当前版本。

桌面壳发布时会同时更新 `package.json` 和 `package-lock.json` 的版本号。只发布视频生成引擎时使用独立的引擎版本，不会修改桌面壳版本。

也可以在终端中执行以下命令。

只发布桌面壳：

```bash
npm run dist:publish
```

只发布视频生成引擎：

```bash
npm run runtime:publish
```

确认两部分都需要更新时：

```bash
npm run release
```

发布命令只会打包和校验选中的部分。发布视频生成引擎时会先自动执行 Rust Release 编译，并验证生成的 EXE 支持桌面壳所需参数，不再复用旧引擎文件。随后先上传大文件，最后才上传该部分的版本清单：桌面壳使用 `latest.yml`，视频生成引擎使用 `manifest.json`。

这样其中一个部分发布失败或没有变化时，不会影响另一个部分。

仅重新上传已有产物：

```bash
npm run release:upload:desktop  # 只上传桌面壳
npm run release:upload:runtime  # 只上传视频生成引擎
npm run release:upload          # 两部分都上传
```

仅在本地生成发布物、不上传：

```bash
npm run release:pack:desktop    # 只打包桌面壳
npm run runtime:pack            # 只打包视频生成引擎
npm run release:pack            # 两部分都打包
```

## 3. 生成的文件

桌面壳 `release/`：

- `VideoAutoCutStudioUserSetup-x64-<version>.exe`
- `VideoAutoCutStudioUserSetup-x64-<version>.exe.blockmap`
- `desktop-config.enc.json`
- `latest.yml`

`VideoAutoCutStudio-x64-<version>.zip` 可以作为本地离线包保留，但不会上传到 COS。

视频生成引擎 `runtime-release/`：

- `VideoAutoCut-runtime-<version>.zip`
- `manifest.json`

## 4. 开发环境测试

开发环境默认不检查桌面壳更新。如需测试，可在用户配置中设置：

```env
VIDEOAUTO_UPDATE_FORCE_DEV=true
VIDEOAUTO_UPDATE_URL=file:///C:/path/to/release/
```

正式发布不要开启 `VIDEOAUTO_UPDATE_FORCE_DEV`。
