// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { SettingsClient } from './SettingsClient'

vi.mock('./sections/AISection', () => ({ AISection: () => <div>AI settings</div> }))
vi.mock('./sections/ArxivSection', () => ({ ArxivSection: () => <div>arXiv settings</div> }))
vi.mock('./sections/BlogSection', () => ({ BlogSection: () => <div>Blog settings</div> }))
vi.mock('./sections/CollectSection', () => ({ CollectSection: () => <div>Collect settings</div> }))
vi.mock('./sections/GitHubSection', () => ({ GitHubSection: () => <div>GitHub settings</div> }))
vi.mock('./sections/HeyGenSection', () => ({ HeyGenSection: () => <div>HeyGen settings</div> }))
vi.mock('./sections/LogsSection', () => ({ LogsSection: () => <div>Logs settings</div> }))
vi.mock('./sections/PublishAccountsSection', () => ({ PublishAccountsSection: () => <div>Publish settings</div> }))
vi.mock('./sections/SpeechSection', () => ({ SpeechSection: () => <div>Speech settings</div> }))
vi.mock('./sections/TextVideoSection', () => ({ TextVideoSection: () => <div>Text video settings</div> }))
vi.mock('./sections/TranscriptionSection', () => ({ TranscriptionSection: () => <div>Transcription settings</div> }))
vi.mock('./sections/WebFetchSection', () => ({ WebFetchSection: () => <div>Web fetch settings</div> }))
vi.mock('./sections/WebSearchSection', () => ({ WebSearchSection: () => <div>Web search settings</div> }))
vi.mock('./sections/XSection', () => ({ XSection: () => <div>X settings</div> }))
vi.mock('./sections/YouTubeSection', () => ({ YouTubeSection: () => <div>YouTube settings</div> }))
vi.mock('./sections/SkillsSection', () => ({ SkillsSection: () => <div>Skills settings</div> }))
vi.mock('./sections/XiangongyunSection', () => ({ XiangongyunSection: () => <div>Xiangongyun settings</div> }))

describe('SettingsClient', () => {
  afterEach(cleanup)

  it('exposes a named settings navigation with the selected page', () => {
    render(<SettingsClient initialSettings={null} />)

    const layout = screen.getByTestId('settings-layout')
    const navigation = screen.getByRole('navigation', { name: '设置导航' })
    expect(layout).toHaveClass('h-dvh', 'min-h-0', 'overflow-hidden')
    expect(layout).not.toHaveClass('h-screen', 'min-h-screen')
    expect(navigation).toBeInTheDocument()
    expect(navigation).toHaveClass('w-60', 'overflow-y-auto')
    expect(screen.getByTestId('settings-scroll-region')).toHaveClass('overflow-y-auto')
    expect(screen.getByRole('button', { name: /AI 大模型/ })).toHaveAttribute('aria-current', 'page')
    expect(screen.getByRole('button', { name: /外观/ })).not.toHaveAttribute('aria-current')
  })

  it('opens the appearance section and renders it in the bounded content region', () => {
    render(<SettingsClient initialSettings={null} />)

    fireEvent.click(screen.getByRole('button', { name: /外观/ }))

    expect(screen.getByRole('heading', { level: 1, name: '外观与主题' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /外观/ })).toHaveAttribute('aria-current', 'page')
    expect(screen.getByTestId('settings-content')).toHaveClass('max-w-[760px]')
  })

  it('lets the logs section use the full available width', () => {
    render(<SettingsClient initialSettings={null} />)

    fireEvent.click(screen.getByRole('button', { name: /系统日志/ }))

    expect(screen.getByTestId('settings-content')).toHaveClass('w-full')
    expect(screen.getByTestId('settings-content')).not.toHaveClass('max-w-[760px]')
  })

  it('opens speech synthesis next to transcription settings', () => {
    render(<SettingsClient initialSettings={null} />)

    fireEvent.click(screen.getByRole('button', { name: /语音合成/ }))

    expect(screen.getByRole('heading', { level: 1, name: '语音合成' })).toBeInTheDocument()
    expect(screen.getByText('Speech settings')).toBeVisible()
  })

  it('opens text video template and brand settings', () => {
    render(<SettingsClient initialSettings={null} />)

    fireEvent.click(screen.getByRole('button', { name: /文字视频/ }))

    expect(screen.getByRole('heading', { level: 1, name: '文字视频' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /模板 · 品牌 · 默认视觉/ }))
      .toHaveAttribute('aria-current', 'page')
    expect(screen.getByText('Text video settings')).toBeVisible()
  })

  it('opens skill management from the settings navigation', () => {
    render(<SettingsClient initialSettings={null} />)

    fireEvent.click(screen.getByRole('button', { name: /技能管理/ }))

    expect(screen.getByRole('heading', { level: 1, name: '技能管理' })).toBeInTheDocument()
    expect(screen.getByText('Skills settings')).toBeVisible()
  })

  it('opens Xiangongyun settings from the settings navigation', () => {
    render(<SettingsClient initialSettings={null} />)

    fireEvent.click(screen.getByRole('button', { name: /仙宫云/ }))

    expect(screen.getByRole('heading', { level: 1, name: '仙宫云' })).toBeInTheDocument()
    expect(screen.getByText('Xiangongyun settings')).toBeVisible()
  })
})
