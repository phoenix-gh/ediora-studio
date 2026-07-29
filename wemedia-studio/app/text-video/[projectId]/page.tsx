import { notFound } from 'next/navigation'

import {
  getTextVideoProject,
  TextVideoApiError,
} from '@/lib/api/text-videos'

import { TextVideoEditorClient } from '../TextVideoEditorClient'

export const dynamic = 'force-dynamic'

export default async function TextVideoEditorPage({
  params,
}: {
  params: Promise<{ projectId: string }>
}) {
  const { projectId } = await params
  const id = Number(projectId)
  if (!Number.isSafeInteger(id) || id <= 0) notFound()

  let project
  try {
    project = await getTextVideoProject(id)
  } catch (error) {
    if (error instanceof TextVideoApiError && error.status === 404) notFound()
    throw error
  }
  return <TextVideoEditorClient initialProject={project} />
}
