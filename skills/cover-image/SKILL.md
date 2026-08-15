---
name: cover-image
description: "Generate elegant article cover images with 5-dimensional customization (type, palette, rendering, text, mood). Supports 11 color palettes and 7 rendering styles. Use when user asks to generate cover image, article cover, or hero image."
version: 1.0.0
---

# Cover Image Generator

Generate elegant cover images for articles with 5-dimensional customization.

## Image Generation

Use `image_generate` tool to render the final image. Write a detailed English prompt combining all chosen dimensions. The prompt is the single most important artifact — invest effort in crafting it.

## Five Dimensions

| Dimension | Values | Default |
|-----------|--------|---------|
| Type | hero, conceptual, typography, metaphor, scene, minimal | auto |
| Palette | warm, elegant, cool, dark, earth, vivid, pastel, mono, retro, duotone, macaron | auto |
| Rendering | flat-vector, hand-drawn, painterly, digital, pixel, chalk, screen-print | auto |
| Text | none, title-only, title-subtitle, text-rich | title-only |
| Mood | subtle, balanced, bold | balanced |

## Aspect Ratios

- `16:9` (default, landscape) — standard blog/social media, X/Twitter post images
- `2.35:1` (cinematic) — dramatic wide format
- `1:1` (square) — Instagram, thumbnails, X profile header
- `3:4` / `4:3` — portrait/landscape alternatives

### X/Twitter Specific

- X renders 16:9 images at 1600×900 — best quality for in-feed display
- X crops non-16:9 images in feed previews; 16:9 avoids cropping
- Text on images should be LARGE and minimal — mobile screens are small
- User's content domain: AI前沿翻译/产品实战/商业洞察 — tech + professional tone
- User style preference: 先捧后杀 narrative structure for X posts
- When generating for X posts, lean toward `cool`/`elegant`/`dark` palettes for AI content

## Workflow

1. **Analyze** — Understand the article content, tone, keywords, visual metaphors
2. **Confirm dimensions** — Ask user which type/palette/rendering/text/mood (unless specified)
3. **Craft prompt** — Build a detailed English prompt from dimensions + content analysis
4. **Generate** — Call `image_generate` with the prompt and chosen aspect ratio
5. **Verify dimensions** — Run `ffprobe` or `identify` on the output file to confirm actual pixel dimensions match the requested aspect ratio. **Do not skip this step.**
6. **Post-process if needed** — If output doesn't match requested ratio, use ffmpeg to crop/pad (see Pitfalls)
7. **Report** — Show the result with verified dimension summary. **Always deliver both** the cropped (target ratio) and uncropped (original) versions — user may want either.

## MK 的封面偏好（仅在调用方未指定风格时作为兜底；若调用方已传入 5 维或 cover_style 参数则**忽略本节**）

- **亮度**：默认用亮色/浅色背景（cool/elegant/macaron），不要默认 dark
- **直接性**：封面要能直接说明文章主题，不要太抽象。用户说"无法说明 codex mobile 的发布"，意思是要有明确的视觉指代（手机+代码元素），而非纯粹的氛围渲染
- **产品发布类**：直接画产品核心元素（手机、终端、代码界面），搭配明亮背景，避免暗黑/电影感
- **拒绝**：暗黑 moody 风格、过度抽象的隐喻、看不清主题的构图
- **接受的风格**：手绘手账/笔记本风格（hand-drawn + retro palette + notebook paper background）—— 用户明确喜欢，对技术分析类文章效果好

> 注：wms 链路里 illustrator 拿到账号 `cover_style` 时应**完全照搬**该账号的 5 维 + signature_motifs，本节不参与决策。

## Auto-Selection Rules

When user doesn't specify dimensions, select based on content signals:

### Type
- Technical/engineering article → `conceptual`
- Product launch, announcement → `hero`
- Quote, wordplay focus → `typography`
- Analogy, comparison → `metaphor`
- How-to, tutorial → `scene`
- Philosophical, minimal → `minimal`

### Palette
- AI/tech/startup → `cool` or `dark`
- Business/professional → `elegant`
- Nature/wellness → `earth`
- Education/tutorial → `macaron`
- Entertainment/gaming → `vivid` or `dark`
- Personal story/emotion → `warm`
- Creative/artistic → `pastel` or `retro`
- Zen/focus → `mono`
- Movie/dramatic → `duotone`

### Rendering
- Clean/tech UI → `flat-vector` or `digital`
- Creative/personal → `hand-drawn`
- Artistic/expressive → `painterly`
- Nostalgic/retro → `pixel`
- Educational/classroom → `chalk`
- Poster/dramatic → `screen-print`

## Prompt Structure

```
[Composition + Type] + [Subject from content] + [Palette colors] + [Rendering style] + [Text if any] + [Mood] + [Technical: no text artifacts, clean composition]
```

