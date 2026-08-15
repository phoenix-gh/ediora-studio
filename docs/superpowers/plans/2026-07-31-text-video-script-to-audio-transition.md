# Text Video Script-to-Audio Transition Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enable the script-stage continuation action, save before entering the audio stage, and make the workflow banner distinguish ungenerated audio from audio awaiting confirmation.

**Architecture:** Keep TTS generation inside `AudioStage`. `ScriptStage` owns the pending/error state of the continuation click, `TextVideoWorkbench` converts a successfully saved project into the audio-stage project, and `TextVideoEditorClient` supplies the canonical autosave flush. Derive banner copy from explicit speech-status counts rather than only the confirmed count.

**Tech Stack:** Next.js 16, React 19, TypeScript, shadcn/Base UI components, Vitest, Testing Library, Playwright.

## Global Constraints

- Do not automatically start TTS from the script stage.
- Do not add a backend endpoint, database field, job type, or dependency.
- Save current edits before switching to the audio stage.
- A failed save must leave the user on the script stage and expose the error.
- Preserve the single-segment optimization: confirmed segment audio becomes master audio and only timeline preparation remains.
- Preserve all unrelated dirty working-tree changes and commit only files named by this plan.
- Validate against the live Docker development server at `http://localhost:3000`.

---

### Task 1: Truthful Audio Workflow Banner

**Files:**
- Modify: `web/app/text-video/TextVideoWorkbench.tsx`
- Test: `web/app/text-video/TextVideoWorkbench.test.tsx`

**Interfaces:**
- Consumes: `TextVideoProject['paragraphs'][number]['status']`
- Produces: `speechWorkflowBanner(project: TextVideoProject): string`

- [ ] **Step 1: Write failing banner-state tests**

Add focused cases to `TextVideoWorkbench.test.tsx`:

```tsx
it.each([
  {
    status: 'draft',
    expected: '还需生成 1 段配音，生成后请试听并确认',
  },
  {
    status: 'generating',
    expected: '正在生成 1 段配音',
  },
  {
    status: 'ready',
    expected: '还需确认 1 段配音，确认后将直接复用该段音频',
  },
] as const)('shows the truthful single-segment $status banner', ({
  status,
  expected,
}) => {
  renderWorkbench(makeTextVideoProject({
    script: '唯一段落',
    paragraphs: [makeSpeechSegment('only', '唯一段落', { status })],
  }))

  expect(screen.getByText(expected)).toBeVisible()
})

it('reports both generation and confirmation work for mixed segments', () => {
  renderWorkbench(makeTextVideoProject({
    script: '甲。乙。',
    paragraphs: [
      makeSpeechSegment('draft', '甲。', { status: 'draft' }),
      makeSpeechSegment('ready', '乙。', { status: 'ready' }),
    ],
  }))

  expect(screen.getByText('还需生成 1 段、确认 1 段配音')).toBeVisible()
})
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
cd web
npm test -- app/text-video/TextVideoWorkbench.test.tsx
```

Expected: the draft, generating, and mixed-state assertions fail because the
current banner treats every non-confirmed segment as ready for confirmation.

- [ ] **Step 3: Implement one banner derivation function**

In `TextVideoWorkbench.tsx`, add a pure function whose branches are ordered by
actionable workflow state:

```tsx
function speechWorkflowBanner(project: TextVideoProject): string {
  const speakable = project.paragraphs.filter(item => item.text.trim())
  const generationPending = speakable.filter(
    item => item.status === 'draft' || item.status === 'failed',
  ).length
  const generating = speakable.filter(
    item => item.status === 'generating',
  ).length
  const ready = speakable.filter(item => item.status === 'ready').length
  const single = speakable.length === 1

  if (generationPending > 0 && ready > 0) {
    return `还需生成 ${generationPending} 段、确认 ${ready} 段配音`
  }
  if (generationPending > 0) {
    return `还需生成 ${generationPending} 段配音，生成后请试听并确认`
  }
  if (generating > 0) return `正在生成 ${generating} 段配音`
  if (ready > 0) {
    return single
      ? '还需确认 1 段配音，确认后将直接复用该段音频'
      : `还需确认 ${ready} 段配音，确认后可生成主音频`
  }
  return single
    ? '配音已确认，正在准备成片时间轴'
    : '配音已确认，生成主音频和时间轴后可进入视频合成'
}
```

Render this value inside the existing amber workflow banner. Do not alter the
video-stage readiness predicate.

- [ ] **Step 4: Run tests and verify GREEN**

Run:

```bash
cd web
npm test -- app/text-video/TextVideoWorkbench.test.tsx
```

Expected: all `TextVideoWorkbench` tests pass.

- [ ] **Step 5: Commit only Task 1 files**

