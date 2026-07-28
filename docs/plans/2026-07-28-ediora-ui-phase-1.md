# Ediora UI Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 建立 Ediora 统一设计令牌、主题、应用外壳和共享 UI 组件，并完成今日工作台、创作资产、设置页三类页面的首批重构。

**Architecture:** 先以 CSS 语义令牌统一色彩、排版与尺寸，再让基础控件和布局组件只消费语义令牌。页面迁移保持现有 API、状态和业务流程不变，只替换显示结构、反馈容器和控件实现；通过组件测试、策略扫描、生产构建和真实浏览器截图分层验收。

**Tech Stack:** Next.js 16.2.4 App Router、React 19.2.4、Tailwind CSS 4、Base UI / shadcn、next-themes、Vitest 4、Testing Library、Playwright Chromium。

## Global Constraints

- 视觉方向固定为“A · 智性靛蓝”。
- `primary` 只负责主要操作和当前选择；`data` 只负责采集与数据；`ai` 只负责 AI 能力。
- 默认正文 14px，辅助信息 12px；不得用 9–11px 作为普通正文。
- 一级侧栏桌面宽度固定 224px，根布局只产生一次侧栏偏移。
- 创作资产文章区保持约 25% 列表和 75% Markdown 编辑器。
- 多媒体资产保持紧凑网格和双击 Dialog 预览。
- 桌面端不使用业务侧边抽屉；配置、素材选择、工作流和发布使用应用内 Dialog。
- 不使用浏览器原生 `prompt`、`confirm`、`alert`。
- 不修改采集、分析、创作、任务、发布、`generateImage` 和“待响应”的业务语义。
- 不修改后端接口、数据库或任务队列。
- `docs/superpowers` 不进入 Git；本计划保存在 `docs/plans`。
- 实施位置固定为 `/workspace/projects/WeMediaStudio/.worktrees/main-runtime`。
- 第一阶段开始前基线为 Vitest `49` 个文件、`175` 个测试全部通过。

## Phase Boundary

本计划只实现可独立验收的第一阶段：

1. 设计令牌与主题。
2. 基础控件与共享布局。
3. 应用外壳和一级导航。
4. 今日工作台试点。
5. 创作资产试点。
6. 设置页试点。
7. UI 策略守卫与浏览器验收。

草稿箱、写作模板、创作任务、待响应、数字人口播和 AI 助手属于第二阶段；GitHub、YouTube、X、公众号、V2EX、36 氪、掘金、论文、Reddit、Product Hunt 属于第三阶段。第二、三阶段必须继续复用本阶段产出的接口，不重新设计视觉体系。

---

### Task 1: Design Tokens and Unified Theme Source

**Files:**
- Create: `wemedia-studio/app/design-system-tokens.test.ts`
- Create: `wemedia-studio/components/providers/ThemeProvider.tsx`
- Create: `wemedia-studio/components/providers/ThemeProvider.test.tsx`
- Modify: `wemedia-studio/app/globals.css`
- Modify: `wemedia-studio/app/layout.tsx`
- Modify: `wemedia-studio/components/ui/sonner.tsx`

**Interfaces:**
- Produces: CSS variables `--surface`, `--surface-muted`, `--foreground-subtle`, `--border-strong`, `--data`, `--data-foreground`, `--data-subtle`, `--ai`, `--ai-foreground`, `--ai-subtle`, `--success`, `--warning`, `--danger`, `--info`.
- Produces: `ThemeProvider({ children }: { children: React.ReactNode }): React.ReactElement`.
- Consumes: `next-themes` with `attribute="class"`, `defaultTheme="system"`, `enableSystem`, `disableTransitionOnChange`.

- [ ] **Step 1: Write the failing token contract test**

```ts
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const css = readFileSync(resolve(process.cwd(), 'app/globals.css'), 'utf8')

const REQUIRED_TOKENS = [
  '--surface:',
  '--surface-muted:',
  '--foreground-subtle:',
  '--border-strong:',
  '--data:',
  '--data-foreground:',
  '--data-subtle:',
  '--ai:',
  '--ai-foreground:',
  '--ai-subtle:',
  '--success:',
  '--warning:',
  '--danger:',
  '--info:',
]

describe('Ediora design tokens', () => {
  it.each(REQUIRED_TOKENS)('defines %s in light and dark themes', token => {
    expect(css.split(token)).toHaveLength(3)
  })

  it('maps the sans font to Geist instead of itself', () => {
    expect(css).toContain('--font-sans: var(--font-geist-sans)')
    expect(css).not.toContain('--font-sans: var(--font-sans)')
  })
})
```

- [ ] **Step 2: Run the token test and verify RED**

Run:

```bash
pnpm exec vitest run app/design-system-tokens.test.ts
```

Expected: FAIL because the semantic tokens are absent and `--font-sans` is self-referential.

- [ ] **Step 3: Add exact Light/Dark tokens and Tailwind mappings**

In `app/globals.css`, preserve shadcn’s required variables and map the accepted design values:

```css
@theme inline {
  --color-surface: var(--surface);
  --color-surface-muted: var(--surface-muted);
  --color-foreground-subtle: var(--foreground-subtle);
  --color-border-strong: var(--border-strong);
  --color-data: var(--data);
  --color-data-foreground: var(--data-foreground);
  --color-data-subtle: var(--data-subtle);
  --color-ai: var(--ai);
  --color-ai-foreground: var(--ai-foreground);
  --color-ai-subtle: var(--ai-subtle);
  --color-success: var(--success);
  --color-warning: var(--warning);
  --color-danger: var(--danger);
  --color-info: var(--info);
  --font-sans: var(--font-geist-sans);
}

:root {
  --background: #f7f8fc;
  --foreground: #172033;
  --surface: #ffffff;
  --surface-muted: #fbfcfe;
  --card: #ffffff;
  --card-foreground: #172033;
  --popover: #ffffff;
  --popover-foreground: #172033;
  --primary: #5b5fe8;
  --primary-foreground: #ffffff;
  --secondary: #f2f4f7;
  --secondary-foreground: #344054;
  --muted: #f2f4f7;
  --muted-foreground: #667085;
  --foreground-subtle: #98a2b3;
  --accent: #eef0ff;
  --accent-foreground: #4f46e5;
  --destructive: #b42318;
  --border: #e6e9f1;
  --border-strong: #d9deea;
  --input: #d9deea;
  --ring: #5b5fe8;
  --data: #22c3de;
  --data-foreground: #078ca5;
  --data-subtle: #e8fbff;
  --ai: #8b5cf6;
  --ai-foreground: #7c3aed;
  --ai-subtle: #f4ebff;
  --success: #067647;
  --warning: #b54708;
  --danger: #b42318;
  --info: #026aa2;
  --radius: 0.5rem;
  --sidebar-width: 14rem;
}

.dark {
  --background: #0e111b;
  --foreground: #f0f2f8;
  --surface: #151a27;
  --surface-muted: #1c2231;
  --card: #151a27;
  --card-foreground: #f0f2f8;
  --popover: #151a27;
  --popover-foreground: #f0f2f8;
  --primary: #7c83ff;
  --primary-foreground: #ffffff;
  --secondary: #1c2231;
  --secondary-foreground: #f0f2f8;
  --muted: #1c2231;
  --muted-foreground: #9ca8bd;
  --foreground-subtle: #657086;
  --accent: #252345;
  --accent-foreground: #c9c8ff;
  --destructive: #fda29b;
  --border: #272f42;
  --border-strong: #364057;
  --input: #364057;
  --ring: #7c83ff;
  --data: #22d3ee;
  --data-foreground: #74e7f5;
  --data-subtle: #153642;
  --ai: #a78bfa;
  --ai-foreground: #c4b5fd;
  --ai-subtle: #2d2143;
  --success: #6ce9a6;
  --warning: #fec84b;
  --danger: #fda29b;
  --info: #7cd4fd;
}
```

Keep the existing shadcn aliases such as `--sidebar-*` and `--chart-*`, but point them to the new semantic values rather than separate gray scales.

- [ ] **Step 4: Write the failing ThemeProvider wrapper test**

```tsx
// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

const provider = vi.hoisted(() => vi.fn(({ children }) => <>{children}</>))
vi.mock('next-themes', () => ({ ThemeProvider: provider }))

import { ThemeProvider } from './ThemeProvider'

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('ThemeProvider', () => {
  it('uses class themes with system as the default', () => {
    render(<ThemeProvider><span>content</span></ThemeProvider>)
    expect(screen.getByText('content')).toBeTruthy()
    expect(provider).toHaveBeenCalledWith(expect.objectContaining({
      attribute: 'class',
      defaultTheme: 'system',
      enableSystem: true,
      disableTransitionOnChange: true,
    }), undefined)
  })
})
```

- [ ] **Step 5: Run the provider test and verify RED**

Run:

```bash
pnpm exec vitest run components/providers/ThemeProvider.test.tsx
```

Expected: FAIL because `ThemeProvider.tsx` does not exist.

- [ ] **Step 6: Implement the provider and unify layout/Toaster theme**

Create `components/providers/ThemeProvider.tsx`:

```tsx
'use client'

import { ThemeProvider as NextThemesProvider } from 'next-themes'

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  return (
    <NextThemesProvider
      attribute="class"
      defaultTheme="system"
      enableSystem
      disableTransitionOnChange
    >
      {children}
    </NextThemesProvider>
  )
}
```

In `app/layout.tsx`:

```tsx
<html
  lang="zh-CN"
  suppressHydrationWarning
  className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
>
  <body className="min-h-full bg-background text-foreground">
    <ThemeProvider>
      {/* AppShell is introduced in Task 3. Keep the existing Sidebar/main
          structure until that task to maintain a green intermediate commit. */}
      <Sidebar />
      <main className="ml-56 h-screen overflow-auto">{children}</main>
      <Toaster position="bottom-right" />
    </ThemeProvider>
  </body>
</html>
```

In `components/ui/sonner.tsx`, remove the independent `matchMedia` effect and use:

```tsx
const { resolvedTheme } = useTheme()
const theme: ToasterProps['theme'] = resolvedTheme === 'dark' ? 'dark' : 'light'
```

