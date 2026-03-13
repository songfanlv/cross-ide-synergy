# 跨 IDE 协同

跨 IDE 协同是一个面向多编辑器场景的实时协作项目，用于在不同 IDE 之间共享工作区、同步文件内容，并通过本地 sidecar 与云端中继完成会话连接。

当前仓库主要包含 VS Code / Antigravity IDE 扩展、JetBrains 插件、HBuilderX 发布包构建脚本，以及跨 IDE 联调和打包工具链。

## 支持范围

- VS Code / Cursor / Trae / MarsCode：使用 `.vsix` 安装
- JetBrains 系列：使用插件 `.zip` 安装
- HBuilderX：将插件目录解压到 `plugins/` 下安装

当前发布包路径：

- `release/vs_code/cross-ide-synergy-v3.0.0.vsix`
- `release/jetbrains/cross-ide-synergy-v3.0.0.zip`
- `release/hbuilderx/cross-ide-synergy-hbuilderx-v3.0.0.zip`

更具体的安装步骤可以参考 [release/INSTALL.md](release/INSTALL.md)。

## 仓库结构

- `src/`：VS Code / Antigravity IDE 扩展源码
- `core-agent/`：本地 sidecar 运行时源码
- `jetbrains-plugin/`：JetBrains 插件源码
- `scripts/`：构建、打包、联调、自动化脚本
- `release/`：发布说明与本地生成的发布包目录

## 环境要求

- Node.js 20 及以上
- npm
- Java 21
- Windows 开发环境

## 本地开发

安装依赖：

```bash
npm ci
```

构建扩展与 sidecar：

```bash
npm run build:release
```

生成 VS Code / Antigravity IDE 安装包：

```bash
npm run package
```

生成 JetBrains 安装包：

```bash
npm run build:jetbrains
```

生成 HBuilderX 安装包：

```bash
npm run build:hbuilderx
```

## 协作机制概览

1. Host 端创建会话并生成分享码。
2. Guest 端输入分享码加入会话。
3. 本地 sidecar 负责 WebSocket / RPC 控制与消息转发。
4. 工作区全量同步完成后，后续文件编辑通过增量或全量消息继续同步。

## 开源说明

- 仓库以源码为主，不建议提交 `node_modules/`、`out/`、`tmp/`、日志和本地缓存。
- 发布包建议在本地构建生成，不建议长期将二进制产物作为源码历史的一部分。
- 如果你要发布到自己的 GitHub 仓库，记得把 `package.json` 里的仓库地址改成你的真实地址。
