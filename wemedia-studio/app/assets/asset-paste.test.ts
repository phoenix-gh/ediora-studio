// @vitest-environment jsdom

import { describe, expect, it } from 'vitest'

import {
  convertClipboardHtml,
  imageUrlFromPlainText,
  stripImageImportMarkers,
} from './asset-paste'


describe('creative asset clipboard conversion', () => {
  it('keeps supported webpage structure and removes unsafe presentation', () => {
    const result = convertClipboardHtml(`
      <style>.hidden { display: none }</style>
      <script>stealCookies()</script>
      <h1 class="hero">网页标题</h1>
      <p id="intro" style="color:red" onclick="attack()">
        正文 <strong>重点</strong> <em>强调</em> <del>旧内容</del>
        <a href="https://example.com/source">来源</a>
      </p>
      <blockquote>一段引用</blockquote>
      <ol><li>第一项</li><li>第二项</li></ol>
      <ul><li>无序项</li></ul>
      <pre><code class="language-ts">const answer = 42</code></pre>
      <hr>
      <table>
        <thead><tr><th>名称</th><th>价值</th></tr></thead>
        <tbody><tr><td>Agent</td><td>高</td></tr></tbody>
      </table>
      <iframe src="https://evil.example"></iframe>
      <form><input value="secret"><button>提交</button></form>
    `)

    expect(result.markdown).toContain('# 网页标题')
    expect(result.markdown).toContain('**重点**')
    expect(result.markdown).toContain('_强调_')
    expect(result.markdown).toContain('~旧内容~')
    expect(result.markdown).toContain('[来源](https://example.com/source)')
    expect(result.markdown).toContain('> 一段引用')
    expect(result.markdown).toContain('1.  第一项')
    expect(result.markdown).toContain('-   无序项')
    expect(result.markdown).toContain('```')
    expect(result.markdown).toContain('| 名称')
    expect(result.markdown).toContain('| Agent')
    expect(result.markdown).not.toMatch(/stealCookies|attack|display: none|iframe|secret|提交/)
    expect(result.images).toEqual([])
  })

  it('marks every HTTP image in DOM order and discards embedded data images', () => {
    const result = convertClipboardHtml(`
      <p>图集</p>
      <img src="https://img.example/one.png" alt="第一张" onerror="attack()">
      <img src="data:image/png;base64,AAAA" alt="内嵌图">
      <img src="http://img.example/two.webp?size=large" alt="第二张">
    `)

    expect(result.images.map(image => image.sourceUrl)).toEqual([
      'https://img.example/one.png',
      'http://img.example/two.webp?size=large',
    ])
    expect(new Set(result.images.map(image => image.id)).size).toBe(2)
    for (const image of result.images) {
      expect(result.markdown).toContain(`"wms-import:${image.id}"`)
    }
    expect(result.markdown).toContain('![第一张](https://img.example/one.png')
    expect(result.markdown).toContain('![第二张](http://img.example/two.webp?size=large')
    expect(result.markdown).not.toContain('data:image')
    expect(result.markdown).not.toContain('内嵌图')
  })

  it('removes only internal image state markers before persistence', () => {
    const markdown = [
      '![处理中](https://img.example/a.png "wms-import:pending-id")',
      '![失败](https://img.example/b.png "wms-import-failed:failed-id")',
      '![原始标题](https://img.example/c.png "作者图片")',
      '[普通链接](https://example.com "wms-import:not-an-image")',
    ].join('\n')

    expect(stripImageImportMarkers(markdown)).toBe([
      '![处理中](https://img.example/a.png)',
      '![失败](https://img.example/b.png)',
      '![原始标题](https://img.example/c.png "作者图片")',
      '[普通链接](https://example.com "wms-import:not-an-image")',
    ].join('\n'))
  })

  it.each([
    ['https://img.example/photo.png', 'https://img.example/photo.png'],
    ['  http://img.example/photo.jpeg?size=2  ', 'http://img.example/photo.jpeg?size=2'],
    ['https://img.example/photo.webp#large', 'https://img.example/photo.webp#large'],
    ['这是一张 https://img.example/photo.png', null],
    ['https://example.com/article', null],
    ['file:///tmp/photo.png', null],
    ['data:image/png;base64,AAAA', null],
  ])('detects plain image URLs without consuming prose: %s', (value, expected) => {
    expect(imageUrlFromPlainText(value)).toBe(expected)
  })
})

