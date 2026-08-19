// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  bootXiangongyunInstance,
  getXiangongyunInstance,
  listXiangongyunInstances,
  shutdownXiangongyunInstance,
  updateSettings,
} from '@/lib/api/settings'
import { makeSettings } from '@/lib/api/settings-test-fixtures'

import { XiangongyunSection } from './XiangongyunSection'

vi.mock('@/lib/api/settings', async importOriginal => {
  const original = await importOriginal<typeof import('@/lib/api/settings')>()
  return {
    ...original,
    bootXiangongyunInstance: vi.fn(),
    getXiangongyunInstance: vi.fn(),
    listXiangongyunInstances: vi.fn(),
    shutdownXiangongyunInstance: vi.fn(),
    updateSettings: vi.fn(),
  }
})

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}))

const instances = {
  list: [{
    id: 'instance-1',
    name: 'ComfyUI GPU',
    gpu_model: 'RTX 4090',
    gpu_used: 1,
    status: 'running',
    progress: 100,
  }],
  total: 1,
}

describe('XiangongyunSection', () => {
  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
  })

  it('loads the instance list and exposes manual lifecycle controls', async () => {
    vi.mocked(listXiangongyunInstances).mockResolvedValue(instances)
    vi.mocked(getXiangongyunInstance).mockResolvedValue(instances.list[0])
    vi.mocked(bootXiangongyunInstance).mockResolvedValue({ code: 0, success: true })
    vi.mocked(shutdownXiangongyunInstance).mockResolvedValue({ code: 0, success: true })
    vi.mocked(updateSettings).mockResolvedValue(makeSettings())

    render(
      <XiangongyunSection
        settings={makeSettings({
          comfyui_runtime_provider: 'xiangongyun',
          xiangongyun_base_url: 'https://api.xiangongyun.com',
          xiangongyun_api_token_set: true,
          xiangongyun_api_token_preview: '…oken',
          xiangongyun_default_instance_id: 'instance-1',
        })}
        onSaved={vi.fn()}
      />,
    )

    await waitFor(() => expect(listXiangongyunInstances).toHaveBeenCalledTimes(1))
    expect(screen.getByText('RTX 4090')).toBeVisible()
    expect(screen.getByText('running')).toBeVisible()

    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: '开机' }))
    await waitFor(() => expect(bootXiangongyunInstance).toHaveBeenCalledWith('instance-1'))
    await waitFor(() => expect(screen.getByRole('button', { name: '关机' })).toBeEnabled())
    await user.click(screen.getByRole('button', { name: '关机' }))

    await waitFor(() => {
      expect(shutdownXiangongyunInstance).toHaveBeenCalledWith('instance-1')
    })
  })

  it('does not send the stored token when the replacement field is blank', async () => {
    vi.mocked(listXiangongyunInstances).mockResolvedValue(instances)
    vi.mocked(getXiangongyunInstance).mockResolvedValue(instances.list[0])
    vi.mocked(updateSettings).mockResolvedValue(makeSettings())

    render(
      <XiangongyunSection
        settings={makeSettings({
          xiangongyun_api_token_set: true,
          xiangongyun_api_token_preview: '…oken',
          xiangongyun_default_instance_id: 'instance-1',
        })}
        onSaved={vi.fn()}
      />,
    )

    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: '保存仙宫云配置' }))

    await waitFor(() => expect(updateSettings).toHaveBeenCalledWith({
      xiangongyun_base_url: 'https://api.xiangongyun.com',
      xiangongyun_default_instance_id: 'instance-1',
    }))
  })

  it('places the save action after the default instance selector', async () => {
    vi.mocked(listXiangongyunInstances).mockResolvedValue({ list: [], total: 0 })

    render(
      <XiangongyunSection
        settings={makeSettings()}
        onSaved={vi.fn()}
      />,
    )

    await waitFor(() => expect(listXiangongyunInstances).toHaveBeenCalledTimes(1))

    const defaultInstance = screen.getByRole('combobox', { name: '默认实例' })
    const saveButton = screen.getByRole('button', { name: '保存仙宫云配置' })

    expect(
      defaultInstance.compareDocumentPosition(saveButton)
      & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy()
  })
})
