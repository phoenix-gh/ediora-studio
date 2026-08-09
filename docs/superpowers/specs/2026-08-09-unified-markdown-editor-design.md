# 项目统一 Markdown 编辑器设计

## 目标

草稿箱正文编辑器改用资产中心文章编辑器，项目内只保留一套 Markdown 编辑能力。统一后的编辑器继续支持所见即所得编辑、网页结构粘贴、网络图片导入、图片文件粘贴/上传，以及通过外部按钮插入 Markdown 图片。

## 范围

- 将现有资产文章编辑器提取为共享的 `MarkdownEditor` 组件。
- 资产文章编辑器和草稿箱正文都使用该组件。
- 保留草稿箱现有标题、状态、AI 写作、保存、发布和“草稿图片库”入口。
- 草稿图片库的“插入图片”通过编辑器 ref 插入，并沿用草稿的脏状态与保存流程。
- 移除旧的 `@uiw/react-md-editor` 编辑器及其依赖，避免两套编辑器并存。

## 组件契约

共享组件放在 `wemedia-studio/components/MarkdownEditor.tsx`，提供：

```ts
export interface MarkdownEditorHandle {
  insert(markdown: string): void
}

type MarkdownEditorProps = {
  value: string
  onChange: (markdown: string) => void
  documentKey: string | number
}
```

`documentKey` 变化时销毁并重建编辑实例，避免切换草稿或资产时残留上一个文档；编辑器产生的 Markdown 通过 `onChange` 向父组件同步。`insert()` 使用 Milkdown 的插入 action，确保外部插入和手工编辑走同一条内容更新链路。

## 数据与图片行为

编辑器仍使用现有资产图片接口：本地图片通过 `/upload/image` 上传，网页中的远程图片通过 `/assets/images/import` 导入并替换为系统 URL。内部图片导入标记只在编辑器内部使用，向父组件发出的 Markdown 会清理这些标记。草稿自身的图片库仍由 `DraftsClient` 管理，点击插入时调用 `MarkdownEditorHandle.insert`。

## 文件调整

- 创建 `wemedia-studio/components/MarkdownEditor.tsx` 及其测试。
- 删除 `app/assets/AssetVisualMarkdownEditor.tsx` 和 `app/drafts/MarkdownEditor.tsx`，将原有测试迁移/合并到共享组件测试。
- 更新 `ArticleAssetWorkspace`、`DraftsClient` 及其测试的导入和 mock 路径。
- 从 `package.json` 与 lockfile 移除 `@uiw/react-md-editor`。

## 验证

- 运行共享编辑器测试，覆盖初始化 Markdown、编辑回调、文档切换、图片粘贴/导入失败、重试和外部 `insert`。
- 运行共享编辑器、`AssetsClient` 和 `DraftsClient` 的相关测试，确认资产切换、草稿切换、图片库插入和保存仍然有效。
- 运行 TypeScript/ESLint 的 scoped 检查；不执行全量测试。
