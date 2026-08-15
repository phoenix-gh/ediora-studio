# Text Video Workbench Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the first `/text-video` milestone with a three-stage workbench, a validated reusable render contract, one versioned Remotion template, and full/selected-scene browser preview.

**Architecture:** Remotion lives inside `web/remotion` so the Next.js workbench and future renderer share one Composition implementation. Video projects are typed data fixtures in this milestone; a template registry resolves a versioned Composition and validates common plus template-specific props before `@remotion/player` receives them.

**Tech Stack:** Next.js 16.2.4, React 19.2.4, TypeScript, Zod 4.4.3, Remotion 4.0.500, `@remotion/player` 4.0.500, `@remotion/cli` 4.0.500, Vitest, Testing Library, Playwright.

## Global Constraints

- Add **文字视频** under the existing 创作 navigation at `/text-video`.
- Keep one Remotion codebase with versioned templates; never create one Remotion project per video.
- Keep `audio + segments` template-independent and isolate template settings under `templateProps`.
- Support 9:16, 16:9, and 1:1 using the same template component.
- Provide full composition preview and selected-scene preview.
- Do not implement live MiMo, voice cloning, database persistence, MP4 rendering, durable render jobs, multi-track editing, or fake success states in this milestone.
- Use Dialog components for focused settings and no side drawers.
- Preserve all unrelated staged, modified, and untracked workspace files.

---

### Task 1: Install Remotion and define the validated render contract

**Files:**
- Modify: `web/package.json`
- Modify: `web/pnpm-lock.yaml`
- Create: `web/remotion/contract.ts`
- Create: `web/remotion/contract.test.ts`
- Create: `web/lib/text-video/fixture.ts`

**Interfaces:**
- Produces `textVideoRenderInputSchema`, `TextVideoRenderInput`, `techTextV1PropsSchema`, and `TEXT_VIDEO_FIXTURE`.
- The contract uses seconds for `segments[].start/end`; the Composition converts them to frames using `composition.fps`.

- [ ] **Step 1: Add a failing contract test**

```ts
import { describe, expect, it } from 'vitest'
import { textVideoRenderInputSchema } from './contract'

const valid = {
  templateId: 'tech-text', templateVersion: 1,
  composition: { width: 1080, height: 1920, fps: 30 },
  audio: '',
  segments: [
    { id: 's1', start: 0, end: 2.4, text: '做 AI 视频的', highlight: [], animation: 'fade-up' },
    { id: 's2', start: 2.4, end: 4.2, text: '一个月没赚到钱', highlight: ['没赚到钱'], animation: 'scale' },
  ],
  templateProps: { theme: 'tech-blue', font: 'source-han-sans', background: 'dark-grid', transition: 'soft-push', textDensity: 'standard' },
}

describe('text video render contract', () => {
  it('accepts ordered non-overlapping segments', () => {
    expect(textVideoRenderInputSchema.parse(valid).segments).toHaveLength(2)
  })

  it('rejects overlapping segments', () => {
    const overlapping = { ...valid, segments: [valid.segments[0], { ...valid.segments[1], start: 2 }] }
    expect(() => textVideoRenderInputSchema.parse(overlapping)).toThrow(/overlap/i)
  })

  it('rejects an unsupported aspect ratio', () => {
    expect(() => textVideoRenderInputSchema.parse({ ...valid, composition: { width: 1000, height: 700, fps: 30 } })).toThrow(/aspect/i)
  })
})
```

- [ ] **Step 2: Run the contract test and verify the missing-module failure**

Run: `pnpm test -- remotion/contract.test.ts`

Expected: FAIL because `remotion/contract.ts` does not exist.

- [ ] **Step 3: Install exact matching Remotion packages**

Run: `pnpm add remotion@4.0.500 @remotion/player@4.0.500 && pnpm add -D @remotion/cli@4.0.500`

Expected: all three Remotion packages resolve to `4.0.500`; package and lock files change only for these dependencies.

- [ ] **Step 4: Implement the Zod contract and fixture**

