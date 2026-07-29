'use client'

import { useCallback, useState } from 'react'
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
  generateTextVideoSpeechSegment,
  updateTextVideoProject,
  type TextVideoProject,
} from '@/lib/api/text-videos'

import { TextVideoWorkbench } from './TextVideoWorkbench'
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
  })
  const actions = useTextVideoProjectActions({
    project,
    autosave,
    setProject,
  })

  function changeProject(nextProject: TextVideoProject) {
    setProject(nextProject)
    autosave.markDirty()
  }

  function overwriteConflict() {
    if (autosave.conflictRevision === null) return
    setProject(current => ({ ...current, revision: autosave.conflictRevision! }))
    autosave.acceptConflictRevision(autosave.conflictRevision)
    window.setTimeout(() => {
      void autosave.flush().catch(reportError)
    }, 0)
  }

  function reportError(error: unknown) {
    toast.error(error instanceof Error ? error.message : '操作失败')
  }

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

  function realignMasterAudio(jobId: number) {
    run(actions.retryProjectJob(
      'master',
      jobId,
      'align_master_timeline',
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
