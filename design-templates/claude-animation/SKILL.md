---
name: claude-animation
description: Make a 5-second silent hand-painted character animation video using p5.js, p5.brush and John Heibel's MIT-licensed painting/timeline toolkit. Storyboard, author a deterministic scene, and render an MP4 through Open Design.
triggers:
  - "claude animation"
  - "hand-painted animation"
  - "character animation"
  - "手绘动画"
  - "角色动画"
od:
  mode: video
  surface: video
  scenario: video
  preview:
    type: html
    entry: example.html
  design_system:
    requires: false
  example_prompt: Make a 5-second silent hand-painted video of an original rounded teal bird meeting a butterfly in a sunny garden, with a curious reaction, a happy bounce, and an iris opening and closing. Landscape 16:9.
---

# Hand-painted character animation

## Resources

- `assets/template.html`: immediately renderable 5-second scene starter.
- `references/ANIMATION_GUIDE.md`: animation principles, character and painting API.
- `references/checklist.md`: acceptance gates to check before reporting completion.
- `assets/runtime/`: pinned upstream engine. The daemon loads it automatically.

Read the adapted guide before authoring. Its standalone commands
(`npm install`, `render.mjs`, `studio.html`, `src/config.js`) describe upstream
development only. Inside OD, follow the workflow below instead.

## Attribution and characters

The painting/timeline engine is adapted from John Heibel's MIT-licensed
ClaudeAnimationBase. Read `references/UPSTREAM.md` and `licenses/README.md`
for provenance and the separate p5.js LGPL license. This is an independent
OpenDesign integration, without Anthropic affiliation or endorsement.
The default sample uses an original bird; no third-party mascot artwork,
character kit or reference sheet is bundled. Author original characters or
use user-supplied material with the necessary rights.

## Output contract

Exactly 5 seconds, 16:9, 1920×1080, 24 fps, silent MP4. The coding agent
authors the scene; the daemon supplies p5, p5.brush, the painting/timeline engine,
`PROJECT = { duration: 5, bpm: 120, offset: 0 }`, and browser capture.
Do not add audio, external scripts, npm installations, or launch Chrome.
Use flat `wash` colour and ink lines. Avoid slow watercolour `fill` shapes.

## Workflow

1. Write a concise storyboard with an event, a reaction, and an opening and
   closing transition. Keep it in the hidden composition directory.
2. Create a unique directory under `.claude-animation-cache/` within
   `$OD_PROJECT_DIR`. Copy `assets/template.html` to its `index.html`.
3. Edit only the inline scene script. It ends with `shots([[0, scene]])`.
   All frames must depend only on time; do not use accumulated simulation
   state or `Math.random()`. Keep the single `<canvas id="out">`.
4. Render through the media dispatcher:

```bash
"$OD_NODE_BIN" "$OD_BIN" media generate \
  --project "$OD_PROJECT_ID" --surface video \
  --model claude-animation-p5 --length 5 --aspect 16:9 \
  --composition-dir ".claude-animation-cache/<unique-id>" \
  --output "<semantic-name>.mp4"
```

5. If it returns a `taskId`, call `"$OD_NODE_BIN" "$OD_BIN" media wait
   <taskId>` repeatedly. Exit code 2 means still running; 0 means done.
   A failure must remain a failure. Follow the media contract's failure
   guidance; do not claim the MP4 exists until the task is done.
6. The visible MP4 uses OD's existing preview and download controls. The
   composition remains hidden and editable for a follow-up turn.

When a frame-extraction tool is available, inspect first/middle/last frames
before handing off. Do not install a separate browser just for review.

## Provenance

Based on JohnHeibel/ClaudeAnimationBase, MIT, commit
`0ac8bf2b31942376cb6b8c4074715595d512acd2`. See `LICENSE` and
`references/UPSTREAM.md`. The name describes the upstream kit; users can
use their existing Open Design coding agent without a new Claude login.
