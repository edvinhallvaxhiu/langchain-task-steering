/**
 * Simple example: TaskSteeringMiddleware with a LangChain.js agent and Bedrock.
 *
 * Run:
 *   npx tsx examples/simple-agent.ts
 */

import { ChatBedrockConverse } from '@langchain/aws'
import {
  HumanMessage,
  SystemMessage,
  ToolMessage,
  type AIMessage,
  type BaseMessage,
} from '@langchain/core/messages'
import { tool } from '@langchain/core/tools'
import { z } from 'zod'

import {
  TaskSteeringMiddleware,
  TaskMiddleware,
  type Task,
  type ModelRequest,
  type ToolCallRequest,
  type ToolMessageResult,
  type CommandResult,
  type ContentBlock,
} from '../src/index.js'

// ── Tools ────────────────────────────────────────────────────

const gatherRequirements = tool(
  async ({ topic }: { topic: string }) => {
    return `Requirements for '${topic}': must be fast, secure, and scalable.`
  },
  {
    name: 'gather_requirements',
    description: 'Gather requirements for a given topic.',
    schema: z.object({
      topic: z.string().describe('The topic to gather requirements for'),
    }),
  }
)

const writeDesign = tool(
  async ({ requirements }: { requirements: string }) => {
    return `Design document created based on: ${requirements}`
  },
  {
    name: 'write_design',
    description: 'Write a design document based on requirements.',
    schema: z.object({
      requirements: z.string().describe('The requirements to base the design on'),
    }),
  }
)

const reviewDesign = tool(
  async ({ design }: { design: string }) => {
    return `Review complete. Design looks good: ${design}`
  },
  {
    name: 'review_design',
    description: 'Review a design document and provide feedback.',
    schema: z.object({
      design: z.string().describe('The design document to review'),
    }),
  }
)

// update_task_status — schema only, execution handled by middleware
const updateTaskStatusTool = tool(async () => 'handled by middleware', {
  name: 'update_task_status',
  description:
    "Transition a task to 'in_progress' or 'complete'. " +
    'Must be called ALONE — never in parallel with other tools. ' +
    'Tasks must follow the defined order.',
  schema: z.object({
    task: z.string().describe("Task name: 'requirements', 'design', or 'review'"),
    status: z.string().describe("New status: 'in_progress' or 'complete'"),
  }),
})

// Tool registry — maps name to real StructuredTool for model binding
const allTools = [gatherRequirements, writeDesign, reviewDesign, updateTaskStatusTool]
const toolMap = new Map(allTools.map((t) => [t.name, t]))

// ── Optional task middleware ─────────────────────────────────

class DesignMiddleware extends TaskMiddleware {
  validateCompletion(state: Record<string, unknown>): string | null {
    const messages = (state.messages ?? []) as BaseMessage[]
    const usedDesign = messages.some((m) => 'name' in m && (m as any).name === 'write_design')
    if (!usedDesign) {
      return 'You must call write_design before completing this task.'
    }
    return null
  }
}

// ── Tasks ────────────────────────────────────────────────────

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

// ── Build middleware + model ──────────────────────────────────

const middleware = new TaskSteeringMiddleware({ tasks })

const model = new ChatBedrockConverse({
  model: 'us.anthropic.claude-sonnet-4-6',
  region: 'us-east-1',
})

// ── Helpers ──────────────────────────────────────────────────

function isCommand(r: ToolMessageResult | CommandResult): r is CommandResult {
  return 'update' in r
}

function printMessage(msg: BaseMessage) {
  const role = msg._getType()
  const name = 'name' in msg ? (msg as any).name : undefined
  const content = msg.content
  const label = name ? `[${role} | ${name}]` : `[${role}]`

  if (typeof content === 'string') {
    if (content) console.log(`${label} ${content}`)
  } else if (Array.isArray(content)) {
    for (const block of content) {
      if (typeof block === 'object' && 'type' in block) {
        if (block.type === 'text' && (block as any).text) {
          console.log(`${label} ${(block as any).text}`)
        } else if (block.type === 'tool_use') {
          console.log(
            `${label} -> ${(block as any).name}(${JSON.stringify((block as any).input ?? {})})`
          )
        }
      }
    }
  }
}

