/**
 * Runnable demo: simulates a full agent loop through the middleware.
 *
 * Run with:
 *   npx tsx examples/demo.ts
 */

import {
  TaskSteeringMiddleware,
  TaskMiddleware,
  TaskStatus,
  getContentBlocks,
  type Task,
  type ToolLike,
  type ModelRequest,
  type ToolCallRequest,
  type ToolMessageResult,
  type CommandResult,
  type ContentBlock,
} from '../src/index.js'

// ── Helpers ─────────────────────────────────────────────────

const BLUE = '\x1b[34m'
const GREEN = '\x1b[32m'
const RED = '\x1b[31m'
const YELLOW = '\x1b[33m'
const DIM = '\x1b[2m'
const RESET = '\x1b[0m'

function log(prefix: string, color: string, msg: string) {
  console.log(`  ${color}${prefix}${RESET} ${msg}`)
}

function header(title: string) {
  console.log(`\n${'='.repeat(60)}`)
  console.log(`  ${title}`)
  console.log('='.repeat(60))
}

function isCommand(r: ToolMessageResult | CommandResult): r is CommandResult {
  return 'update' in r
}

/** Simulate a model request to see what prompt/tools the model would receive. */
function mockModelRequest(state: Record<string, unknown>, tools: ToolLike[]): ModelRequest {
  return {
    state,
    systemMessage: { content: 'You are a helpful project manager.' },
    tools,
    override(overrides) {
      return {
        state,
        systemMessage: overrides.systemMessage ?? this.systemMessage,
        tools: overrides.tools ?? this.tools,
        override: this.override,
      }
    },
  }
}

// ── Tools ───────────────────────────────────────────────────

const gatherRequirements: ToolLike = {
  name: 'gather_requirements',
  description: 'Gather requirements for a topic.',
}
const writeDesign: ToolLike = {
  name: 'write_design',
  description: 'Write a design document.',
}
const reviewDesign: ToolLike = {
  name: 'review_design',
  description: 'Review a design document.',
}
const globalSearch: ToolLike = {
  name: 'search_docs',
  description: 'Search documentation (available in all tasks).',
}

// ── Task middleware with validation ─────────────────────────

class DesignMiddleware extends TaskMiddleware {
  validateCompletion(state: Record<string, unknown>): string | null {
    const designWritten = state.designWritten as boolean | undefined
    if (!designWritten) {
      return 'You must call write_design before completing this task.'
    }
    return null
  }

  onStart(_state: Record<string, unknown>): void {
    log('LIFECYCLE', YELLOW, 'DesignMiddleware.onStart() fired')
  }

  onComplete(_state: Record<string, unknown>): void {
    log('LIFECYCLE', YELLOW, 'DesignMiddleware.onComplete() fired')
  }
}

// ── Build the middleware ────────────────────────────────────

const tasks: Task[] = [
  {
    name: 'requirements',
    instruction: 'Gather the requirements for a login page.',
    tools: [gatherRequirements],
  },
  {
    name: 'design',
    instruction: 'Write a design document based on the gathered requirements.',
    tools: [writeDesign],
    middleware: new DesignMiddleware(),
  },
  {
    name: 'review',
    instruction: 'Review the design document and provide final feedback.',
    tools: [reviewDesign],
  },
]

const mw = new TaskSteeringMiddleware({
  tasks,
  globalTools: [globalSearch],
})

console.log(`\n${GREEN}langchain-task-steering TypeScript Demo${RESET}`)
console.log(`${DIM}Simulating an agent loop through all middleware hooks${RESET}\n`)

console.log('Registered tools:', mw.tools.map((t) => t.name).join(', '))

// ── State ───────────────────────────────────────────────────

const state: Record<string, unknown> = { messages: [] }

// ════════════════════════════════════════════════════════════
// Step 1: beforeAgent — initialize state
// ════════════════════════════════════════════════════════════

