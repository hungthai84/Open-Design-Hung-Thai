/** Host contract shared by legacy, BYOK, and OD Next composition. */
export function claudeAnimationPrompt(metadata?: { videoModel?: string | null | undefined }, sessionMode?: string): string {
  if (metadata?.videoModel !== 'claude-animation-p5' || sessionMode === 'chat') return '';
  return `

## Hand-painted Animation — agent-authored, daemon-rendered
This local renderer produces exactly 5 seconds of silent 16:9 video at 1920×1080 and 24 fps.
For execution turns, read the claude-animation template and its ANIMATION_GUIDE.md. Write a short storyboard, then copy assets/template.html to a hidden project directory such as .claude-animation-cache/<id>/index.html and edit its inline scene code. index.html is a fixed composition entry, not a user-facing HTML deliverable.
The daemon injects pinned p5, p5.brush, the painting/timeline engine, and PROJECT={duration:5,bpm:120,offset:0}. Do not add CDN scripts, npm installs, Chrome launches, audio, or a HyperFrames composition. Prefer flat wash fills to slow watercolour fills.
Render through "$OD_NODE_BIN" "$OD_BIN" media generate --project "$OD_PROJECT_ID" --surface video --model claude-animation-p5 --length 5 --aspect 16:9 --composition-dir <project-relative-directory> --output <semantic-name>.mp4. Follow the normal media wait loop until the task is done. Only the final MP4 belongs in the visible project files. Never claim success for a failed or unfinished task.
Plan mode still produces only the storyboard; render on an execution turn.
`;
}