- [ ] **Step 7: Run focused and full tests**

Run:

```bash
pnpm exec vitest run app/design-system-tokens.test.ts components/providers/ThemeProvider.test.tsx
pnpm test
```

Expected: both focused tests PASS; full suite remains green.

- [ ] **Step 8: Commit Task 1**

```bash
git add wemedia-studio/app/globals.css wemedia-studio/app/layout.tsx \
  wemedia-studio/app/design-system-tokens.test.ts \
  wemedia-studio/components/providers/ThemeProvider.tsx \
  wemedia-studio/components/providers/ThemeProvider.test.tsx \
  wemedia-studio/components/ui/sonner.tsx
git commit -m "feat: add Ediora design tokens and themes"
```

---

### Task 2: UI Primitive Contracts

**Files:**
- Create: `wemedia-studio/test/setup-dom.ts`
- Create: `wemedia-studio/components/ui/ui-primitives.test.tsx`
- Create: `wemedia-studio/components/ui/dialog.test.tsx`
- Modify: `wemedia-studio/vitest.config.ts`
- Modify: `wemedia-studio/components/ui/button.tsx`
- Modify: `wemedia-studio/components/ui/input.tsx`
- Modify: `wemedia-studio/components/ui/textarea.tsx`
- Modify: `wemedia-studio/components/ui/select.tsx`
- Modify: `wemedia-studio/components/ui/badge.tsx`
- Modify: `wemedia-studio/components/ui/card.tsx`
- Modify: `wemedia-studio/components/ui/dialog.tsx`
- Modify: `wemedia-studio/components/ui/alert-dialog.tsx`
- Modify: `wemedia-studio/components/ui/tabs.tsx`
- Modify: `wemedia-studio/components/ui/switch.tsx`

**Interfaces:**
- Produces: `Button` sizes `sm=32px`, `default=36px`, `lg=40px`.
- Produces: `DialogContent` prop `size?: 'sm' | 'md' | 'lg'`, mapped to 480px / 720px / 960px.
- Produces: `Badge` variants `default | secondary | outline | destructive | data | ai | success | warning | info`.
- Produces: shared DOM setup for all jsdom tests.

- [ ] **Step 1: Add the shared DOM setup**

Create `test/setup-dom.ts`:

```ts
import '@testing-library/jest-dom/vitest'
import { cleanup } from '@testing-library/react'
import { afterEach, vi } from 'vitest'

afterEach(() => cleanup())

if (typeof window !== 'undefined') {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn().mockImplementation(query => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  })

  class ResizeObserverStub {
    observe() {}
    unobserve() {}
    disconnect() {}
  }

  vi.stubGlobal('ResizeObserver', ResizeObserverStub)
  HTMLElement.prototype.scrollIntoView = vi.fn()
}
```

Add to `vitest.config.ts`:

```ts
test: {
  setupFiles: ['./test/setup-dom.ts'],
},
```

Keep the default environment as Node; component files continue to declare `// @vitest-environment jsdom`.

- [ ] **Step 2: Write failing primitive contract tests**

```tsx
// @vitest-environment jsdom
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { Badge } from './badge'
import { Button } from './button'
import { Input } from './input'
import { Textarea } from './textarea'

describe('UI primitive contracts', () => {
  it.each([
    ['sm', 'h-8'],
    ['default', 'h-9'],
    ['lg', 'h-10'],
  ] as const)('maps %s buttons to %s', (size, className) => {
    render(<Button size={size}>Action</Button>)
    expect(screen.getByRole('button', { name: 'Action' })).toHaveClass(className)
  })

  it('uses 36px default text controls', () => {
    render(<><Input aria-label="Title" /><Textarea aria-label="Body" /></>)
    expect(screen.getByLabelText('Title')).toHaveClass('h-9')
    expect(screen.getByLabelText('Body')).toHaveClass('text-sm')
  })

  it.each(['data', 'ai', 'success', 'warning', 'info'] as const)(
    'renders the %s semantic badge',
    variant => {
      render(<Badge variant={variant}>{variant}</Badge>)
      expect(screen.getByText(variant)).toHaveAttribute('data-variant', variant)
    },
  )
})
```

- [ ] **Step 3: Run primitive tests and verify RED**

Run:

```bash
pnpm exec vitest run components/ui/ui-primitives.test.tsx
```

Expected: FAIL because sizes and semantic badge variants do not exist.

- [ ] **Step 4: Implement primitive sizes and semantic variants**

Use these exact size contracts:

```ts
size: {
  sm: 'h-8 gap-1.5 px-3 text-sm',
  default: 'h-9 gap-2 px-3.5 text-sm',
  lg: 'h-10 gap-2 px-4 text-sm',
  icon: 'size-9',
  'icon-sm': 'size-8',
  'icon-lg': 'size-10',
}
```

Default `Input` becomes `h-9 rounded-lg px-3 text-sm`; `Textarea` remains content-sized with `min-h-20 rounded-lg px-3 py-2.5 text-sm`.

Add Badge variants:

```ts
data: 'bg-data-subtle text-data-foreground',
ai: 'bg-ai-subtle text-ai-foreground',
success: 'bg-success/10 text-success',
warning: 'bg-warning/10 text-warning',
info: 'bg-info/10 text-info',
```

Replace raw foreground rings in Card and Tabs with `border-border`, `bg-surface`, `text-foreground`, `text-muted-foreground`, `bg-accent`, and `text-accent-foreground`.

- [ ] **Step 5: Write failing Dialog size and behavior tests**

The test must:

1. Open a Dialog through `DialogTrigger`.
2. Assert `data-size="sm"`, `"md"`, and `"lg"` on `DialogContent`.
3. Close with Escape.
4. Assert focus returns to the trigger.
5. Open AlertDialog and verify the destructive callback only runs after the explicit confirm button.

- [ ] **Step 6: Run Dialog tests and verify RED**

Run:

```bash
pnpm exec vitest run components/ui/dialog.test.tsx
```

Expected: FAIL because `DialogContent` has no size prop or size data attribute.

- [ ] **Step 7: Implement Dialog size variants**

Add:

```ts
const dialogSizeClass = {
  sm: 'sm:max-w-[480px]',
  md: 'sm:max-w-[720px]',
  lg: 'sm:max-w-[960px]',
} as const
```

Update the signature:

```tsx
function DialogContent({
  className,
  children,
  showCloseButton = true,
  size = 'sm',
  ...props
}: DialogPrimitive.Popup.Props & {
  showCloseButton?: boolean
  size?: keyof typeof dialogSizeClass
}) {
  // data-size={size}
  // className includes dialogSizeClass[size]
}
```

Use `rounded-[var(--radius-dialog,1rem)]`, `border border-border`, `bg-popover`, and a semantic overlay. Preserve Base UI focus trapping and focus return.

- [ ] **Step 8: Run Task 2 tests and full suite**

Run:

```bash
pnpm exec vitest run components/ui/ui-primitives.test.tsx components/ui/dialog.test.tsx
pnpm test
```

Expected: all tests PASS.

- [ ] **Step 9: Commit Task 2**

```bash
git add wemedia-studio/test/setup-dom.ts wemedia-studio/vitest.config.ts \
  wemedia-studio/components/ui
git commit -m "feat: standardize Ediora UI primitives"
```

---

### Task 3: App Shell and Shared Layout Components

**Files:**
- Create: `wemedia-studio/components/layout/AppShell.tsx`
- Create: `wemedia-studio/components/layout/PageHeader.tsx`
- Create: `wemedia-studio/components/layout/WorkspaceToolbar.tsx`
- Create: `wemedia-studio/components/layout/SplitWorkspace.tsx`
- Create: `wemedia-studio/components/layout/FormSection.tsx`
- Create: `wemedia-studio/components/layout/AsyncState.tsx`
- Create: `wemedia-studio/components/layout/StatusBadge.tsx`
- Create: `wemedia-studio/components/layout/layout-components.test.tsx`
- Create: `wemedia-studio/components/features/Sidebar.test.tsx`
- Modify: `wemedia-studio/app/layout.tsx`
- Modify: `wemedia-studio/components/features/Sidebar.tsx`
- Modify: `wemedia-studio/components/features/sidebar-digital-human.test.ts`

**Interfaces:**
- Produces: `AppShell({ sidebar, children })`.
- Produces: `PageHeader({ eyebrow?, title, description?, count?, actions? })`.
- Produces: `WorkspaceToolbar({ title?, count?, children, actions? })`.
- Produces: `SplitWorkspace({ list, editor, listLabel, editorLabel })`.
- Produces: `FormSection({ title, description?, children, actions? })`.
- Produces: `AsyncState` variants `loading | empty | error`.
- Produces: `StatusBadge` variants `neutral | data | ai | success | warning | danger | info`.

- [ ] **Step 1: Write failing layout component tests**

```tsx
// @vitest-environment jsdom
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { PageHeader } from './PageHeader'
import { SplitWorkspace } from './SplitWorkspace'

describe('layout components', () => {
  it('renders one page heading and a named action region', () => {
    render(<PageHeader title="创作资产" actions={<button>新增素材</button>} />)
    expect(screen.getByRole('heading', { level: 1, name: '创作资产' })).toBeTruthy()
    expect(screen.getByRole('group', { name: '页面操作' })).toBeTruthy()
  })

  it('exposes stable list and editor regions', () => {
    render(
      <SplitWorkspace
        listLabel="素材列表"
        editorLabel="素材编辑器"
        list={<div>List</div>}
        editor={<div>Editor</div>}
      />,
    )
    expect(screen.getByRole('region', { name: '素材列表' })).toBeTruthy()
    expect(screen.getByRole('region', { name: '素材编辑器' })).toBeTruthy()
  })
})
```

- [ ] **Step 2: Run layout tests and verify RED**

Run:

```bash
pnpm exec vitest run components/layout/layout-components.test.tsx
```

Expected: FAIL because the layout components do not exist.

- [ ] **Step 3: Implement focused layout components**

`SplitWorkspace` must use:

```tsx
<div className="grid min-h-0 flex-1 grid-cols-[minmax(280px,1fr)_minmax(0,3fr)]">
  <section aria-label={listLabel} className="min-h-0 overflow-y-auto border-r border-border bg-surface-muted">
    {list}
  </section>
  <section aria-label={editorLabel} className="min-h-0 overflow-hidden bg-surface">
    {editor}
  </section>
</div>
```

`PageHeader` uses a 28/34 title, 12/18 eyebrow/meta, and a 28px page inset. `WorkspaceToolbar` uses a 56px minimum height and places actions at the far right. `FormSection` uses 12px panel radius and 16px field rhythm. `AsyncState` reuses existing `Empty` and `Skeleton` primitives.

- [ ] **Step 4: Write failing AppShell/Sidebar tests**

Mock `usePathname()` to return `/assets`, render `AppShell` with `Sidebar`, then assert:

- `创作资产` has `aria-current="page"`.
- exactly one `<main>` exists.
- main contains `data-slot="app-content"`.
- the sidebar has an accessible label `主导航`.
- labels remain in the accessibility tree in compact mode.

- [ ] **Step 5: Run AppShell/Sidebar tests and verify RED**

Run:

```bash
pnpm exec vitest run components/features/Sidebar.test.tsx components/features/sidebar-digital-human.test.ts
```

Expected: FAIL because current links lack `aria-current`, the sidebar lacks an accessible label, and AppShell does not exist.

- [ ] **Step 6: Implement AppShell and semantic Sidebar**

`AppShell`:

```tsx
export function AppShell({
  sidebar,
  children,
}: {
  sidebar: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <div className="min-h-dvh bg-background text-foreground">
      {sidebar}
      <main
        data-slot="app-content"
        className="min-h-dvh pl-[var(--sidebar-width)]"
      >
        {children}
      </main>
    </div>
  )
}
```

Sidebar requirements:

- `aria-label="主导航"`.
- `w-[var(--sidebar-width)]`.
- active links use `bg-accent text-accent-foreground` and an inset 3px primary marker.
- active links set `aria-current="page"`.
- normal links use `text-muted-foreground hover:bg-muted hover:text-foreground`.
- at 1024px and below, set `--sidebar-width: 4.5rem`; visually hide labels with `max-lg:sr-only` while preserving accessible names.

Replace the old `Sidebar` plus `main.ml-56` structure in `app/layout.tsx` with:

```tsx
<AppShell sidebar={<Sidebar />}>{children}</AppShell>
```

- [ ] **Step 7: Run Task 3 tests and full suite**

Run:

```bash
pnpm exec vitest run components/layout/layout-components.test.tsx \
  components/features/Sidebar.test.tsx \
  components/features/sidebar-digital-human.test.ts
pnpm test
```

Expected: all tests PASS.

- [ ] **Step 8: Commit Task 3**

```bash
git add wemedia-studio/components/layout wemedia-studio/components/features/Sidebar.tsx \
  wemedia-studio/components/features/Sidebar.test.tsx \
  wemedia-studio/components/features/sidebar-digital-human.test.ts \
  wemedia-studio/app/layout.tsx wemedia-studio/app/globals.css
git commit -m "feat: add unified Ediora app shell"
```

---

### Task 4: Dashboard Pilot

**Files:**
- Create: `wemedia-studio/components/features/dashboard/dashboard-components.test.tsx`
- Modify: `wemedia-studio/app/page.tsx`
- Modify: `wemedia-studio/components/features/dashboard/AlertsBar.tsx`
- Modify: `wemedia-studio/components/features/dashboard/TodayPlan.tsx`
- Modify: `wemedia-studio/components/features/dashboard/ReleasesToday.tsx`
- Modify: `wemedia-studio/components/features/dashboard/SourceStatusGrid.tsx`
- Modify: `wemedia-studio/components/features/dashboard/GenerateDraftButton.tsx`
- Modify: `wemedia-studio/components/features/CreateTaskDialog.tsx`

**Interfaces:**
- Consumes: `PageHeader`, `AsyncState`, `StatusBadge`, semantic `Alert`, updated `Button`, `Textarea`, and sized `DialogContent`.
- Preserves: existing dashboard API and `CreateTaskDialog` job payload.

- [ ] **Step 1: Write failing dashboard behavior and semantics tests**

Test these real outcomes:

1. Empty TodayPlan renders heading `今日计划` and link `去生成`.
2. A warning Alert renders action link without hard-coded platform color semantics.
3. A SourceStatus with `last_status="error"` renders `StatusBadge` or semantic danger marker.
4. `GenerateDraftButton` disables itself and retains an accessible loading name while the request is running.
5. `CreateTaskDialog` renders `DialogContent size="md"` and uses the shared `Textarea`.

- [ ] **Step 2: Run dashboard tests and verify RED**

Run:

```bash
pnpm exec vitest run components/features/dashboard/dashboard-components.test.tsx
```

Expected: FAIL because dashboard components still use handwritten classes and native buttons/textareas.

- [ ] **Step 3: Migrate dashboard components**

Apply exact semantic substitutions:

- Page canvas: `bg-background`.
- Panel: `bg-surface border-border`.
- Main text: `text-foreground`.
- Secondary text: `text-muted-foreground`.
- Subtle meta: `text-foreground-subtle`.
- Primary action/link: `text-primary` or default `Button`.
- Alerts: use `Alert` with `danger | warning | info` semantics.
- Plan/release rows: use standard 64px rows and `StatusBadge`.
- Empty sections: use `AsyncState variant="empty"`.
- Create Task dialog: `size="md"`, `Input`, `Textarea`, inline field errors, primary submit button.

Do not add dashboard data fields or change endpoint calls.

- [ ] **Step 4: Run dashboard tests and inspect focused route**

Run:

```bash
pnpm exec vitest run components/features/dashboard/dashboard-components.test.tsx
curl -fsS http://127.0.0.1:3000/ >/dev/null
```

Expected: tests PASS and dashboard route returns 200.

- [ ] **Step 5: Commit Task 4**

```bash
git add wemedia-studio/app/page.tsx \
  wemedia-studio/components/features/CreateTaskDialog.tsx \
  wemedia-studio/components/features/dashboard
git commit -m "feat: restyle Ediora dashboard"
```

---

### Task 5: Creative Assets Pilot

**Files:**
- Create: `wemedia-studio/app/assets/AssetDirectoryRail.tsx`
- Create: `wemedia-studio/app/assets/ArticleAssetWorkspace.tsx`
- Create: `wemedia-studio/app/assets/MediaAssetGrid.tsx`
- Create: `wemedia-studio/app/assets/AssetsClient.test.tsx`
- Modify: `wemedia-studio/app/assets/AssetsClient.tsx`
- Modify: `wemedia-studio/app/assets/assets-layout.test.ts`
- Modify: `wemedia-studio/app/assets/assets-system-directory.test.tsx`

**Interfaces:**
- Consumes: `WorkspaceToolbar`, `SplitWorkspace`, `AsyncState`, `Button`, `Tabs`, `DialogContent size`, and `AlertDialog`.
- Produces: presentational components whose callbacks do not call APIs directly.
- Preserves: all existing `CreativeAsset`, directory and CRUD API contracts.

- [ ] **Step 1: Replace brittle layout assertions with failing behavior tests**

`AssetsClient.test.tsx` must cover:

1. Article mode renders a named `素材列表` region and `素材编辑器` region.
2. Clicking a different article updates the right editor without navigation.
3. Editing title/content and saving calls `updateCreativeAsset` with the selected ID.
4. New article validation keeps entered content visible after a missing-title error.
5. Delete requires application AlertDialog confirmation.
6. Media mode renders the compact grid and double-click opens preview Dialog.
7. System directory has no rename/delete actions.

Update `assets-layout.test.ts` to stop asserting exact Tailwind strings. It may retain a policy assertion that `onDoubleClick` opens the preview Dialog until the interaction test fully covers it.

- [ ] **Step 2: Run asset tests and verify RED**

Run:

```bash
pnpm exec vitest run app/assets/AssetsClient.test.tsx \
  app/assets/assets-layout.test.ts \
  app/assets/assets-system-directory.test.tsx
```

Expected: new behavior tests FAIL because named regions, AlertDialog and shared layout do not exist.

- [ ] **Step 3: Extract stateless asset views**

`AssetDirectoryRail` receives:

```ts
type AssetDirectoryRailProps = {
  type: 'article' | 'media'
  activeDirectory: string
  directories: CreativeAssetDirectory[]
  count: (name: string) => number
  onTypeChange: (type: 'article' | 'media') => void
  onDirectoryChange: (name: string) => void
  onAddDirectory: () => void
  onRenameDirectory: (directory: CreativeAssetDirectory) => void
  onDeleteDirectory: (directory: CreativeAssetDirectory) => void
}
```

`ArticleAssetWorkspace` receives:

```ts
type ArticleAssetWorkspaceProps = {
  assets: CreativeAsset[]
  selected: CreativeAsset | undefined
  onSelect: (id: number) => void
  onChange: (asset: CreativeAsset) => void
  onSave: () => void
  onDelete: () => void
}
```

`MediaAssetGrid` receives:

```ts
type MediaAssetGridProps = {
  assets: CreativeAsset[]
  selectedId: number | null
  onSelect: (id: number) => void
  onPreview: (asset: CreativeAsset) => void
}
```

API calls and Dialog state remain in `AssetsClient`.

- [ ] **Step 4: Implement the accepted asset layout**

- Directory rail: 240px surface-muted panel.
- Article workspace: `SplitWorkspace` with 280px minimum list and 1:3 grid.
- Article list selected state: `primary-subtle` plus 3px primary marker.
- Editor header: title left, delete secondary-danger, save primary on right.
- Markdown editor fills remaining editor height.
- Media mode: full-width compact grid, three columns at base, six at medium, eight at XL.
- Preview: `DialogContent size="lg"`.
- New article and directory forms: Small or Medium Dialog based on form length.
- Delete article/directory: AlertDialog.
- No business side drawer.

- [ ] **Step 5: Run asset tests and full suite**

Run:

```bash
pnpm exec vitest run app/assets
pnpm test
```

Expected: all asset and full tests PASS.

- [ ] **Step 6: Commit Task 5**

```bash
git add wemedia-studio/app/assets
git commit -m "feat: rebuild creative assets workspace"
```

---

### Task 6: Settings Pilot and Appearance Control

**Files:**
- Create: `wemedia-studio/app/settings/SettingsClient.test.tsx`
- Create: `wemedia-studio/app/settings/sections/AppearanceSection.tsx`
- Create: `wemedia-studio/app/settings/sections/AppearanceSection.test.tsx`
- Modify: `wemedia-studio/app/settings/SettingsClient.tsx`
- Modify: `wemedia-studio/app/settings/sections/AISection.tsx`
- Modify: `wemedia-studio/app/settings/sections/ArxivSection.tsx`
- Modify: `wemedia-studio/app/settings/sections/BlogSection.tsx`
- Modify: `wemedia-studio/app/settings/sections/CollectSection.tsx`
- Modify: `wemedia-studio/app/settings/sections/GitHubSection.tsx`
- Modify: `wemedia-studio/app/settings/sections/HeyGenSection.tsx`
- Modify: `wemedia-studio/app/settings/sections/LogsSection.tsx`
- Modify: `wemedia-studio/app/settings/sections/PublishAccountsSection.tsx`
- Modify: `wemedia-studio/app/settings/sections/TranscriptionSection.tsx`
- Modify: `wemedia-studio/app/settings/sections/WebFetchSection.tsx`
- Modify: `wemedia-studio/app/settings/sections/WebSearchSection.tsx`
- Modify: `wemedia-studio/app/settings/sections/XSection.tsx`
- Modify: `wemedia-studio/app/settings/sections/YouTubeSection.tsx`

**Interfaces:**
- Consumes: `PageHeader`, `FormSection`, semantic controls and `useTheme()`.
- Produces: settings section ID `appearance`.
- Preserves: every settings API payload and existing section behavior.

- [ ] **Step 1: Write failing settings shell and appearance tests**

`SettingsClient.test.tsx`:

- renders navigation named `设置导航`;
- exposes an `外观` section;
- clicking `外观` renders heading `外观与主题`;
- selected settings item uses `aria-current="page"`;
- content region has a maximum width contract without asserting exact class order.

`AppearanceSection.test.tsx` mocks only `useTheme()` and asserts:

- System, Light and Dark options render;
- clicking Light calls `setTheme('light')`;
- current `theme` has `aria-pressed="true"`.

- [ ] **Step 2: Run settings tests and verify RED**

Run:

```bash
pnpm exec vitest run app/settings/SettingsClient.test.tsx \
  app/settings/sections/AppearanceSection.test.tsx
```

Expected: FAIL because the appearance section and accessibility attributes do not exist.

- [ ] **Step 3: Implement settings shell and AppearanceSection**

Add navigation item:

```ts
{ id: 'appearance', label: '外观', icon: Palette, desc: '系统 · 浅色 · 深色' }
```

`AppearanceSection` uses three Button-like radio choices:

```tsx
const OPTIONS = [
  { value: 'system', label: '跟随系统' },
  { value: 'light', label: '浅色' },
  { value: 'dark', label: '深色' },
] as const
```

Each choice sets `aria-pressed={theme === value}` and calls `setTheme(value)`.

Settings layout:

- navigation width 240px;
- navigation surface `surface-muted`;
- content maximum width 760px;
- `PageHeader` provides section title and description;
- logs may use full remaining width;
- no nested `min-h-screen`.

- [ ] **Step 4: Migrate all settings sections to semantic primitives**

For every listed settings section:

- replace native text inputs with `Input`;
- replace native textarea with `Textarea`;
- replace native select with shadcn `Select`;
- replace native checkbox with `Switch` or explicit checkbox component where multi-select semantics require it;
- replace native confirm with `AlertDialog`;
- group each configuration block in `FormSection`;
- replace raw zinc classes with `foreground`, `muted-foreground`, `foreground-subtle`, `surface`, `surface-muted`, `border`;
- keep provider names, API payload keys, save/test buttons and error messages unchanged.

The following existing tests are mandatory regression gates:

```bash
pnpm exec vitest run app/settings/sections/TelegramSettingsCard.test.tsx \
  app/settings/sections/WebFetchSection.test.tsx \
  app/settings/sections/WebSearchSection.test.tsx \
  app/settings/sections/XCredentialAccountsCard.test.tsx \
  app/settings/sections/YouTubeSection.test.tsx
```

- [ ] **Step 5: Run settings tests and full suite**

Run:

```bash
pnpm exec vitest run app/settings
pnpm test
```

Expected: all settings and full tests PASS.

- [ ] **Step 6: Commit Task 6**

```bash
git add wemedia-studio/app/settings
git commit -m "feat: unify Ediora settings experience"
```

---

### Task 7: UI Policy Guard and Browser Verification

**Files:**
- Create: `wemedia-studio/lib/ui/ui-policy.test.ts`
- Create: `wemedia-studio/playwright.config.ts`
- Create: `wemedia-studio/e2e/ui-foundations.spec.ts`
- Modify: `wemedia-studio/package.json`
- Modify: `wemedia-studio/pnpm-lock.yaml`

