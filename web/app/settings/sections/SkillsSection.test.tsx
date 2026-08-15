// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { SkillsSection } from './SkillsSection'

const { fetchSkills, updateSkillEnabled, uploadSkillArchive, deleteSkill } = vi.hoisted(() => ({
  fetchSkills: vi.fn(),
  updateSkillEnabled: vi.fn(),
  uploadSkillArchive: vi.fn(),
  deleteSkill: vi.fn(),
}))

vi.mock('@/lib/api/skills', () => ({
  fetchSkills,
  updateSkillEnabled,
  uploadSkillArchive,
  deleteSkill,
}))

const bundled = { name: 'Alpha', description: 'Bundled Alpha', version: '1.0.0', source: 'builtin' as const, enabled: true }
const uploaded = { name: 'Custom', description: 'Uploaded Custom', version: '2.0.0', source: 'uploaded' as const, enabled: true }

describe('SkillsSection', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    fetchSkills.mockResolvedValue([bundled, uploaded])
    updateSkillEnabled.mockImplementation(async (name: string, enabled: boolean) => ({ ...(name === 'Custom' ? uploaded : bundled), name, enabled }))
    uploadSkillArchive.mockResolvedValue([uploaded])
    deleteSkill.mockResolvedValue(undefined)
  })

  it('shows source labels, switches, and only offers deletion for uploaded Skills', async () => {
    render(<SkillsSection />)

    expect(await screen.findByText('Alpha')).toBeInTheDocument()
    expect(screen.getByText('预制')).toBeInTheDocument()
    expect(screen.getByText('已上传')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '删除 Alpha' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: '删除 Custom' })).toBeInTheDocument()

    fireEvent.click(screen.getByRole('switch', { name: '启用 Custom' }))
    await waitFor(() => expect(updateSkillEnabled).toHaveBeenCalledWith('Custom', false))
  })

  it('uploads a ZIP and refreshes, then confirms uploaded deletion', async () => {
    render(<SkillsSection />)
    await screen.findByText('Custom')

    const input = screen.getByLabelText('上传 Skill ZIP') as HTMLInputElement
    const file = new File(['zip bytes'], 'custom.zip', { type: 'application/zip' })
    fireEvent.change(input, { target: { files: [file] } })
    await waitFor(() => expect(uploadSkillArchive).toHaveBeenCalledWith(file))
    await waitFor(() => expect(fetchSkills).toHaveBeenCalledTimes(2))

    vi.spyOn(window, 'confirm').mockReturnValue(true)
    fireEvent.click(screen.getByRole('button', { name: '删除 Custom' }))
    await waitFor(() => expect(deleteSkill).toHaveBeenCalledWith('Custom'))
  })
})
