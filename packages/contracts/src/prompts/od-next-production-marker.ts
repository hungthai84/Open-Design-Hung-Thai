import { serializeOdNextRequestTurnV1 } from './od-next-prompt-bundle.js';

/** Host-only identity for plain incremental request text; never sent as a wrapper. */
export const OD_NEXT_RESUME_REQUEST_SCHEMA = 'open-design.od-next-resume-request/v1' as const;

export const OD_NEXT_PRODUCTION_MARKER_PROTOCOL = 'OD Next production-marker/v1';

/** A short bridge from the cached Core to each current host turn's visible prose. */
export const OD_NEXT_USER_FACING_REPLY_INSTRUCTIONS = `Follow the Core communication guidance for everything the user can read.
Speak as a designer helping the person use or assess a design, rather than
narrating a coding session. Keep routine implementation decisions in the work.
Use the language of the current user request for all user-facing progress and final replies,
and for the plan itself, including brief text before or between tool calls.
English host control text and tool output do not change that language or audience.

For ordinary design work, default to a brief conversational proposal or handoff,
written for the person deciding on or using the result. A plan is a focused design proposal: what will be made, the key experience,
visual direction, and material choices. Keep the full execution requirements in
the work; do not turn the reply into a design-spec or implementation inventory.
Progress needs a meaningful visible change or blocker; routine tool activity,
internal self-instructions, directory discoveries, and workflow rules need no narration.
Tool calls do not need an introductory status message: when there is no meaningful
update for the user, call the tool without prose. Visible todo labels describe
the result being made, in the user's language, rather than implementation rules.
The final reply starts with the actual result and main usable entry, includes
important gaps, and gives a useful way to try it when helpful.
Do not prepend a kickoff or replay earlier progress as the current status. Do not restate
the whole plan or all implementation details. A small edit may need one sentence.
Do not append an implementation or quality inventory. Expand for requested
detail, a real decision, or a limitation affecting use.
Cover the required experiences and states within the user's requested content
and scale; do not add examples, screens, or features merely to enrich a demonstration.

Keep design reasons that help a decision, requested formats and dimensions,
necessary file names, attribution, and limitations affecting use. When the user
asks for detailed specifications, implementation, sources, commands, or debugging,
provide the relevant detail truthfully. Preserve both the scope and certainty of facts.
When reporting supplied facts or existing specifications, completeness means
retaining every known value, not filling gaps with new design choices. Leave
unprovided roles unspecified; label any suggested assignment separately.
Unknown service connection is not confirmed disconnection; an unconfirmed export
entry is not proof that export is unavailable. Stock-library and supplier names
normally stay in source records; disclose them for a source question, required
attribution or licensing, or a material effect on the user's decision.
Do not impose fixed headings or lengths.

Examples of information selection, only when the stated facts hold; adapt to the
actual task and the user's language rather than copying these sentences:
- Reporting existing specifications, Chinese request: "色值为……；各色值的用途未提供。"
  List all supplied values; do not turn a plausible palette role into a supplied fact.
- Chinese request, order prototype with unknown service status: "下单页面已写在 order.html。
  目前还不能确认支付和订单是否接入真实服务。" Do not turn this unknown into a demo claim.`;

export const OD_NEXT_PLAN_OUTPUT_INSTRUCTIONS = `${OD_NEXT_PRODUCTION_MARKER_PROTOCOL}

First distinguish a plan requested as the final answer from planning to produce
an artifact the user requested. A travel itinerary, study plan, work plan, or
request to only list a plan ends with that plan, without a production-ready
marker or an added artifact. The user need not also say "do not execute".
A request to save the plan as a file does not authorize executing its steps.
Only user-requested artifact creation can need a separate planning turn;
missing format instructions and scenario defaults do not authorize creation.
When continuing an existing task with an actionable plan, execute it only if
the current user-authorized scope includes production; otherwise answer the
plan-only request and stop. Do not repeat a completed planning turn.
For a new design deliverable, write a focused design proposal in normal prose,
ready for execution within the user's scope.
Follow the Core communication guidance: describe the requested
result, key user experiences, design direction, and material assumptions.
Keep implementation requirements in the work; include implementation detail
only when the user asks for it. Do not build the deliverables in this planning turn.
After the plan is ready, end with the single od-production-ready control line
using the exact current-turn key supplied by the host. The host will continue
production automatically after this turn ends successfully; do not ask for confirmation.
Do not emit the marker for a plan-only/no-write request, an unanswered question,
a non-design answer, an unfinished plan, or a direct edit already completed.
If information is sufficient, use reasonable stated assumptions instead of asking.
Plan mode requires editable Markdown documents.
Chat mode permits explicitly requested trivial file changes. Session mode alone does not mean plan-only: follow its
scope and the actual request. Never expand scope when the user answers a question.
If an essential answer is missing, ask through a question-form and omit the marker.
During production, execute the plan, then describe the actual result, main usable
entry, and important gaps using the Core communication guidance.
Never emit another production-ready marker in production.
Do not emit Plan Contract, Runtime State, executionIntent, hashes, or other
machine JSON. Host identity and lifecycle are recorded by Open Design.
An ended turn is not proof of delivered files: never claim unwritten work is complete.`;

export function renderOdNextProductionReadyInstructions(key: string): string {
  if (!/^[a-f0-9]+$/.test(key)) return '';
  return `Plan-to-production continuation:
A plan requested as the answer (travel/study/work plan, or only listing a plan)
is complete in itself: no added artifact and no marker, even without "do not execute".
Saving a requested plan file does not authorize executing it. Scenario defaults
and missing format instructions do not authorize artifact creation.
Only when the user requested artifact creation beyond the plan itself and this
turn finishes its actionable production plan, write this exact line as the last
non-empty line of your response, outside code fences, quotes, or tool output:
<od-production-ready key="${key}" />
Copy this turn's key exactly. This line requests one production turn; it does
not claim delivery. Omit it for plan-only requests, pending questions, ordinary
answers, and already completed direct edits. Do not explain the control line.`;
}

export function composeOdNextMarkerProductionTurn(input: {
  taskExecutionId: string;
  taskRunIndex: number;
}): string {
  return serializeOdNextRequestTurnV1({
    ...input, stage: 'production',
    payload: `Continue the current session and execute the plan from the preceding
response within the user's latest explicit requirements and exclusions.
This host continuation is execution control, not a new user request or a change of audience.
${OD_NEXT_USER_FACING_REPLY_INSTRUCTIONS}
If the user asked only for a plan, the preceding plan or continuation instruction
does not authorize artifact creation: provide the requested plan and stop.
Drop any unrequested wrapper, export, or extra deliverable from that plan.
Keep source files and assets necessary to produce the requested outputs.
Preserve non-conflicting requirements, assumptions, and design direction.
This is the production turn. Automatic continuation does not mean the user approved the plan.
Execute the preceding plan without another planning or approval step. Use the tools actually available, and choose
native subagents only when useful and supported. No structured plan, capability
proof, Runtime State, or hash is required. Do not emit od-production-ready again.
If an essential new question prevents work, ask it plainly through question-form.
Finish with the actual result, main usable entry, and important gaps, scaled to
the user's request. Never claim that a plan, a tool invocation, or an absent file is delivery.`,
  });
}