```ts
import { z } from 'zod'

export const techTextV1PropsSchema = z.object({
  theme: z.literal('tech-blue'),
  font: z.literal('source-han-sans'),
  background: z.literal('dark-grid'),
  transition: z.literal('soft-push'),
  textDensity: z.enum(['compact', 'standard', 'spacious']),
})

const segmentSchema = z.object({
  id: z.string().min(1), start: z.number().min(0), end: z.number().positive(),
  text: z.string().min(1), highlight: z.array(z.string()),
  animation: z.enum(['fade-up', 'scale']),
}).refine(segment => segment.end > segment.start, 'segment end must follow start')

export const textVideoRenderInputSchema = z.object({
  templateId: z.literal('tech-text'), templateVersion: z.literal(1),
  composition: z.object({ width: z.number().int(), height: z.number().int(), fps: z.number().int().positive() })
    .refine(value => value.width === value.height
      || value.width * 16 === value.height * 9
      || value.width * 9 === value.height * 16, 'unsupported aspect ratio'),
  audio: z.string(), segments: z.array(segmentSchema).min(1),
  templateProps: techTextV1PropsSchema,
}).superRefine((value, context) => {
  for (let index = 1; index < value.segments.length; index += 1) {
    if (value.segments[index].start < value.segments[index - 1].end) {
      context.addIssue({ code: 'custom', path: ['segments', index, 'start'], message: 'segments overlap' })
    }
  }
})

export type TextVideoRenderInput = z.infer<typeof textVideoRenderInputSchema>
export type TextVideoSegment = TextVideoRenderInput['segments'][number]
```

Create `TEXT_VIDEO_FIXTURE` with eight confirmed segments for Player demonstration and `TEXT_VIDEO_INCOMPLETE_FIXTURE` with six of eight audio paragraphs confirmed for gate testing. Both use no audio URL and `tech-text-v1` defaults. Fixture controls must be clearly marked as demonstration data.

- [ ] **Step 5: Run contract tests**

Run: `pnpm test -- remotion/contract.test.ts`

Expected: contract tests pass.

- [ ] **Step 6: Commit Task 1**

```bash
git add web/package.json web/pnpm-lock.yaml web/remotion/contract.ts web/remotion/contract.test.ts web/lib/text-video/fixture.ts
git commit -m "feat: define text video render contract"
```

### Task 2: Build the template registry and `tech-text-v1` Composition

**Files:**
- Create: `web/remotion/registry.ts`
- Create: `web/remotion/registry.test.ts`
- Create: `web/remotion/shared/TimedText.tsx`
- Create: `web/remotion/templates/tech-text-v1/Composition.tsx`
- Create: `web/remotion/templates/tech-text-v1/manifest.ts`
- Create: `web/remotion/Root.tsx`
- Create: `web/remotion/index.ts`

**Interfaces:**
- Consumes `TextVideoRenderInput` and `techTextV1PropsSchema` from Task 1.
- Produces `TECH_TEXT_V1_ID = 'tech-text-v1'`, `TechTextV1Composition`, `resolveTextVideoTemplate(id)`, and a registered Remotion Composition.

- [ ] **Step 1: Write a failing registry test**

```ts
import { expect, it } from 'vitest'
import { resolveTextVideoTemplate } from './registry'

it('resolves the versioned technology text template', () => {
  expect(resolveTextVideoTemplate('tech-text-v1').id).toBe('tech-text-v1')
})

it('rejects unknown template versions', () => {
  expect(() => resolveTextVideoTemplate('tech-text-v2')).toThrow('未知文字视频模板')
})
```

- [ ] **Step 2: Run the registry test and verify the missing-module failure**

Run: `pnpm test -- remotion/registry.test.ts`

Expected: FAIL because `remotion/registry.ts` does not exist.

- [ ] **Step 3: Implement the manifest and registry**

```ts
export const techTextV1Manifest = {
  id: 'tech-text-v1', name: '科技资讯动态文字', version: 1,
  aspectRatios: ['9:16', '16:9', '1:1'] as const,
  animations: ['fade-up', 'scale'] as const,
  defaults: { theme: 'tech-blue', font: 'source-han-sans', background: 'dark-grid', transition: 'soft-push', textDensity: 'standard' },
}

const templates = new Map([[techTextV1Manifest.id, techTextV1Manifest]])
export function resolveTextVideoTemplate(id: string) {
  const template = templates.get(id)
  if (!template) throw new Error(`未知文字视频模板：${id}`)
  return template
}
```

- [ ] **Step 4: Implement timed scenes and responsive Composition**

`TechTextV1Composition` uses the global `useCurrentFrame()` value to select the segment whose `[start, end)` contains `frame / fps`. `TimedText` renders highlight phrases separately and applies frame-driven opacity/translateY for `fade-up` or scale for `scale`. Use deterministic CSS/Remotion interpolation only; do not use wall-clock timers or CSS autoplay animations.

If `audio` is non-empty, mount Remotion `<Html5Audio src={audio} />`; fixture preview remains valid without an audio source. Use width/height from `useVideoConfig()` to select portrait, landscape, or square typography and safe-area spacing.

- [ ] **Step 5: Register the Composition**

