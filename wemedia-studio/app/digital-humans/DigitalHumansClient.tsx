'use client'

import { useEffect, useState } from 'react'
import { Plus } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import {
  createTalkingVideo,
  listDigitalHumans,
  type DigitalHuman,
} from '@/lib/api/digital-humans'

import { RoleEditorDialog } from './RoleEditorDialog'
import { RoleLibrary } from './RoleLibrary'


export function DigitalHumansClient({
  initialRoles,
}: {
  initialRoles: DigitalHuman[]
}) {
  const [roles, setRoles] = useState(initialRoles)
  const [roleEditorOpen, setRoleEditorOpen] = useState(false)

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
    window.location.assign(`/digital-humans?project=${project.id}`)
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
          <div className="rounded-xl border p-8 text-center text-sm text-muted-foreground">
            口播作品编辑器将在此显示。
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