```bash
git add \
  web/app/text-video/TextVideoWorkbench.tsx \
  web/app/text-video/TextVideoWorkbench.test.tsx
git commit --only -m "fix: clarify text video speech status" -- \
  web/app/text-video/TextVideoWorkbench.tsx \
  web/app/text-video/TextVideoWorkbench.test.tsx
```

---

### Task 2: Save and Enter the Audio Stage

**Files:**
- Modify: `web/app/text-video/ScriptStage.tsx`
- Test: `web/app/text-video/ScriptStage.test.tsx`
- Modify: `web/app/text-video/TextVideoWorkbench.tsx`
- Test: `web/app/text-video/TextVideoWorkbench.test.tsx`
- Modify: `web/app/text-video/TextVideoEditorClient.tsx`
- Test: `web/app/text-video/TextVideoEditorClient.test.tsx`

**Interfaces:**
- `ScriptStage.onContinueToAudio?: () => Promise<void>`
- `TextVideoWorkbenchProps.onPrepareAudioStage?: () => Promise<TextVideoProject>`
- `TextVideoEditorClient` supplies:
  `async () => (await autosave.flush()).project`

- [ ] **Step 1: Write failing ScriptStage behavior tests**

Add to `ScriptStage.test.tsx`:

```tsx
it('enables a valid script and prevents duplicate continuation clicks', async () => {
  const user = userEvent.setup()
  let resolveContinue!: () => void
  const onContinueToAudio = vi.fn().mockReturnValue(
    new Promise<void>(resolve => {
      resolveContinue = resolve
    }),
  )
  render(
    <ScriptStage
      project={makeTextVideoProject({
        script: '段落一',
        paragraphs: [makeSpeechSegment('one', '段落一')],
      })}
      selectedSpeechSegmentId="one"
      onContinueToAudio={onContinueToAudio}
    />,
  )

  const button = screen.getByRole('button', { name: '进入配音设置' })
  expect(button).toBeEnabled()
  await user.click(button)
  expect(onContinueToAudio).toHaveBeenCalledOnce()
  expect(screen.getByRole('button', { name: '正在保存…' })).toBeDisabled()

  resolveContinue()
})

it('keeps the script stage actionable after a failed save', async () => {
  const user = userEvent.setup()
  render(
    <ScriptStage
      project={makeTextVideoProject({
        script: '段落一',
        paragraphs: [makeSpeechSegment('one', '段落一')],
      })}
      selectedSpeechSegmentId="one"
      onContinueToAudio={vi.fn().mockRejectedValue(
        new Error('保存稿件失败'),
      )}
    />,
  )

  await user.click(screen.getByRole('button', { name: '进入配音设置' }))
  expect(await screen.findByRole('alert')).toHaveTextContent('保存稿件失败')
  expect(screen.getByRole('button', { name: '进入配音设置' })).toBeEnabled()
})
```

Also assert that a whitespace-only segment leaves the action disabled.

- [ ] **Step 2: Write failing Workbench transition test**

Add to `TextVideoWorkbench.test.tsx`:

```tsx
it('enters audio only after the canonical save resolves', async () => {
  const user = userEvent.setup()
  const project = makeTextVideoProject({
    stage: 'script',
    script: '段落一',
    paragraphs: [makeSpeechSegment('one', '段落一')],
  })
  let resolveSaved!: (saved: typeof project) => void
  const onPrepareAudioStage = vi.fn().mockReturnValue(
    new Promise<typeof project>(resolve => {
      resolveSaved = resolve
    }),
  )
  renderWorkbench(project, { onPrepareAudioStage })

  await user.click(screen.getByRole('button', { name: '进入配音设置' }))
  expect(screen.getByRole('heading', { name: '编辑口播稿' })).toBeVisible()
  expect(screen.queryByText('当前段配音')).not.toBeInTheDocument()

  resolveSaved({ ...project, revision: 4 })
  expect(await screen.findByText('当前段配音')).toBeVisible()
})
```

- [ ] **Step 3: Write failing EditorClient autosave test**

Extend the mocked `TextVideoWorkbench` in
`TextVideoEditorClient.test.tsx` with a button that invokes
`onPrepareAudioStage`. Assert that it resolves from `autosave.flush()`:

```tsx
it('flushes the current draft before preparing the audio stage', async () => {
  const user = userEvent.setup()
  const project = makeTextVideoProject()
  mocks.autosave.flush.mockResolvedValue({
    project: { ...project, revision: 7 },
    dirtyVersion: 2,
  })
  render(<TextVideoEditorClient initialProject={project} />)

  await user.click(screen.getByRole('button', {
    name: '测试进入配音',
  }))

  expect(mocks.autosave.flush).toHaveBeenCalledOnce()
  expect(await screen.findByText('音频保存修订 7')).toBeVisible()
})
```