```tsx
export const RemotionRoot = () => (
  <Composition
    id="tech-text-v1"
    component={TechTextV1Composition}
    durationInFrames={126}
    fps={30}
    width={1080}
    height={1920}
    defaultProps={TEXT_VIDEO_FIXTURE.renderInput}
    calculateMetadata={({ props }) => ({
      durationInFrames: Math.ceil(Math.max(...props.segments.map(segment => segment.end)) * props.composition.fps),
      fps: props.composition.fps,
      width: props.composition.width,
      height: props.composition.height,
    })}
  />
)
```

Register `RemotionRoot` from `remotion/index.ts` using `registerRoot()`.

- [ ] **Step 6: Verify registry tests and Remotion compositions**

Run: `pnpm test -- remotion/registry.test.ts && pnpm exec remotion compositions remotion/index.ts`

Expected: registry tests pass and the CLI lists `tech-text-v1` without bundle or schema errors.

- [ ] **Step 7: Commit Task 2**

```bash
git add web/remotion
git commit -m "feat: add first Remotion text video template"
```

### Task 3: Add navigation and the three-stage workbench shell

**Files:**
- Modify: `web/components/features/Sidebar.tsx`
- Modify: `web/components/features/Sidebar.test.tsx`
- Create: `web/app/text-video/page.tsx`
- Create: `web/app/text-video/TextVideoWorkbench.tsx`
- Create: `web/app/text-video/TextVideoWorkbench.test.tsx`
- Create: `web/app/text-video/ScriptStage.tsx`
- Create: `web/app/text-video/AudioStage.tsx`
- Create: `web/app/text-video/VideoStage.tsx`

**Interfaces:**
- Consumes `TEXT_VIDEO_FIXTURE`, template manifest, and shared UI primitives.
- Produces `/text-video`, stage state `'script' | 'audio' | 'video'`, ratio selection, scene selection, and the audio-confirmation gate.

- [ ] **Step 1: Write failing navigation and workbench tests**

```tsx
it('adds text video under creation navigation', () => {
  render(<Sidebar />)
  expect(screen.getByRole('link', { name: '文字视频' })).toHaveAttribute('href', '/text-video')
})

it('shows the three-stage text video workflow', () => {
  render(<TextVideoWorkbench />)
  expect(screen.getByRole('tab', { name: '稿件与分镜' })).toBeVisible()
  expect(screen.getByRole('tab', { name: '配音制作' })).toBeVisible()
  expect(screen.getByRole('tab', { name: '视频合成' })).toBeVisible()
})

it('keeps video composition locked until every audio paragraph is confirmed', () => {
  render(<TextVideoWorkbench initialProject={TEXT_VIDEO_INCOMPLETE_FIXTURE} />)
  expect(screen.getByRole('tab', { name: '视频合成' })).toHaveAttribute('aria-disabled', 'true')
})
```

- [ ] **Step 2: Run focused tests and verify missing UI failures**

Run: `pnpm test -- components/features/Sidebar.test.tsx app/text-video/TextVideoWorkbench.test.tsx`

Expected: FAIL because the navigation entry and workbench modules do not exist.

- [ ] **Step 3: Add the sidebar entry and server page**

Add `Captions` from `lucide-react` and `{ href: '/text-video', label: '文字视频', icon: Captions }` immediately after 草稿箱. `page.tsx` renders `<TextVideoWorkbench />` and exports metadata title `文字视频`.

- [ ] **Step 4: Implement the shared workbench frame**

Build a full-height `overflow-hidden` workspace with:

- top project title, saved status, accessible stage tabs, ratio select, and template select;
- a 28% left scene/paragraph list;
- a flexible center stage surface;
- a 280px right settings surface;
- no browser prompts or drawers.

`TextVideoWorkbench` accepts an optional `initialProject` prop and defaults to the fully confirmed preview fixture. `ScriptStage` shows editable fixture script and paragraph cards. `AudioStage` shows an explicit “演示数据” badge, fixture waveform bars, per-paragraph confirmation states, and disabled “调用 MiMo 生成” controls labelled “下一阶段接入”. `VideoStage` is initially a structural preview surface consumed by Task 4.

- [ ] **Step 5: Run focused tests**

Run: `pnpm test -- components/features/Sidebar.test.tsx app/text-video/TextVideoWorkbench.test.tsx`

Expected: navigation, stage rendering, and gate tests pass.

- [ ] **Step 6: Commit Task 3**

```bash
git add web/components/features/Sidebar.tsx web/components/features/Sidebar.test.tsx web/app/text-video
git commit -m "feat: add text video workbench shell"
```

### Task 4: Embed full and selected-scene Remotion previews

**Files:**
- Modify: `web/app/text-video/TextVideoWorkbench.tsx`
- Modify: `web/app/text-video/VideoStage.tsx`
- Modify: `web/app/text-video/TextVideoWorkbench.test.tsx`
- Create: `web/app/text-video/RemotionPreview.tsx`
- Create: `web/app/text-video/scene-range.ts`
- Create: `web/app/text-video/scene-range.test.ts`