// ── Agent loop ───────────────────────────────────────────────

async function runAgent(userMessage: string) {
  // State — mirrors Python's AgentState dict
  const state: Record<string, unknown> = {}
  const messages: BaseMessage[] = [new HumanMessage(userMessage)]
  state.messages = messages

  // Initialize task statuses
  const init = middleware.beforeAgent(state as any)
  if (init) Object.assign(state, init)

  console.log('=== Streaming Updates ===\n')
  console.log(`[human] ${userMessage}\n`)

  for (let i = 0; i < 50; i++) {
    // ── Model call (wrapped by middleware) ──────────────────
    let modifiedReq: ModelRequest | undefined
    middleware.wrapModelCall(
      {
        state,
        systemMessage: {
          content: 'You are a helpful software architect. Complete each task in order.',
        },
        tools: middleware.tools,
        override(o) {
          return {
            state,
            systemMessage: o.systemMessage ?? this.systemMessage,
            tools: o.tools ?? this.tools,
            override: this.override,
          }
        },
      },
      (req) => {
        modifiedReq = req
        return {}
      }
    )

    // Resolve scoped tools and build system prompt
    const scopedNames = new Set(modifiedReq!.tools.map((t) => t.name))
    const scopedTools = allTools.filter((t) => scopedNames.has(t.name))
    const systemText = (modifiedReq!.systemMessage.content as ContentBlock[])
      .filter((b) => b.type === 'text')
      .map((b) => b.text ?? '')
      .join('\n')

    const response = await model
      .bindTools(scopedTools)
      .invoke([new SystemMessage(systemText), ...messages])

    messages.push(response)
    printMessage(response)

    // ── Tool calls ─────────────────────────────────────────
    const toolCalls = (response as AIMessage).tool_calls ?? []

    if (toolCalls.length === 0) {
      // No tool calls — check if required tasks are incomplete
      const nudge = middleware.afterAgent(state as any)
      if (nudge) {
        const nudgeContent = (nudge.messages[0] as any).content
        messages.push(new HumanMessage(nudgeContent))
        state.nudgeCount = nudge.nudgeCount
        console.log(`[nudge] ${nudgeContent}\n`)
        continue
      }
      break
    }

    for (const tc of toolCalls) {
      const callId = tc.id ?? `call-${Date.now()}`

      if (tc.name === 'update_task_status') {
        // Route through wrapToolCall for validation + lifecycle
        const req: ToolCallRequest = {
          toolCall: {
            name: tc.name,
            args: tc.args ?? {},
            id: callId,
          },
          state,
        }

        const result = middleware.wrapToolCall(req, (r) =>
          middleware.executeTransition(
            r.toolCall.args as {
              task: string
              status: string
            },
            r.state,
            r.toolCall.id
          )
        )

        if (isCommand(result)) {
          const { messages: updateMsgs, ...rest } = result.update
          Object.assign(state, rest)
          state.messages = messages

          const toolMsgs = updateMsgs as Array<{
            content: string
            toolCallId: string
          }>
          if (toolMsgs?.[0]) {
            const toolMsg = new ToolMessage({
              content: toolMsgs[0].content,
              tool_call_id: callId,
            })
            messages.push(toolMsg)
            printMessage(toolMsg)
          }

          const statuses = state.taskStatuses as Record<string, string>
          if (statuses) {
            console.log(`  [statuses] ${JSON.stringify(statuses)}`)
          }
        } else {
          const toolMsg = new ToolMessage({
            content: (result as ToolMessageResult).content,
            tool_call_id: callId,
          })
          messages.push(toolMsg)
          printMessage(toolMsg)
        }
      } else {
        // Regular tool — invoke directly (already scoped)
        const toolObj = toolMap.get(tc.name!)
        if (toolObj) {
          const output = await toolObj.invoke(tc.args ?? {})
          const toolMsg = new ToolMessage({
            content: String(output),
            tool_call_id: callId,
            name: tc.name,
          })
          messages.push(toolMsg)
          printMessage(toolMsg)
        }
      }
    }

    console.log()
  }

  console.log('\n=== Done ===')
}

// ── Run ──────────────────────────────────────────────────────

runAgent("Let's design a login page.").catch(console.error)
