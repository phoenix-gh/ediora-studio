// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
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

const bundled = {
  name: 'alpha', description: 'Bundled alpha', version: '1.0.0', digest: 'a'.repeat(64),
  source: 'builtin' as const, enabled: true, reviewState: 'approved' as const,
  standardCompatible: true, diagnostics: [],
}
const uploaded = {
  name: 'custom', description: 'Uploaded custom', version: '2.0.0', digest: 'b'.repeat(64),
  source: 'uploaded' as const, enabled: false, reviewState: 'pending' as const,
  standardCompatible: true, diagnostics: [],
}

describe('SkillsSection', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    fetchSkills.mockResolvedValue([bundled, uploaded])
    updateSkillEnabled.mockImplementation(async (name: string, enabled: boolean) => ({
      ...(name === 'custom' ? uploaded : bundled),
      name,
      enabled,
      reviewState: enabled ? 'approved' : 'pending',
    }))
    uploadSkillArchive.mockResolvedValue([uploaded])
    deleteSkill.mockResolvedValue(undefined)
  })

  it('shows source labels, switches, and only offers deletion for uploaded Skills', async () => {
    render(<SkillsSection />)

    expect(await screen.findByText('alpha')).toBeInTheDocument()
    expect(screen.getByText('内置')).toBeInTheDocument()
    expect(screen.getByText('已上传')).toBeInTheDocument()
    expect(screen.getByText('待审核')).toBeVisible()
    expect(screen.getByRole('switch', { name: '启用 custom' })).not.toBeChecked()
    expect(screen.queryByRole('button', { name: '删除 alpha' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: '删除 custom' })).toBeInTheDocument()

    fireEvent.click(screen.getByRole('switch', { name: '启用 custom' }))
    await waitFor(() => expect(updateSkillEnabled).toHaveBeenCalledWith('custom', true))
    expect(await within(screen.getByTestId('skill-card-custom')).findByText('已审核')).toBeVisible()
  })

  it('uploads a ZIP and refreshes, then confirms uploaded deletion', async () => {
    render(<SkillsSection />)
    await screen.findByText('custom')

    const input = screen.getByLabelText('上传 Skill ZIP') as HTMLInputElement
    const file = new File(['zip bytes'], 'custom.zip', { type: 'application/zip' })
    fireEvent.change(input, { target: { files: [file] } })
    await waitFor(() => expect(uploadSkillArchive).toHaveBeenCalledWith(file))
    await waitFor(() => expect(fetchSkills).toHaveBeenCalledTimes(2))
    expect(within(screen.getByTestId('skill-card-custom')).getByText('待审核')).toBeVisible()
    expect(screen.getByText('上传成功：Skill 需要审核并启用后才能使用。')).toBeVisible()

    vi.spyOn(window, 'confirm').mockReturnValue(true)
    fireEvent.click(screen.getByRole('button', { name: '删除 custom' }))
    await waitFor(() => expect(deleteSkill).toHaveBeenCalledWith('custom'))
  })
})