**Interfaces:**
- Produces: migration-scope policy guard for Phase 1 files.
- Produces: browser screenshot suite for `/`, `/assets`, and `/settings`.
- Consumes: running local frontend at `http://127.0.0.1:3000`.

- [ ] **Step 1: Write the failing UI policy test**

```ts
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const MIGRATED_FILES = [
  'app/page.tsx',
  'app/assets/AssetsClient.tsx',
  'app/settings/SettingsClient.tsx',
  'components/features/Sidebar.tsx',
  'components/features/CreateTaskDialog.tsx',
  'components/features/dashboard/AlertsBar.tsx',
  'components/features/dashboard/TodayPlan.tsx',
  'components/features/dashboard/ReleasesToday.tsx',
  'components/features/dashboard/SourceStatusGrid.tsx',
]

const FORBIDDEN = [
  /window\.(prompt|confirm|alert)\s*\(/,
  /(^|[^\w.])(prompt|confirm|alert)\s*\(/m,
  /\bml-56\b/,
  /\b(min-h-screen|h-screen)\b/,
]

describe('Phase 1 UI policy', () => {
  it.each(MIGRATED_FILES)('%s follows the migrated UI contract', file => {
    const source = readFileSync(resolve(process.cwd(), file), 'utf8')
    for (const pattern of FORBIDDEN) expect(source).not.toMatch(pattern)
  })
})
```

Do not scan the whole application in Phase 1; non-migrated files are intentionally deferred.

- [ ] **Step 2: Run policy test and verify RED**

Run:

```bash
pnpm exec vitest run lib/ui/ui-policy.test.ts
```

Expected: FAIL on current repeated root layout classes or native dialogs in migrated files.

- [ ] **Step 3: Fix only policy failures in migrated Phase 1 files**

Use existing shared components. Do not broaden the cleanup to deferred pages.

- [ ] **Step 4: Install Playwright as a formal development dependency**

Run:

```bash
pnpm add -D @playwright/test
pnpm exec playwright install chromium
```

This is required because the Browser plugin is unavailable in the current environment and browser fidelity cannot be established through Vitest or build output.

- [ ] **Step 5: Add Playwright configuration and real browser tests**

`playwright.config.ts`:

```ts
import { defineConfig, devices } from '@playwright/test'

export default defineConfig({
  testDir: './e2e',
  use: {
    baseURL: 'http://127.0.0.1:3000',
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
})
```

`e2e/ui-foundations.spec.ts` must:

1. Visit `/`, `/assets`, `/settings`.
2. Capture Light and Dark screenshots at 1440×1000.
3. Repeat the three pages at 1280×800 and 1024×768.
4. Assert no horizontal document overflow.
5. Assert the page contains a single main application content region.
6. Open at least one Dialog on each applicable page and assert it is centered, visible and keyboard-closeable.
7. Verify `/assets` keeps the list/editor layout and media preview Dialog.
8. Verify settings theme selection persists across route navigation.

Store screenshots under `test-results/ui-foundations/`; do not commit generated PNG files.

- [ ] **Step 6: Run full automated verification**

Run:

```bash
pnpm test
pnpm lint
pnpm exec tsc --noEmit --incremental false
pnpm build
pnpm exec playwright test e2e/ui-foundations.spec.ts --project=chromium
```

Expected:

- Vitest: all files PASS.
- ESLint: exit 0.
- TypeScript: exit 0.
- Next build: exit 0.
- Playwright: every viewport/theme case PASS.

- [ ] **Step 7: Perform visual comparison**

Use `view_image` on:

1. The accepted “A · 智性靛蓝” concept.
2. Latest 1440×1000 Light screenshots for `/`, `/assets`, `/settings`.
3. Latest Dark screenshots for the same routes.

Inspect and record:

- primary/data/AI color separation;
- title and meta hierarchy;
- 224px app sidebar;
- stable asset 25/75 split;
- 240px settings navigation and 760px form column;
- Dialog sizing and overlay;
- no nested-scroll or overflow artifact.

Continue correcting visual mismatches until no material mismatch remains.

- [ ] **Step 8: Commit Task 7**

```bash
git add wemedia-studio/lib/ui/ui-policy.test.ts \
  wemedia-studio/playwright.config.ts \
  wemedia-studio/e2e/ui-foundations.spec.ts \
  wemedia-studio/package.json wemedia-studio/pnpm-lock.yaml
git commit -m "test: verify Ediora UI foundations"
```

---

## Phase 1 Completion Gate

Phase 1 is complete only when:

- all seven task commits exist;
- all automated verification commands pass;
- browser screenshots have been compared directly with the accepted A concept;
- dashboard, creative assets and settings retain their existing business behavior;
- no material visual mismatch remains in the three pilot pages;
- `.superpowers/brainstorm` remains untracked;
- no `docs/superpowers` files are added to Git.

After this gate, write the Phase 2 plan for creation workspaces using the Phase 1 interfaces without changing their public contracts.
