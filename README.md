# Sync Save

一个用于 Steam Deck 的 Decky 插件，将非 Steam Proton 游戏的 Windows 用户目录连接到已同步到设备上的本地目录，让游戏通过同一个目录读写存档。

当前版本：**0.2.4**。

## 工作原理

先使用其他工具把 Windows 用户目录同步到 Steam Deck，再在 Sync Save 中选择这个本地目录。游戏启动时，插件寻找实际使用的 Proton 环境，将其中的 `drive_c/users/steamuser` 备份，并替换为指向所选目录的符号链接。

```text
Steam Deck 上已同步的目录
/home/deck/Sync/WindowsUser/
├── AppData/
├── Documents/
└── ...
         ↑
Proton prefix/drive_c/users/steamuser（符号链接）
```

Sync Save 负责建立目录连接；文件传输和同步冲突处理需要由其他工具完成。当前所有受处理的非 Steam Proton 游戏共用一个同步目录，不支持按游戏设置不同目录。

## 功能

- 使用目录选择器选择同步目录，保存路径和自动连接开关。
- 从游戏进程环境识别实际 Proton prefix，支持 `WINEPREFIX` 和 `STEAM_COMPAT_DATA_PATH`。
- 连接前保留原用户目录；链接已正确存在时不重复修改。
- 目录发生变化后提示用户，等待 5 秒，再请求 Steam 关闭游戏，供用户重新启动。
- 自动显示最近连接状态，支持查看完整目录路径。
- 校验目录权限和路径重叠；检测到多个候选 prefix 时拒绝修改。
- 配置损坏时默认关闭自动连接，并显示错误原因。

## 使用条件

- Steam Deck 上已安装并运行 Decky Loader。
- 游戏已添加为非 Steam 游戏，并通过 Proton 启动。
- Windows 用户目录已同步到 Steam Deck 的本地路径，且当前用户具有读写权限。

选择包含 `AppData`、`Documents` 等子目录的用户目录本身，例如 `/home/deck/Sync/WindowsUser`，不要选择其中的 `Documents` 子目录，也不要填写 Windows 的 `C:\Users\...` 路径。

首次连接前建议备份重要存档。插件会替换整个 `steamuser` 目录入口，不会把原目录中的存档自动合并到同步目录中。

## 安装

使用构建得到的 `Sync-Save-0.2.4.zip`，通过 Decky 的 ZIP 插件安装功能安装，然后重新加载插件。面板应显示 `Sync Save · 0.2.4`。

如果仓库的 [Releases](https://github.com/Cool3Rocks/Sync-Save/releases) 中已发布安装包，可以直接下载；否则请按下方开发步骤自行构建。GitHub 的源码 ZIP 不是插件安装包。

## 使用步骤

1. 先完成 Windows 用户目录到 Steam Deck 的同步。
2. 打开 Sync Save，点击“选择目录”，选择 Steam Deck 上的同步目录。
3. 开启“游戏启动时自动连接”，点击“保存设置”，等待保存成功提示。
4. 启动一个非 Steam Proton 游戏。插件会等待 Proton 初始化并尝试连接用户目录。
5. 如果提示目录已连接，等待游戏关闭，再重新启动。若 Steam 未实际关闭游戏，请手动退出后重启。
6. 再次启动时，如果链接已正确存在，插件不会再次请求关闭游戏。

修改目录或开关后必须保存才会生效。面板关闭再打开会保留未保存的选择，重新加载插件则会放弃这些选择。“刷新保存状态与连接记录”可核对已保存结果，并保留当前未保存的选择。

关闭自动连接只会停止后续自动处理，已经建立的目录链接仍然存在。如需还原，请按以下步骤操作。

## 恢复原用户目录

1. 关闭自动连接并保存，然后完全退出游戏。
2. 根据最近连接记录找到实际 Proton prefix，进入其 `drive_c/users` 目录。
3. 确认 `steamuser` 是插件建立的符号链接，再移除这个链接。**不要删除链接指向的同步目录或其中的文件。**
4. 将对应的 `steamuser.sync-save-backup-<标识>` 改名为 `steamuser`。
5. 重新启动游戏，确认原目录中的存档可用。

旧版备份可能使用 `steamuser.proton-user-link-backup-*` 名称，也可按同样方法恢复。如存在多个备份，请先检查内容，再选择要恢复的目录。

## 常见问题

**没有检测到 Proton 用户目录**

插件最多检查 45 次。确认游戏使用 Proton、插件在游戏启动前已经加载，以及 Proton 已创建 `steamuser` 目录。原生 Linux 游戏不属于当前支持范围。

**目录连接后没有看到原来的存档**

连接后游戏读取的是所选同步目录。原 Proton 用户目录保留在备份中，插件不会自动合并两边的存档。

**保存提示“结果未确认”**

点击“刷新保存状态与连接记录”核对实际保存结果，再决定是否重试。同步目录暂时不可用时，仍可关闭自动连接并保存。

**游戏没有自动退出**

手动退出并重新启动游戏。Steam 的关闭请求不能保证游戏已经实际退出。

**最近连接记录在重新加载后消失**

设置会持久化保存；最近连接记录仅保留在插件运行期间，重新加载后会清空。

## 开发与打包

本地开发需要 Node.js、npm 和 Python 3。Python 后端使用标准库，运行插件时由 Decky 提供运行环境。

```sh
git clone https://github.com/Cool3Rocks/Sync-Save.git
cd Sync-Save
npm install
npm run typecheck
npm run build
npm run test:frontend
python3 -m unittest discover -s tests -v
python3 tools/package.py
```

前端测试会读取构建产物，因此需要先运行 `npm run build`。打包也依赖 `dist/index.js`。

打包输出：

- `artifacts/Sync-Save-0.2.4.zip`：带版本号的安装包。
- `artifacts/Sync-Save.zip`：相同安装包的无版本号副本。

`node_modules/`、`dist/`、`artifacts/` 和 Python 缓存已通过 `.gitignore` 排除。安装包可作为 GitHub Release 附件单独发布。

### 项目结构

| 路径 | 用途 |
| --- | --- |
| `src/index.tsx` | Decky 面板和 Steam 接口适配 |
| `src/controller.ts` | 设置与界面状态管理 |
| `src/games.ts` | 游戏启动监听、等待和关闭请求 |
| `main.py` | Decky 后端接口 |
| `linker.py` | Proton 环境识别、备份和目录连接 |
| `sync_save_settings.py` | 设置校验、原子写入和回读确认 |
| `tests/` | 前端与后端测试 |
| `tools/package.py` | 安装包生成与完整性检查 |

需求和验收步骤见 [REQUIREMENTS.md](REQUIREMENTS.md)，历史调试与验证记录见 [DEBUGGING.md](DEBUGGING.md)。本地测试不替代 Steam Deck 实机验收，目录选择、进程权限和游戏退出行为仍需在设备上确认。
