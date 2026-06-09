# Article-to-Cover Integration: Tested Prompts

Real prompts that worked in production. Use as starting points for similar article types.

## Example 1: Technical Architecture Article (手账 style)

**Article**: Multi-agent kanban scheduling (痛点→揭幕→方案结构)
**Dimensions**: scene × retro × hand-drawn × text-rich × bold
**Ratio**: 4:3 (cropped from 3:2 source)

```
A hand-drawn illustration on a vintage retro aged notebook background.
The notebook has yellowed cream parchment pages with subtle coffee ring
stains, worn leather binding edges visible on the left side, and faint
ruled lines. Slightly crumpled paper texture with age spots.

LEFT SIDE - "The Old Way": A large hand-drawn brain icon circled in
faded coral red with a bold X cross over it. From the brain, messy
arrows point outward to scattered task cards flying in all directions,
overlapping and chaotic. Small overwhelmed robot figures being squeezed
together inside a small box. Handwritten annotation in warm coral
highlighter: "调度逻辑嵌在推理链路里". Pen strokes are rough, organic,
imperfect like fountain pen on old paper.

CENTER: A bold hand-drawn arrow pointing left to right, with the text
"v0.12.0" written above it in mustard gold ink.

RIGHT SIDE - "The New Way": A clean kanban board drawn as a grid table
on the aged paper with six columns: Triage, Todo, Ready, In Progress,
Blocked, Done. Small task cards in muted vintage colors (mustard yellow,
sage mint, dusty coral) placed in different columns showing flow. Two
small robot figures autonomously reaching for and grabbing cards from
the Ready column. One robot carries a card away. Annotation in sage
green ink: "Agent自主claim". Below the board, a small fallen robot
with an arrow showing its task card flowing back to the Ready column.
Annotation: "崩溃恢复".

TITLE at the top in bold handwritten calligraphy style: "调度，不该在
脑子里" with the characters "不该" circled in teal blue ink for emphasis.

Scattered hand-drawn annotations throughout in vintage ink colors
(coral, teal, mustard gold): "SQLite看板", "原子事务", "九种协作模式",
"3次熔断", "kill(pid,0)".

Overall vintage aesthetic: aged paper texture, muted warm tones
(coral #E07A5F, mint #81B29A, mustard #F2CC8F, maroon #5D3A3A,
cream #F5F0E6, gold #C9A227), fountain pen strokes, ink splatter
details. Feels like a vintage engineer's personal journal page
analyzing system architecture. 40% whitespace, professional yet
personal. No hex codes or color names visible in the image.
```

## Example 2: Digital-style Conceptual Cover (cool palette)

**Article**: Same kanban article, cleaner version
**Dimensions**: conceptual × cool × digital × title-only × balanced
**Ratio**: 16:9

```
A conceptual cover image for an article about multi-agent collaboration
and kanban-based autonomous task scheduling in AI systems. Digital
illustration style with clean tech UI aesthetics. Color palette:
Blue #2563EB, Navy #1E3A5F, Cyan #06B6D4, Light Gray #F8F9FA,
Amber #F59E0B. Bold title text "调度，不该在脑子里" in clean modern
sans-serif font, large and centered in the upper portion of the image.
Visual composition: a glowing kanban board with six columns showing
colorful task cards flowing from left to right — representing Triage
to Done workflow. Small stylized robot agent icons autonomously
reaching for and claiming cards from the board, one carrying a card
away. The kanban board is the luminous focal point, radiating subtle
cyan glow as the central source of truth. On the far left, a faded
translucent brain silhouette is crossed out with a thin line,
symbolizing the old centralized scheduling approach being replaced.
Clean balanced composition with 40-50% whitespace, professional and
modern tech aesthetic. No hex codes, no color names, no labels visible
in the image. No realistic humans. Clean, professional, high quality.
```

## Notes

- gpt-image-2 consistently outputs 1536×1024 (3:2) regardless of aspect_ratio param
- Chinese text in prompts renders as handwritten characters — works well for 手账 style
- For 4:3: crop width to 1365 (not height to 1152, which exceeds source height)
- Always verify with ffprobe before delivering
