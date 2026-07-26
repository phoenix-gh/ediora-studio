'use client'

import { useEffect, useState } from 'react'
import { Plus } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import {
  createTalkingVideo,
  listDigitalHumans,
  type DigitalHuman,
  type TalkingVideoProject,
} from '@/lib/api/digital-humans'

import { RoleEditorDialog } from './RoleEditorDialog'
import { RoleLibrary } from './RoleLibrary'
import { TalkingProjectList } from './TalkingProjectList'
import { TalkingVideoEditor } from './TalkingVideoEditor'


export function DigitalHumansClient({
  initialRoles,
  initialProjects,
}: {
  initialRoles: DigitalHuman[]
  initialProjects: TalkingVideoProject[]
}) {
  const [roles, setRoles] = useState(initialRoles)
  const [projects, setProjects] = useState(initialProjects)
  const [selectedProjectId, setSelectedProjectId] = useState<number | null>(
    initialProjects[0]?.id ?? null,
  )
  useEffect(() => {
    const value = Number(new URLSearchParams(window.location.search).get('project'))
    if (Number.isSafeInteger(value) && value > 0) setSelectedProjectId(value)
  }, [])
  const [roleEditorOpen, setRoleEditorOpen] = useState(false)
  const selectedProject = projects.find(project => project.id === selectedProjectId)
    ?? projects[0]

  const hasProcessing = roles.some(role => role.status === 'processing')
  useEffect(() => {
    if (!hasProcessing) return
    const timer = window.setInterval(() => {
      void listDigitalHumans().then(setRoles)
    }, 3_000)
    return () => window.clearInterval(timer)
  }, [hasProcessing])

  function updateRole(role: DigitalHuman | null) {
    if (!role) {
      void listDigitalHumans().then(setRoles)
      return
    }
    setRoles(current => {
      const exists = current.some(item => item.id === role.id)
      return exists
        ? current.map(item => item.id === role.id ? role : item)
        : [role, ...current]
    })
  }

  async function startProject(role: DigitalHuman) {
    const project = await createTalkingVideo({
      title: `${role.name} 的口播作品`,
      digital_human_id: role.id,
    })
    updateProject(project)
  }

  function selectProject(project: TalkingVideoProject) {
    setSelectedProjectId(project.id)
    window.history.pushState(null, '', `/digital-humans?project=${project.id}`)
  }

  function updateProject(project: TalkingVideoProject) {
    setProjects(current => (
      current.some(item => item.id === project.id)
        ? current.map(item => item.id === project.id ? project : item)
        : [project, ...current]
    ))
    setSelectedProjectId(project.id)
    window.history.replaceState(null, '', `/digital-humans?project=${project.id}`)
  }

  return (
    <div className="flex min-h-full flex-col gap-6 p-6">
      <header className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">数字人口播</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            管理可复用角色，并从脚本生成 HeyGen 口播视频。
          </p>
        </div>
        <Button onClick={() => setRoleEditorOpen(true)}>
          <Plus data-icon="inline-start" />
          创建数字人
        </Button>
      </header>
      <Tabs defaultValue="projects">
        <TabsList variant="line">
          <TabsTrigger value="projects">口播作品</TabsTrigger>
          <TabsTrigger value="roles">数字人角色</TabsTrigger>
        </TabsList>
        <TabsContent value="projects">
          <div className="grid gap-4 lg:grid-cols-[240px_minmax(0,1fr)]">
            <TalkingProjectList
              projects={projects}
              roles={roles}
              selectedId={selectedProject?.id ?? null}
              onSelect={selectProject}
              onCreated={updateProject}
            />
            {selectedProject ? (
              <TalkingVideoEditor
                project={selectedProject}
                roles={roles}
                onProjectChange={updateProject}
              />
            ) : (
              <div className="rounded-xl border p-8 text-center text-sm text-muted-foreground">
                新建口播作品后开始编辑脚本。
              </div>
            )}
          </div>
        </TabsContent>
        <TabsContent value="roles">
          <RoleLibrary
            roles={roles}
            onCreate={() => setRoleEditorOpen(true)}
            onChanged={updateRole}
            onStartProject={role => void startProject(role)}
          />
        </TabsContent>
      </Tabs>
      <RoleEditorDialog
        open={roleEditorOpen}
        onClose={() => setRoleEditorOpen(false)}
        onCreated={updateRole}
      />
    </div>
  )
}
