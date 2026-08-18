// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { makeSettings } from '@/lib/api/settings-test-fixtures'
import { updateSettings } from '@/lib/api/settings'

import { ComfyUISection } from './ComfyUISection'

vi.mock('@/lib/api/settings', async importOriginal => {
  const original = await importOriginal<typeof import('@/lib/api/settings')>()
  return {
    ...original,
    testComfyUI: vi.fn(),
    updateSettings: vi.fn(),
  }
})

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}))

describe('ComfyUISection', () => {
  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
  })

  it('lets the user select Xiangongyun without overwriting a masked ComfyUI token', async () => {
    const saved = makeSettings({ comfyui_runtime_provider: 'xiangongyun' })
    vi.mocked(updateSettings).mockResolvedValue(saved)
    render(
      <ComfyUISection
        settings={makeSettings({
          comfyui_auth_token_set: true,
          comfyui_auth_token_preview: '…1234',
        })}
        onSaved={vi.fn()}
      />,
    )

    const user = userEvent.setup()
    await user.click(screen.getByRole('combobox'))
    await user.click(await screen.findByText('仙宫云'))
    await user.click(screen.getByRole('button', { name: '保存' }))

    await waitFor(() => expect(updateSettings).toHaveBeenCalledWith({
      comfyui_base_url: '',
      comfyui_runtime_provider: 'xiangongyun',
      comfyui_min_shot_seconds: 4,
      comfyui_max_shot_seconds: 5,
    }))
  })
})
