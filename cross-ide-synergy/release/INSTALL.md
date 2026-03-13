# 跨 IDE 协同插件安装指南

本文档用于说明当前发布包的安装方式。

## 1. VS Code / Cursor / Trae / MarsCode
- 分发包：`release/vs_code/cross-ide-synergy-v3.0.0.vsix`
- 安装方法：在扩展面板中选择“从 VSIX 安装”，然后选择该文件。

## 2. JetBrains 系列
- 分发包：`release/jetbrains/cross-ide-synergy-v3.0.0.zip`
- 安装方法：
  1. 打开 `Settings -> Plugins`
  2. 点击齿轮图标
  3. 选择 `Install Plugin from Disk...`
  4. 选择该 ZIP 文件

## 3. HBuilderX
- 分发包：`release/hbuilderx/cross-ide-synergy-hbuilderx-v3.0.0.zip`
- 安装方法：
  1. 解压 ZIP
  2. 将解压得到的 `cross-ide-synergy` 文件夹复制到 HBuilderX 安装目录下的 `plugins/` 目录
  3. 重启 HBuilderX

更多说明请参考仓库根目录下的 `README.md`。