header('Step 1: beforeAgent — initialize state')

const init = mw.beforeAgent(state as any)
if (init) {
  Object.assign(state, init)
  log('STATE', BLUE, `taskStatuses = ${JSON.stringify(state.taskStatuses)}`)
}

// ════════════════════════════════════════════════════════════
// Step 2: wrapModelCall — see what model receives (no active task)
// ════════════════════════════════════════════════════════════

header('Step 2: wrapModelCall — no active task yet')

let captured: ModelRequest | null = null
mw.wrapModelCall(mockModelRequest(state, mw.tools), (r) => {
  captured = r
  return {}
})

const visibleTools = captured!.tools.map((t) => t.name)
log('TOOLS', BLUE, `Model sees: ${visibleTools.join(', ')}`)

const promptText = (captured!.systemMessage.content as ContentBlock[])
  .filter((b) => b.type === 'text')
  .map((b) => b.text)
  .join('\n')
log('PROMPT', DIM, 'System prompt includes:')
console.log(
  promptText
    .split('\n')
    .map((l) => `    ${DIM}${l}${RESET}`)
    .join('\n')
)

// ════════════════════════════════════════════════════════════
// Step 3: Start "requirements" task
// ════════════════════════════════════════════════════════════

header('Step 3: Transition "requirements" to in_progress')

let result = mw.executeTransition({ task: 'requirements', status: 'in_progress' }, state, 'call-1')
if (isCommand(result)) {
  Object.assign(state, result.update)
  log('OK', GREEN, `requirements -> in_progress`)
  log('STATE', BLUE, `taskStatuses = ${JSON.stringify(state.taskStatuses)}`)
} else {
  log('ERROR', RED, result.content)
}

// ════════════════════════════════════════════════════════════
// Step 4: wrapModelCall — now "requirements" is active
// ════════════════════════════════════════════════════════════

header('Step 4: wrapModelCall — "requirements" is active')

captured = null
mw.wrapModelCall(mockModelRequest(state, mw.tools), (r) => {
  captured = r
  return {}
})
log('TOOLS', BLUE, `Model sees: ${captured!.tools.map((t) => t.name).join(', ')}`)

// ════════════════════════════════════════════════════════════
// Step 5: Try to use a tool from another task (should be rejected)
// ════════════════════════════════════════════════════════════

header('Step 5: Try to call write_design (wrong task — should be rejected)')

const badToolReq: ToolCallRequest = {
  toolCall: { name: 'write_design', args: {}, id: 'call-2' },
  state,
}
const badResult = mw.wrapToolCall(badToolReq, () => ({
  content: 'should not reach',
  toolCallId: 'call-2',
}))
if (!isCommand(badResult)) {
  log('REJECTED', RED, badResult.content)
}

// ════════════════════════════════════════════════════════════
// Step 6: Try to skip ahead (should be rejected)
// ════════════════════════════════════════════════════════════

header('Step 6: Try to start design before completing requirements')

result = mw.executeTransition({ task: 'design', status: 'in_progress' }, state, 'call-3')
if (!isCommand(result)) {
  log('REJECTED', RED, result.content)
}

// ════════════════════════════════════════════════════════════
// Step 7: Complete "requirements", start "design"
// ════════════════════════════════════════════════════════════

header('Step 7: Complete "requirements"')

result = mw.executeTransition({ task: 'requirements', status: 'complete' }, state, 'call-4')
if (isCommand(result)) {
  Object.assign(state, result.update)
  log('OK', GREEN, 'requirements -> complete')
}

header('Step 8: Start "design" (lifecycle hooks fire)')

