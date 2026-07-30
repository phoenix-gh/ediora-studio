'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import {
  buildTextVideoMasterAudio,
  confirmTextVideoSpeechSegment,
  generatePendingTextVideoSpeech,
  generateTextVideoScenePlan,
  generateTextVideoSpeechSegment,
  renderTextVideoProject,
  updateTextVideoProject,
  type TextVideoProject,
} from '@/lib/api/text-videos'

import { TextVideoWorkbench } from './TextVideoWorkbench'
import type { SceneDirectionDraft } from './SceneDirectionDialog'
import { useTextVideoAutosave } from './useTextVideoAutosave'
import { useTextVideoProjectActions } from './useTextVideoProjectActions'

export function TextVideoEditorClient({
  initialProject,
}: {
  initialProject: TextVideoProject
}) {
  const [project, setProject] = useState(initialProject)
  const onRevision = useCallback((revision: number) => {
    setProject(current => ({ ...current, revision }))
  }, [])
  const autosave = useTextVideoAutosave({
    project,
    save: updateTextVideoProject,
    onRevision,
    onSavedProject: setProject,
  })
  const actions = useTextVideoProjectActions({
    project,
    autosave,
    setProject,
  })
  const autoMasterKeyRef = useRef('')

  function changeProject(nextProject: TextVideoProject) {
    autosave.markDirty(nextProject)
    setProject(nextProject)
  }

  async function applyTemplateSettings(
    templateProps: Record<string, unknown>,
  ) {
    const next = {
      ...project,
      render_input: {
        ...project.render_input,
        templateProps,
      },
    }
    autosave.markDirty(next)
    setProject(next)
    await autosave.flush()
  }

  function overwriteConflict() {
    if (autosave.conflictRevision === null) return
    setProject(current => ({ ...current, revision: autosave.conflictRevision! }))
    autosave.acceptConflictRevision(autosave.conflictRevision)
    window.setTimeout(() => {
      void autosave.flush().catch(reportError)
    }, 0)
  }

  const reportError = useCallback((error: unknown) => {
    toast.error(error instanceof Error ? error.message : '操作失败')
  }, [])

  function run(operation: Promise<void>) {
    void operation.catch(reportError)
  }

  function generatePendingSpeech() {
    run(actions.runProjectAction(
      'speech:pending',
      async saved => generatePendingTextVideoSpeech(
        saved.id,
        saved.revision,
      ),
    ))
  }

  function generateSpeechSegment(segmentId: string) {
    run(actions.runProjectAction(
      `speech:${segmentId}`,
      async saved => generateTextVideoSpeechSegment(
        saved.id,
        segmentId,
        saved.revision,
      ),
    ))
  }

  function confirmSpeechSegment(segmentId: string) {
    run(actions.runProjectAction(
      `speech:${segmentId}`,
      async saved => {
        const segment = saved.paragraphs.find(item => item.id === segmentId)
        if (!segment) throw new Error('配音段落不存在')
        const confirmed = await confirmTextVideoSpeechSegment(
          saved.id,
          segment.id,
          {
            revision: saved.revision,
            generation_revision: segment.generation_revision,
            source_hash: segment.source_hash,
          },
        )
        const speakable = confirmed.paragraphs.filter(
          item => item.text.trim(),
        )
        if (
          speakable.length === 1
          && speakable[0].status === 'confirmed'
        ) {
          return buildTextVideoMasterAudio(
            confirmed.id,
            confirmed.revision,
          )
        }
        return { jobs: [], project: confirmed }
      },
    ))
  }

  function buildMasterAudio() {
    run(actions.runProjectAction(
      'master',
      async saved => buildTextVideoMasterAudio(saved.id, saved.revision),
    ))
  }

  const speakable = project.paragraphs.filter(item => item.text.trim())
  const autoMasterKey = (
    speakable.length === 1
    && speakable[0].status === 'confirmed'
    && project.master_audio.status === 'missing'
    && project.master_audio.job_id === null
  )
    ? `${project.id}:${project.revision}:${speakable[0].source_hash}`
    : ''

  useEffect(() => {
    if (!autoMasterKey || autoMasterKeyRef.current === autoMasterKey) return
    autoMasterKeyRef.current = autoMasterKey
    void actions.runProjectAction(
      'master',
      async saved => buildTextVideoMasterAudio(saved.id, saved.revision),
    ).catch(reportError)
  }, [actions, autoMasterKey, reportError])

  function realignMasterAudio() {
    buildMasterAudio()
  }

  function generateScenePlan(input: SceneDirectionDraft) {
    const key = input.scope === 'selected'
      ? `scene:${input.selected_scene_id}`
      : 'scene:all'
    return actions.runProjectAction(
      key,
      async saved => generateTextVideoScenePlan(saved.id, {
        ...input,
        revision: saved.revision,
      }),
    )
  }

  function renderVideo() {
    run(actions.runProjectAction(
      'render:mp4',
      async saved => renderTextVideoProject(saved.id, saved.revision),
    ))
  }

  return (
    <>
      <TextVideoWorkbench
        projectDocument={project}
        saveState={autosave.saveState}
        onProjectChange={changeProject}
        onSave={() => {
          const operation = autosave.saveState === 'error'
            ? autosave.retry()
            : autosave.flush()
          void operation.catch(reportError)
        }}
        actionStates={actions.actionStates}
        onGeneratePendingSpeech={generatePendingSpeech}
        onGenerateSpeechSegment={generateSpeechSegment}
        onConfirmSpeechSegment={segment => confirmSpeechSegment(segment.id)}
        onBuildMasterAudio={buildMasterAudio}
        onRealignMasterAudio={realignMasterAudio}
        onPrepareSpeechSplit={async () => (
          await autosave.flush()
        ).project}
        onPrepareAudioStage={async () => (
          await autosave.flush()
        ).project}
        onGenerateScenePlan={generateScenePlan}
        onApplyTemplateSettings={applyTemplateSettings}
        onRenderVideo={renderVideo}
      />
      <Dialog open={autosave.saveState === 'conflict'}>
        <DialogContent showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>作品已在其他页面更新</DialogTitle>
            <DialogDescription>
              为避免静默覆盖，自动保存已暂停。可以加载数据库中的最新版本，或明确使用当前页面覆盖。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => window.location.reload()}>加载最新版本</Button>
            <Button onClick={overwriteConflict}>使用当前页面覆盖</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