- [ ] **Step 4: Run the three test files and verify RED**

Run:

```bash
cd web
npm test -- \
  app/text-video/ScriptStage.test.tsx \
  app/text-video/TextVideoWorkbench.test.tsx \
  app/text-video/TextVideoEditorClient.test.tsx
```

Expected: tests fail because the continuation interfaces and enabled button do
not exist.

- [ ] **Step 5: Implement the ScriptStage async action**

Add state and an async handler:

```tsx
const [audioPreparing, setAudioPreparing] = useState(false)
const [audioPrepareError, setAudioPrepareError] = useState('')

async function continueToAudio() {
  if (!onContinueToAudio || audioPreparing) return
  setAudioPreparing(true)
  setAudioPrepareError('')
  try {
    await onContinueToAudio()
  } catch (error) {
    setAudioPrepareError(
      error instanceof Error ? error.message : '保存稿件失败',
    )
  } finally {
    setAudioPreparing(false)
  }
}
```

Replace the hard-disabled button with:

```tsx
{audioPrepareError ? (
  <p role="alert" className="text-sm text-destructive">
    {audioPrepareError}
  </p>
) : null}
<Button
  className="mt-5 w-full"
  disabled={
    !project.paragraphs.some(item => item.text.trim())
    || !onContinueToAudio
    || audioPreparing
  }
  onClick={() => void continueToAudio()}
>
  {audioPreparing
    ? <LoaderCircle data-icon="inline-start" className="animate-spin" />
    : <Mic2 data-icon="inline-start" />}
  {audioPreparing ? '正在保存…' : '进入配音设置'}
</Button>
```

Import `Mic2` from `lucide-react`.

- [ ] **Step 6: Wire Workbench to the canonical saved project**

Add `onPrepareAudioStage` to `TextVideoWorkbenchProps`. Pass this callback to
`ScriptStage`:

```tsx
onContinueToAudio={onPrepareAudioStage ? async () => {
  const saved = await onPrepareAudioStage()
  onProjectChange?.({
    ...saved,
    stage: 'audio',
  })
} : undefined}
```

Using the returned project is required so a same-tick transition cannot
reintroduce the pre-save revision.

- [ ] **Step 7: Wire EditorClient autosave flush**

Pass the canonical flush through `TextVideoEditorClient`:

```tsx
onPrepareAudioStage={async () => (
  await autosave.flush()
).project}
```

Do not catch here; rejection must reach `ScriptStage` so it can remain on the
script stage and display the error.

- [ ] **Step 8: Run focused tests and verify GREEN**

Run:

```bash
cd web
npm test -- \
  app/text-video/ScriptStage.test.tsx \
  app/text-video/TextVideoWorkbench.test.tsx \
  app/text-video/TextVideoEditorClient.test.tsx
```

Expected: all three files pass with no unhandled promise rejections.

- [ ] **Step 9: Run complete frontend verification**

Run:

```bash
cd web
npm test
npm run lint -- \
  app/text-video/ScriptStage.tsx \
  app/text-video/ScriptStage.test.tsx \
  app/text-video/TextVideoWorkbench.tsx \
  app/text-video/TextVideoWorkbench.test.tsx \
  app/text-video/TextVideoEditorClient.tsx \
  app/text-video/TextVideoEditorClient.test.tsx
npm run build
```

Expected: all tests pass, lint has no new errors, and the production build
succeeds.

- [ ] **Step 10: Verify the live development flow**

With the existing Docker development server:

```text
http://localhost:3000/text-video/2
```

Verify with Playwright:

1. `进入配音设置` is enabled for the non-empty segment.
2. Clicking it shows `正在保存…` while the PATCH is pending.
3. After the save succeeds, `生成当前段` and
   `生成全部未生成段落` are visible and enabled.
4. The workflow banner says `还需生成 1 段配音，生成后请试听并确认`.
5. No browser console or page errors occur.

- [ ] **Step 11: Commit only Task 2 files**

```bash
git add \
  web/app/text-video/ScriptStage.tsx \
  web/app/text-video/ScriptStage.test.tsx \
  web/app/text-video/TextVideoWorkbench.tsx \
  web/app/text-video/TextVideoWorkbench.test.tsx \
  web/app/text-video/TextVideoEditorClient.tsx \
  web/app/text-video/TextVideoEditorClient.test.tsx
git commit --only -m "fix: enable text video audio transition" -- \
  web/app/text-video/ScriptStage.tsx \
  web/app/text-video/ScriptStage.test.tsx \
  web/app/text-video/TextVideoWorkbench.tsx \
  web/app/text-video/TextVideoWorkbench.test.tsx \
  web/app/text-video/TextVideoEditorClient.tsx \
  web/app/text-video/TextVideoEditorClient.test.tsx
