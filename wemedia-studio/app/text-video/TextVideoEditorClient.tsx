'use client'

import { useCallback, useState } from 'react'

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
  updateTextVideoProject,
  type TextVideoProject,
} from '@/lib/api/text-videos'

import { TextVideoWorkbench } from './TextVideoWorkbench'
import { useTextVideoAutosave } from './useTextVideoAutosave'

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

  function changeProject(nextProject: TextVideoProject) {
    setProject(nextProject)
    autosave.markDirty()
  }

  function overwriteConflict() {
    if (autosave.conflictRevision === null) return
    setProject(current => ({ ...current, revision: autosave.conflictRevision! }))
    autosave.acceptConflictRevision(autosave.conflictRevision)
    window.setTimeout(() => {
      void autosave.saveNow()
    }, 0)
  }

  return (
    <>
      <TextVideoWorkbench
        projectDocument={project}
        saveState={autosave.saveState}
        onProjectChange={changeProject}
        onSave={() => void (autosave.saveState === 'error' ? autosave.retry() : autosave.saveNow())}
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