**Prompt template:**
```
A [type description] cover image for an article about [topic]. 
[Rendering style] illustration style. 
Color palette: [list 3-5 specific hex colors from palette]. 
[If text]: Bold title text "[title]" in [font style], [subtitle if any].
[Composition details: focal point, whitespace 40-60%, visual anchor]
[Mood: subtle gradients / balanced contrast / high contrast dramatic lighting]
No hex codes, no color names, no labels visible in the image. 
Clean, professional, high quality.
```

## Article-to-Cover Integration Methodology

When the user provides article content and wants a cover that reflects it (not just a generic mood image):

1. **Extract visual anchors** — Go through the article and identify elements that can be drawn: specific objects (kanban board, phone, brain), concepts (chaos → order, old → new), numbers (6 columns, 3 strikes), technical terms (SQLite, claim, kill(pid,0))
2. **Map to layout via narrative structure** — If the article follows a structure (痛点→揭幕→方案, before→after), mirror that in the composition. Left = problem, center = transition, right = solution is a reliable pattern.
3. **Decide density** — How many article elements to include. `text-rich` rendering can hold 5-8 scattered annotations; `title-only` keeps it to the title + 2-3 visual anchors.
4. **Layer into the chosen style** — The article elements become the SUBJECT of the prompt, not afterthoughts. Build the prompt around them.

Example: article about "kanban replacing centralized scheduling" → left side = chaotic brain (pain), center = arrow with version number (transition), right side = kanban board with robots claiming tasks (solution), scattered annotations = technical terms from the article.

## Notebook / 手账 Style Pattern

A popular style that combines hand-drawn rendering with vintage/retro aesthetics:

- **Rendering**: `hand-drawn` (pen strokes, imperfections, variable line weight)
- **Palette**: `retro` (coral, mint, mustard, cream) or `warm`
- **Background**: Aged/yellowed notebook paper with grid lines, spiral binding, coffee stains, worn edges
- **Decorative**: Fluorescent highlighter accents on key terms, scattered handwritten annotations, sticky note-style cards
- **Mood**: `bold` or `balanced`

This style works well for: analysis articles, architecture breakdowns, technical deep-dives that benefit from a "engineer's personal journal" feel.

**Prompt boilerplate for notebook style:**
```
A hand-drawn illustration on a [vintage/modern] notebook background.
Grid notebook paper with [spiral binding on the left / leather binding /
torn edges]. [Aged yellowed parchment with coffee stains / clean white
with subtle grid lines]. [Article visual anchors as described above].
Scattered hand-drawn annotations in [color] highlighter: "[term1]",
"[term2]". Feels like a [creative tech blogger's / engineer's] personal
journal page. 40% whitespace, professional yet personal.
```

---

## Reference Images

If user provides reference images:
- Analyze for specific visual elements (composition, color, style, objects)
- Incorporate extracted traits into the prompt
- Do NOT just say "like reference" — be specific about WHAT to borrow

---

## Pitfalls

### `image_generate` only supports three aspect ratios
The `image_generate` `aspect_ratio` parameter only accepts three values: `landscape` (16:9), `square` (1:1), and `portrait` (9:16). Any other value (e.g., `5:2`, `4:3`) will be silently coerced to one of these three. If the user requests a custom ratio, generate at the closest supported ratio and crop afterward.

### Provider often ignores the requested ratio anyway
The `openai-codex` provider (gpt-image-2) consistently outputs **1536×1024 (3:2)** regardless of the `aspect_ratio` parameter passed to `image_generate`. The `aspect_ratio` param is a hint, not a guarantee — the provider decides the final dimensions.

**Always verify dimensions** with `ffprobe` or `identify` after generation. The output may be 3:2 no matter what you asked for.

### Workaround: Crop to target ratio

After generation, verify with `ffprobe` or `identify`. Then crop from center:

```bash
# 16:9 from 1536×1024 (3:2) — crop height to 864
ffmpeg -y -i input.png -vf "crop=1536:864:0:(1024-864)/2" -update 1 output_16x9.png

# 5:2 from 1536×1024 — crop height to 614 (= 1536 × 2/5)
ffmpeg -y -i input.png -vf "crop=1536:614:0:(1024-614)/2" -update 1 output_5x2.png

# 1:1 from 1536×1024 — crop width to 1024 centered
ffmpeg -y -i input.png -vf "crop=1024:1024:(1536-1024)/2:0" -update 1 output_1x1.png

# 4:3 from 1536×1024 — source is wider (3:2 > 4:3), crop WIDTH to 1365
ffmpeg -y -i input.png -vf "crop=1365:1024:86:0" -update 1 output_4x3.png
```

The formula for any target ratio W:H from source W_src×H_src:
- If W_src/H_src > W/H (source wider than target): crop width to `H_src × W/H`, center
- If W_src/H_src < W/H (source taller than target): crop height to `W_src × H/W`, center

### User will notice wrong dimensions
Users expect the requested aspect ratio. Delivering a 3:2 image when 5:2 or 16:9 was requested breaks trust. Always verify and fix before reporting.

### Upload to Ediora for X post embedding
After generating and cropping, images need a public URL to embed in X posts. MK uses Ediora for this. See `references/ediora-upload.md` for the upload workflow.