// Use wrapToolCall so lifecycle hooks fire
const startDesignReq: ToolCallRequest = {
  toolCall: {
    name: 'update_task_status',
    args: { task: 'design', status: 'in_progress' },
    id: 'call-5',
  },
  state,
}
result = mw.wrapToolCall(startDesignReq, (req) =>
  mw.executeTransition(
    req.toolCall.args as { task: string; status: string },
    req.state,
    req.toolCall.id
  )
)
if (isCommand(result)) {
  Object.assign(state, result.update)
  log('OK', GREEN, 'design -> in_progress')
  log('STATE', BLUE, `taskStatuses = ${JSON.stringify(state.taskStatuses)}`)
}

// ════════════════════════════════════════════════════════════
// Step 9: Try to complete "design" without writing (validation rejects)
// ════════════════════════════════════════════════════════════

header('Step 9: Try to complete "design" (validation should reject)')

const completeDesignReq: ToolCallRequest = {
  toolCall: {
    name: 'update_task_status',
    args: { task: 'design', status: 'complete' },
    id: 'call-6',
  },
  state,
}
result = mw.wrapToolCall(completeDesignReq, (req) =>
  mw.executeTransition(
    req.toolCall.args as { task: string; status: string },
    req.state,
    req.toolCall.id
  )
)
if (!isCommand(result)) {
  log('REJECTED', RED, result.content)
}

// ════════════════════════════════════════════════════════════
// Step 10: Fix state and complete "design"
// ════════════════════════════════════════════════════════════

header('Step 10: Set designWritten=true, then complete "design"')

state.designWritten = true
log('STATE', BLUE, 'Set designWritten = true')

const completeDesignReq2: ToolCallRequest = {
  toolCall: {
    name: 'update_task_status',
    args: { task: 'design', status: 'complete' },
    id: 'call-7',
  },
  state,
}
result = mw.wrapToolCall(completeDesignReq2, (req) =>
  mw.executeTransition(
    req.toolCall.args as { task: string; status: string },
    req.state,
    req.toolCall.id
  )
)
if (isCommand(result)) {
  Object.assign(state, result.update)
  log('OK', GREEN, 'design -> complete')
}

// ════════════════════════════════════════════════════════════
// Step 11: Complete "review"
// ════════════════════════════════════════════════════════════

header('Step 11: Start and complete "review"')

result = mw.executeTransition({ task: 'review', status: 'in_progress' }, state, 'call-8')
if (isCommand(result)) {
  Object.assign(state, result.update)
  log('OK', GREEN, 'review -> in_progress')
}

result = mw.executeTransition({ task: 'review', status: 'complete' }, state, 'call-9')
if (isCommand(result)) {
  Object.assign(state, result.update)
  log('OK', GREEN, 'review -> complete')
}

log('STATE', BLUE, `taskStatuses = ${JSON.stringify(state.taskStatuses)}`)

// ════════════════════════════════════════════════════════════
// Step 12: afterAgent — all tasks complete, no nudge needed
// ════════════════════════════════════════════════════════════

header('Step 12: afterAgent — check if agent can exit')

const nudge = mw.afterAgent(state as any)
if (nudge === null) {
  log('OK', GREEN, 'All required tasks complete — agent can exit.')
} else {
  log('NUDGE', YELLOW, JSON.stringify(nudge))
}

// ════════════════════════════════════════════════════════════
// Bonus: Show afterAgent nudging with incomplete tasks
// ════════════════════════════════════════════════════════════

header('Bonus: afterAgent nudge with incomplete tasks')

const incompleteState = {
  messages: [],
  taskStatuses: {
    requirements: 'complete',
    design: 'in_progress',
    review: 'pending',
  },
}
const nudgeResult = mw.afterAgent(incompleteState)
if (nudgeResult) {
  log('NUDGE', YELLOW, `jumpTo: ${nudgeResult.jumpTo}`)
  log('NUDGE', YELLOW, `nudgeCount: ${nudgeResult.nudgeCount}`)
  log('NUDGE', YELLOW, `message: ${(nudgeResult.messages[0] as any).content}`)
}

console.log(`\n${GREEN}Demo complete!${RESET}\n`)