**Interfaces:**
- Consumes `TechTextV1Composition`, `TextVideoRenderInput`, and `@remotion/player`.
- Produces `segmentFrameRange(segment, fps)`, selected-scene preview, full preview, and ratio-responsive Player dimensions.

- [ ] **Step 1: Write failing frame-range tests**

```ts
import { expect, it } from 'vitest'
import { segmentFrameRange } from './scene-range'

it('converts segment seconds into an inclusive player frame range', () => {
  expect(segmentFrameRange({ start: 2.4, end: 4.2 }, 30)).toEqual({ inFrame: 72, outFrame: 125 })
})
```

- [ ] **Step 2: Run the frame-range test and verify the missing-module failure**

Run: `pnpm test -- app/text-video/scene-range.test.ts`

Expected: FAIL because `scene-range.ts` does not exist.

- [ ] **Step 3: Implement frame-range conversion**

```ts
export function segmentFrameRange(segment: Pick<TextVideoSegment, 'start' | 'end'>, fps: number) {
  return {
    inFrame: Math.floor(segment.start * fps),
    outFrame: Math.max(Math.floor(segment.start * fps), Math.ceil(segment.end * fps) - 1),
  }
}
```

- [ ] **Step 4: Embed the Player**

`RemotionPreview` renders `Player` with `component={TechTextV1Composition}`, fixture `inputProps`, calculated `durationInFrames`, selected composition width/height, `fps`, controls, and a stable aspect-ratio container. Full preview uses the complete frame range. Selected-scene preview passes `inFrame/outFrame` from `segmentFrameRange` and changes when a scene card is selected.

The bottom strip is a scene selector, not a freeform NLE timeline. Right-side controls expose only properties supported by `techTextV1Manifest`; unavailable generation buttons remain disabled.

- [ ] **Step 5: Extend component tests**

Mock `@remotion/player` with a component that records `inFrame`, `outFrame`, width, and height. Verify clicking scene 2 changes the preview range and selecting 16:9 changes dimensions to 1920×1080 without changing segment data.

- [ ] **Step 6: Run preview and full frontend tests**

Run: `pnpm test -- app/text-video && pnpm test`

Expected: focused preview tests and the complete Vitest suite pass.

- [ ] **Step 7: Commit Task 4**

```bash
git add web/app/text-video
git commit -m "feat: preview Remotion text video scenes"
```

### Task 5: Production build, Remotion validation, and rendered QA

**Files:**
- Modify only files from Tasks 1–4 if verification exposes scoped defects.
- Store screenshots outside the repository under `/tmp`.

**Interfaces:**
- Consumes the finished workbench and Composition.
- Produces verified local code and a deployable Web image; this milestone does not render MP4.

- [ ] **Step 1: Run clean automated verification**

Run: `pnpm test && pnpm build && pnpm exec remotion compositions remotion/index.ts`

Expected: all Vitest files pass, Next.js production build succeeds, and Remotion lists `tech-text-v1`.

- [ ] **Step 2: Rebuild the running Web service with the established environment**

Run: `docker compose -p main-runtime --env-file /workspace/projects/WeMediaStudio/.worktrees/main-runtime/.env -f docker-compose.yml build web && docker compose -p main-runtime --env-file /workspace/projects/WeMediaStudio/.worktrees/main-runtime/.env -f docker-compose.yml up -d --force-recreate web`

Expected: `main-runtime-web-1` is running on port 3000. No API/worker environment is changed.

- [ ] **Step 3: Run desktop Playwright QA**

Validate `http://localhost:3000/text-video` at 1440×900:

- page title and 文字视频 navigation identity;
- meaningful nonblank workbench content;
- no Next.js error overlay or relevant console errors;
- script/audio/video stage switching;
- audio gate messaging;
- full Player playback control;
- selected-scene frame-range change;
- 9:16 to 16:9 preview change.

Save `/tmp/wms-text-video-desktop.png`.

- [ ] **Step 4: Run narrow-viewport QA**

Validate the same route at 1024×768. Confirm the workbench remains usable through controlled panel scrolling without overlap, clipped primary controls, or a page-level horizontal scroll trap. Save `/tmp/wms-text-video-narrow.png`.

- [ ] **Step 5: Review the final diff and preserve unrelated changes**

Run: `git diff --check && git status --short`

Expected: no whitespace errors; only planned text-video files and commits belong to this feature. Existing Chrome-plugin deletions, creative-asset changes, X-backfill changes, local database sidecars, and unrelated untracked files remain untouched.
