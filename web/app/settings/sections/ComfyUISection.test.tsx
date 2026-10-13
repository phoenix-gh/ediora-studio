// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { makeSettings } from '@/lib/api/settings-test-fixtures'
import {
  addComfyUIWorkflow,
  deleteComfyUIWorkflow,
  listComfyUIWorkflows,
  updateComfyUIWorkflow,
  updateSettings,
  type ComfyUIWorkflow,
} from '@/lib/api/settings'

import { ComfyUISection } from './ComfyUISection'

vi.mock('@/lib/api/settings', async importOriginal => {
  const original = await importOriginal<typeof import('@/lib/api/settings')>()
  return {
    ...original,
    testComfyUI: vi.fn(),
    updateSettings: vi.fn(),
    listComfyUIWorkflows: vi.fn(async () => ({ workflows: [] })),
    addComfyUIWorkflow: vi.fn(),
    updateComfyUIWorkflow: vi.fn(),
    deleteComfyUIWorkflow: vi.fn(),
  }
})

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}))

const workflowJson = JSON.stringify({
  '6': {
    class_type: 'CLIPTextEncode',
    inputs: { text: '原提示词', clip: ['4', 1] },
  },
  '5': {
    class_type: 'EmptyLatentImage',
    inputs: { width: 1024, height: 1024, batch_size: 1 },
  },
})

const workflowInputs = {
  prompt: '6:text',
  width: '5:width',
  height: '5:height',
}

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
    expect(await screen.findByText('还没有工作流')).toBeTruthy()
    const [runtimeProvider] = screen.getAllByRole('combobox')
    await user.click(runtimeProvider)
    await user.click(await screen.findByText('仙宫云'))
    await user.click(screen.getByRole('button', { name: '保存', exact: true }))

    await waitFor(() => expect(updateSettings).toHaveBeenCalledWith({
      comfyui_base_url: '',
      comfyui_runtime_provider: 'xiangongyun',
      comfyui_min_shot_seconds: 4,
      comfyui_max_shot_seconds: 5,
    }))
  })

  it('adds a named workflow and deletes it', async () => {
    const created: ComfyUIWorkflow = {
      id: 'wf-1',
      name: '街拍',
      type: 'text_to_image',
      workflow: JSON.parse(workflowJson) as Record<string, unknown>,
      inputs: workflowInputs,
    }
    vi.mocked(addComfyUIWorkflow).mockResolvedValue({
      workflow: created,
      workflows: [created],
    })
    vi.mocked(deleteComfyUIWorkflow).mockResolvedValue({ workflows: [] })
    render(<ComfyUISection settings={makeSettings()} onSaved={vi.fn()} />)

    const user = userEvent.setup()
    expect(await screen.findByText('还没有工作流')).toBeTruthy()
    expect(screen.queryByLabelText('工作流名字')).toBeNull()
    await user.click(screen.getByRole('button', { name: '新建工作流' }))
    expect(screen.getByRole('heading', { name: '新建工作流' })).toBeTruthy()
    await user.type(screen.getByLabelText('工作流名字'), '街拍')
    fireEvent.change(screen.getByLabelText('工作流 JSON'), {
      target: { value: workflowJson },
    })
    await user.type(screen.getByLabelText('提示词节点'), '6:text')
    await user.type(screen.getByLabelText('宽度节点'), '5:width')
    await user.type(screen.getByLabelText('高度节点'), '5:height')
    await user.click(screen.getByRole('button', { name: '添加工作流' }))

    await waitFor(() => expect(addComfyUIWorkflow).toHaveBeenCalledWith({
      name: '街拍',
      type: 'text_to_image',
      workflow: created.workflow,
      inputs: workflowInputs,
    }))
    expect(await screen.findByText(/文生图工具使用这条/)).toBeTruthy()
    expect(screen.queryByRole('dialog')).toBeNull()

    await user.click(screen.getByRole('button', { name: '删除 街拍' }))
    await waitFor(() => expect(deleteComfyUIWorkflow).toHaveBeenCalledWith('wf-1'))
    expect(await screen.findByText('还没有工作流')).toBeTruthy()
  })

  it('edits a workflow in place and can cancel', async () => {
    const created: ComfyUIWorkflow = {
      id: 'wf-1',
      name: '街拍',
      type: 'text_to_image',
      workflow: JSON.parse(workflowJson) as Record<string, unknown>,
      inputs: workflowInputs,
    }
    const editedWorkflow = {
      ...(JSON.parse(workflowJson) as Record<string, { inputs: { text: string } }>),
    }
    editedWorkflow['6'].inputs.text = '夜景提示词'
    const updated: ComfyUIWorkflow = {
      ...created,
      name: '街拍夜景',
      workflow: editedWorkflow,
    }
    vi.mocked(listComfyUIWorkflows).mockResolvedValueOnce({ workflows: [created] })
    vi.mocked(updateComfyUIWorkflow).mockResolvedValue({
      workflow: updated,
      workflows: [updated],
    })
    render(<ComfyUISection settings={makeSettings()} onSaved={vi.fn()} />)

    const user = userEvent.setup()
    expect(await screen.findByRole('button', { name: '编辑 街拍' })).toBeTruthy()
    await user.click(screen.getByRole('button', { name: '编辑 街拍' }))
    expect(screen.getByRole('heading', { name: '编辑工作流' })).toBeTruthy()
    expect(screen.getByLabelText('工作流名字')).toHaveValue('街拍')
    expect((screen.getByLabelText('工作流 JSON') as HTMLTextAreaElement).value).toContain('原提示词')

    await user.clear(screen.getByLabelText('工作流名字'))
    await user.type(screen.getByLabelText('工作流名字'), '临时名字')
    await user.click(screen.getByRole('button', { name: '取消' }))

    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.queryByLabelText('工作流名字')).toBeNull()
    expect(screen.getByRole('button', { name: '新建工作流' })).toBeTruthy()
    expect(updateComfyUIWorkflow).not.toHaveBeenCalled()

    await user.click(screen.getByRole('button', { name: '编辑 街拍' }))
    await user.clear(screen.getByLabelText('工作流名字'))
    await user.type(screen.getByLabelText('工作流名字'), '街拍夜景')
    fireEvent.change(screen.getByLabelText('工作流 JSON'), {
      target: { value: JSON.stringify(editedWorkflow) },
    })
    await user.click(screen.getByRole('button', { name: '保存修改' }))

    await waitFor(() => expect(updateComfyUIWorkflow).toHaveBeenCalledWith('wf-1', {
      name: '街拍夜景',
      type: 'text_to_image',
      workflow: editedWorkflow,
      inputs: workflowInputs,
    }))
    expect(await screen.findByText('街拍夜景')).toBeTruthy()
    expect(screen.queryByRole('button', { name: '保存修改' })).toBeNull()
  })
})