---

## Palettes

### warm
Friendly, approachable, human-centered
Colors: Orange #ED8936, Golden #F6AD55, Terracotta #C05621, Cream #FFFAF0, Peach #FED7AA, Brown #744210
Decorative: Sun rays, rounded shapes, warm gradients
Best for: Personal growth, lifestyle, education, human stories

### elegant
Sophisticated, refined, understated luxury
Colors: Coral #E8A598, Teal #5B8A8A, Rose #D4A5A5, Cream #F5F0E6, Gold #C9A962, Copper #B87333
Decorative: Ornamental details, subtle gradients, geometric patterns
Best for: Business, professional, thought leadership, corporate

### cool
Technical, professional, precise
Colors: Blue #2563EB, Navy #1E3A5F, Cyan #06B6D4, Light Gray #F8F9FA, Amber #F59E0B
Decorative: Grid lines, schematics, geometric precision
Best for: Architecture, system design, API, technical documentation

### dark
Cinematic, premium, atmospheric
Colors: Purple #8B5CF6, Cyan #06B6D4, Magenta #EC4899, Deep Black #0A0A0A, Amber #F59E0B, White #FFFFFF
Decorative: Neon highlights, fog/particles, silhouettes, gradient backgrounds
Best for: Entertainment, premium brands, cinematic storytelling, gaming

### earth
Natural, organic, grounded
Colors: Forest #276749, Sage #9AE6B4, Brown #744210, Sand #F5E6D3, Orange #ED8936
Decorative: Leaves, mountains, botanical, earthy textures
Best for: Nature, wellness, eco, travel, sustainability

### vivid
Energetic, bold, attention-grabbing
Colors: Red #EF4444, Neon Green #22C55E, Electric Blue #3B82F6, Orange #FB923C, Yellow #FACC15
Decorative: Dynamic diagonals, bold shapes, dramatic lighting
Best for: Product launch, gaming, promotion, marketing

### pastel
Gentle, whimsical, soft
Colors: Pink #FFB6C1, Mint #98D8C8, Lavender #C8A2C8, White #FFFFFF, Butter #FFFACD
Decorative: Stars, sparkles, flowers, soft shadows
Best for: Fantasy, children, creative, beginner guides

### mono
Clean, focused, essential
Colors: Black #000000, Dark #1F1F1F, Gray #374151, White #FFFFFF, Medium Gray #9CA3AF
Decorative: Maximum negative space, thin lines, single focal point
Best for: Zen, focus, essential concepts, minimalist philosophy

### retro
Nostalgic, vintage, classic
Colors: Coral #E07A5F, Mint #81B29A, Mustard #F2CC8F, Maroon #5D3A3A, Cream #F5F0E6, Gold #C9A227
Decorative: Halftone dots, vintage badges, aged textures, sunbursts
Best for: History, retro, classic, retrospectives, educational

### duotone
Dramatic, cinematic, two-color high contrast
Pairs: Orange+Teal, Red+Cream, Blue+Gold, Purple+Green, Magenta+Cyan, Crimson+Navy
Decorative: Stark two-color separation, halftone transitions, silhouettes
Best for: Movie posters, album covers, dramatic announcements, cinematic

### macaron
Soft macaron pastel color blocks on warm cream
Colors: Sky #A8D8EA, Mint #B5E5CF, Lavender #D5C6E0, Cream #F5F0E8, Coral #E8655A
Decorative: Rounded pastel blocks, soft shadows, gentle gradients
Best for: Educational content, knowledge sharing, concept explainers, tutorials

---

## Renderings

### flat-vector
Clean, modern, geometric. Flat design, uniform fills, no texture. Rounded line endings, solid color blocks. Think modern app icons and infographic illustrations.

### hand-drawn
Sketchy, organic, personal. Visible imperfections, variable line weight, paper grain texture. Feels like a skilled artist's sketchbook.

### painterly
Soft, artistic, expressive. Watercolor/paint style with visible brush strokes, color bleeds. No hard outlines, edges defined by color transitions.

### digital
Polished, precise, modern. Clean digital illustration with subtle gradients, frosted glass effects, card-based layouts. Professional UI feel.

### pixel
Retro 8-bit, nostalgic. Pixel grid alignment, dithering patterns, limited palette. Chunky shapes, staircase diagonals, gaming aesthetic.

### chalk
Educational, authentic, classroom. Chalk on blackboard with imperfect strokes, dust effects. White/bright chalk on dark board surface.

### screen-print
Bold, limited-color poster art. Flat color blocks, halftone textures, print imperfections. Bold silhouettes, no outlines — shapes defined by color boundaries.

## Composition Principles

- **Whitespace**: 40-60% breathing room
- **Visual anchor**: Main element centered or offset left
- **Characters**: Simplified silhouettes; NO realistic humans
- **Title**: Use exact title from user/source; never invent
- **No artifacts**: Never render hex codes, color names, or labels as visible text
