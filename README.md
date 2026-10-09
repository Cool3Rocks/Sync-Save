# Sync Save 0.2.4

Decky 插件，将非 Steam Proton 游戏的 Windows 用户目录连接到 Steam Deck 上已同步的用户目录。文件同步需要由其他工具完成。

## 使用

1. 安装 `artifacts/Sync-Save-0.2.4.zip`，重新加载插件，确认面板显示 `Sync Save · 0.2.4`。
2. 点击“选择目录”，进入包含 `AppData`、`Documents` 等文件夹的同步目录，并确认选择。应选择 Steam Deck 上的本地目录，不是 Windows 地址。
3. 设置“游戏启动时自动连接”，点击“保存设置”。只有后端完成写入和回读确认后才显示保存成功。
4. 启动非 Steam Proton 游戏。插件从进程环境寻找实际 prefix，等待 Proton 创建用户目录后备份 `steamuser`，再建立目录链接。
5. 链接有变化时提示并在 5 秒后请求 Steam 关闭游戏。重新启动游戏使目录生效；已正确连接时不再次关闭。接口异常时手动退出。

目录选择及未保存设置由插件级状态管理，面板关闭重开不会丢失；重新加载整个插件会放弃尚未保存的选择。刷新读取已保存状态与最近连接记录，保留当前未保存的选择。没有连接记录时显示“暂无连接记录”。

目录选择、保存、刷新和路径详情按钮统一铺满面板内容宽度，高 44px、字体 14px、圆角 6px。相邻控件的排列间距统一为 3px。最近连接显示在刷新按钮下方；路径以单行缩略显示，点击可查看完整路径。退出游戏的提示语位于面板最下方，字号为 12px，比正文小 2px。

启动非 Steam 游戏时，面板自动更新最近连接状态：正在检查、等待 Proton 初始化、已连接、链接已正确存在、自动连接已关闭或连接错误。最多检查 45 次，仍未找到时显示未连接。无需手动刷新；后台更新保留未保存设置，也不会覆盖保存提示。

目录失效时可关闭自动连接并保存。配置损坏时自动连接默认关闭并显示原因。操作超时会显示“结果未确认”；刷新核对实际保存结果后重试。

## 恢复

关闭自动连接并保存，退出游戏。在实际 prefix 的 `drive_c/users` 中移除 `steamuser` 符号链接，把 `steamuser.sync-save-backup-<标识>` 改回 `steamuser`。旧版的 `steamuser.proton-user-link-backup-*` 仍可按同样方法恢复。不要删除同步目录。

## 开发验证

安装 package.json 中的依赖，然后依次运行：

```text
npm run typecheck
npm run build
npm run test:frontend
python -m unittest discover -s tests -v
python tools/package.py
```

前端测试覆盖独立控制器及构建后的 Decky 入口，后端测试覆盖真实文件、符号链接和 RPC。需求与实机验收见 REQUIREMENTS.md，验证结果见 DEBUGGING.md。
