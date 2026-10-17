# 项目开发约定

## 分支流程

- 新功能和缺陷修复必须从最新的 `main` 创建独立分支。
- 创建分支前，先获取远端更新，并以 fast-forward 方式同步本地 `main`：

  ```sh
  git fetch origin
  git switch main
  git merge --ff-only origin/main
  git switch -c <feature-or-fix-branch>
  ```

- 不得从 `develop` 或其他功能、修复分支创建新的开发分支。
- 切换分支前，妥善保留未提交改动，不得覆盖或丢弃已有工作。
- 如果本地 `main` 与远端分叉，应先检查并处理分叉，不得强制重置。
- 合并、推送和创建 PR 按用户当前指示执行。
