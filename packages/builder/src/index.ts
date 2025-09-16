import { ModelInput, ModelOutput } from "ozone-model"
import { Data, Effect, Either } from "effect";
import { Router } from "ozone-router";
import { TaggedError } from "effect/Data";
import { Tool } from "ozone-tool";

export enum EXECUTION_SIGNALS {
    CONTINUE = 0,
    STOP = 1,
    ERROR = 2,
    TOOL_VALIDATION_FAILED = 3,
    EVALUATION_FAILED = 4,
    UNKNOWN_ERROR = 5, // e.g developer defined
    NO_TOOL_RESPONSE = 6,
    AMBIGUOUS_TOOL_RESPONSE = 7,
    TOOL_ERROR = 8,
    AGENT_HANDOVER = 9,
    INVALID_TOOLS_SELECTED = 10
}

export type PipelineOutput<ToolOutputType = any> = {
    type: "string"
    data: string
} | {
    type: "tool_response"
    data: ToolOutputType
} | {
    type: "error"
    data: TaggedStepResult
}

interface StepResult<T = any> {
    SIGNAL: EXECUTION_SIGNALS,
    data: T,
    executor?: "Input" | "Next"
}

export class ExecutionStackError extends TaggedError("ExecutionStackError")<{stepResult: TaggedStepResult}> {}

export class TaggedStepResult extends Data.TaggedClass("StepResult")<StepResult>{
    step: number = -1;
    setStep(step: number){
        this.step = step
    }
    agent?: string
    setAgent(agent: string) {
        this.agent = agent
    }
    prevStepResult: TaggedStepResult | null = null;
    setPrevStep(step: TaggedStepResult) {
        this.prevStepResult = step
    }
}

export const createStepResult = (input: StepResult) => new TaggedStepResult(input)

type PromptLevel = `${number}`

export class Prompt {
    __tag = "Input" as const;
    instruction: string
    promptLevel: PromptLevel
    examples?: string
    tools?: Array<Tool<any>>
    prePrompt?: string

    constructor(
        instruction: string, 
        examples?: string,
        tools?: Array<Tool<any>>,
        promptLevel: PromptLevel | undefined = `1`
    ) {
        this.instruction = instruction
        this.examples = examples
        this.tools = tools
        this.promptLevel = promptLevel
    }

    serialize(input?: string) {
        const _input = input ?? this.prePrompt ?? ""
        const content =  `
            <instructions>
            ${this.instruction}
            </instructions>
            ${this.examples ? `<examples>
            ${this.examples}
            </examples>` : ""}
            <input>
            ${
            typeof _input == "object" ? JSON.stringify(_input) : _input
            }
            <input>
        `

        const model_input: ModelInput = {
            question: content,
            tools: this.tools
        }

        return model_input
    }

    async process(data: ModelOutput, agent: AgentBuilder) {
        if ((this.tools?.length ?? 0) == 0) {
            await agent.addChatHistory(data)
        } else {
            data.toolCallResults = []

            if ((data.toolResponses?.length ?? 0) == 0) {
                agent.addChatHistory(data)
            } else {
                const valid_tool_names = this.tools?.map(t => t.tool.name) ?? []
                const invalid_tools = data.toolResponses?.filter(t => !valid_tool_names.includes(t.name))

                if ((invalid_tools?.length ?? 0) > 0) {
                    return new TaggedStepResult({
                        data,
                        SIGNAL: EXECUTION_SIGNALS.INVALID_TOOLS_SELECTED,
                        executor: 'Input'
                    })
                }

                const toolAndResponse: Array<{ tool: Tool<any>, response: { name: string, args: Record<string, any>, id?: string }, data: Record<string, any> }> = []

                for (const tool of (this.tools ?? [])) {
                    const matching_response = data.toolResponses?.find(t => t.name == tool.tool.name)

                    if (!matching_response) continue;

                    const parsed = tool.parse(matching_response.args)

                    if (!parsed.success) return new TaggedStepResult({
                        data: { message: "Unable to parse response" },
                        SIGNAL: EXECUTION_SIGNALS.TOOL_VALIDATION_FAILED,
                        executor: this.__tag
                    })


                    toolAndResponse.push({
                        tool,
                        response: matching_response,
                        data: parsed.data
                    })
                }


                for (const { tool, response, data: toolData } of toolAndResponse) {

                    const tool_execution_effect = Effect.either(Effect.tryPromise({
                        try: async () => {
                            const result = await tool.run(toolData)
                            return result
                        },
                        catch(error) {
                            return new ExecutionStackError({
                                stepResult: new TaggedStepResult({
                                    data: error,
                                    SIGNAL: EXECUTION_SIGNALS.TOOL_ERROR,
                                    executor: 'Input'
                                })
                            })
                        },
                    }))


                    const result = await Effect.runPromise(tool_execution_effect)


                    Either.match(result, {
                        onLeft(left) {
                            return new TaggedStepResult({
                                data: left,
                                SIGNAL: EXECUTION_SIGNALS.ERROR,
                                executor: "Input"
                            })
                        },
                        onRight(right) {
                            data.toolCallResults?.push({
                                id: response.id ?? "_tool",
                                content: right,
                                tool: response.name
                            })
                        },
                    })

                }

                await agent.addChatHistory(data)
            }
        }
        return new TaggedStepResult({
            data,
            SIGNAL: EXECUTION_SIGNALS.CONTINUE,
            executor: this.__tag
        })
    }
}


class Next {
    __tag = "Next" as const
    handler: (input: any, artifacts: Array<TaggedStepResult>) => Effect.Effect<TaggedStepResult, ExecutionStackError>

    constructor(handler: (input: any, artifacts: Array<TaggedStepResult>) => Effect.Effect<TaggedStepResult, ExecutionStackError>) {
        this.handler = handler
    }

    run(input: any, artifacts: Array<TaggedStepResult> | undefined = []) {
        return this.handler(input, artifacts)
    }
}


export class AgentBuilder {
    private router: Router
    private executionStack: Array<Next | Prompt> = []
    private maxRetries: number = 3
    private conversationHistory: Array<ModelOutput> = []
    private useHistory: boolean = false
    private _onStepComplete: ((step: TaggedStepResult) => void) | undefined = undefined
    private stepExecutionHistory: Array<TaggedStepResult> = []
    private _name?: string
    private _description?: string
    private preDefinedTriggerPrompt?: string
    private onChatHistoryUpdateHandler?: (chat: ModelOutput, session_id?: string) => Promise<void>
    private historyLoader?: (session_id?: string) => Promise<Array<ModelOutput>>
    private sessionId?: string



    constructor(
        router: Router,
        maxRetries: number | undefined = 3,
        useHistory: boolean | undefined = false
    ) {
        this.router = router 
        this.maxRetries = maxRetries
        this.useHistory = useHistory
    }

    setSessionId(session_id: string) {
        this.sessionId = session_id
    }

    // load previous conversation history
    async init(panic?: boolean) {
        if (this.historyLoader) {
            await Effect.runPromise(
                Effect.tryPromise({
                    try: async () => {
                        const history = await this.historyLoader!(this.sessionId)
                        this.conversationHistory = history
                    },
                    catch(e) {
                        console.log("HISTORY LOAD ERROR::", e)
                        if (panic) throw new Error("Unable to load history")
                    }
                })
            )
        }
    }

    setTriggerPrompt(prompt: string) {
        this.preDefinedTriggerPrompt = prompt
    }

    name(value: string) {
        this._name = value
        return this
    }

    description(value: string) {
        this._description = value
        return this
    }

    get spec() {
        return new AgentSpec(
            this._name ?? "",
            this._description ?? '',
            this
        )
    }

    addStepToHistory(step: TaggedStepResult) {
        this.stepExecutionHistory.push(step)
        this._onStepComplete?.(step)
    }

    addInitLoader(func: (session_id?: string) => Promise<Array<ModelOutput>>) {
        this.historyLoader = func
    }

    addUpdater(func: (data: ModelOutput, session_id?: string) => Promise<void>) {
        this.onChatHistoryUpdateHandler = func
    }

    async addChatHistory(data: ModelOutput) {
        this.conversationHistory.push(data)

        if (this.onChatHistoryUpdateHandler) {
            await Effect.runPromise(Effect.tryPromise({
                try: async () => {
                    await this.onChatHistoryUpdateHandler!(data, this.sessionId)
                },
                catch(error) {
                    console.log("CHAT HISTORY UPDATE ERROR::", error)
                },
            }))
        }

    }

    get history() {
        return this.conversationHistory
    }

    clearHistory() {
        this.conversationHistory = []
    }

    onStepComplete(_onStepComplete: (result: TaggedStepResult) => void) {
        this._onStepComplete = _onStepComplete;
    }

    get stepHistory(){
        return this.stepExecutionHistory
    }

    prompt(args: {
        instruction: string, 
        examples?: string,
        tools?: Array<Tool<any>>,
        promptLevel?: PromptLevel
    }){
        this.executionStack.push(
            new Prompt(args.instruction, args.examples, args.tools, args.promptLevel)
        )
        return this
    }

    next<Input = any, Output = any>(handler: (input: Input)=>Effect.Effect<TaggedStepResult, ExecutionStackError>) {
        this.executionStack.push(
            new Next(handler) 
        )
        return this
    }

    private getNextEffect(router: Router, input: any, executor: Prompt | Next, builder: AgentBuilder, step?: number, remaining_stack_steps?: Array<(Next | Prompt)>) {
        const chatHistory = builder.useHistory == false ? [] : builder.conversationHistory

        switch (executor.__tag) {
            case "Input": {
                const model = router.route(executor.promptLevel)
                const model_input = executor.serialize(input)
                return model
                    .ask(model_input, chatHistory)
                    .pipe(
                        Effect.andThen((modelOutput) => Effect.try(() => {
                            // If there are no previous artifacts, then this is the first message and can be added as the user prompt to the artifact stack

                            // -----
                            modelOutput.role = "assistant"
                            return modelOutput
                        }))
                    )
            }
            case "Next": {
                return executor.run(input)
                    .pipe(
                        Effect.andThen((result) => Effect.try(() => {

                            return result
                        }))
                    )
            }
            default: {
                return Effect.fail(new ExecutionStackError({
                    stepResult: new TaggedStepResult({
                        data: "No Step Handler Found",
                        SIGNAL: EXECUTION_SIGNALS.ERROR
                    })
                }))
            }
        }
        
    }

    async runStack(
        prevStep: TaggedStepResult,
        stack: Array<Next | Prompt>,
        step: number | undefined = 1
    ): Promise<TaggedStepResult> {
        prevStep.setStep(step)
        prevStep.setAgent(this._name ?? "unnamed_agent")
        this.addStepToHistory(prevStep)
        if (
            prevStep.SIGNAL == EXECUTION_SIGNALS.STOP
            || prevStep.SIGNAL == EXECUTION_SIGNALS.ERROR
            || stack.length == 0
            || prevStep.SIGNAL !== EXECUTION_SIGNALS.CONTINUE
        ) {
            if (
                prevStep.SIGNAL == EXECUTION_SIGNALS.ERROR ||
                prevStep.SIGNAL == EXECUTION_SIGNALS.AMBIGUOUS_TOOL_RESPONSE ||
                prevStep.SIGNAL == EXECUTION_SIGNALS.EVALUATION_FAILED ||
                prevStep.SIGNAL == EXECUTION_SIGNALS.NO_TOOL_RESPONSE ||
                prevStep.SIGNAL == EXECUTION_SIGNALS.TOOL_ERROR ||
                prevStep.SIGNAL == EXECUTION_SIGNALS.TOOL_VALIDATION_FAILED ||
                prevStep.SIGNAL == EXECUTION_SIGNALS.INVALID_TOOLS_SELECTED
            ) {
                console.log("I'm gonna throw up 🤢🤢🤮", prevStep.SIGNAL, prevStep)
                throw new ExecutionStackError({
                    stepResult: prevStep
                })
            }
            return prevStep
        }

        const next = stack.pop()!

        const step_effect: Effect.Effect<ModelOutput | {output: ModelOutput, input: any} | TaggedStepResult, ExecutionStackError | any> = this.getNextEffect(this.router, prevStep.data, next, this, step)
        const result = await Effect.runPromise(Effect.either(
                step_effect
        ))

        const stepResult = await Either.match(result, {
            onLeft(left){
                return new TaggedStepResult({
                    data: left,
                    SIGNAL: EXECUTION_SIGNALS.ERROR,
                    executor: next.__tag
                })
            },
            onRight: async (right) => {
                if (right instanceof TaggedStepResult) {
                    return right
                }

                if (next.__tag == "Input") {
                    await next.process(right as ModelOutput, this)
                }

                return new TaggedStepResult({
                    data: right,
                    SIGNAL: EXECUTION_SIGNALS.CONTINUE,
                    executor: 'Input'
                })
            }
        })

        stepResult.setPrevStep(prevStep)

        const stackEffect = Effect.tryPromise({
            try: async () => {
                // recursion unwinds at this point
                const stackResult = await this.runStack(stepResult, stack, step + 1)
                if (stackResult?.SIGNAL == EXECUTION_SIGNALS.ERROR) {
                    throw new ExecutionStackError({
                        stepResult: stackResult
                    })
                }

                return stackResult
            },
            catch(error) {
                return error as ExecutionStackError
            },
        })

        const stackResultEither = await Effect.runPromise(
            Effect.either(
                Effect.retry(stackEffect, {
                    times: this.maxRetries
                })
            ) 
        )

        const stackResult = Either.match(stackResultEither, {
            onLeft(left) {
                return left.stepResult
            },
            onRight(right){
                return right
            }
        })

        return stackResult

        
    }

    async run(
        triggerPrompt: string
    ) {
        const lastHistoryIndex = this.conversationHistory.length;
        const reversedQueue = [...this.executionStack].reverse() // reverse order so that we can use pop when we run the stack
        // trigger history update with user's prompt
        if (this.onChatHistoryUpdateHandler) {
            await Effect.runPromise(Effect.tryPromise({
                try: async () => {
                    await this.onChatHistoryUpdateHandler!({
                        role: "user",
                        answer: triggerPrompt
                    }, this.sessionId)
                },
                catch(e) {
                    throw new Error("Failed to update history with user prompt")
                }
            }))
        }

        const initialStepResult = new TaggedStepResult({
            data: triggerPrompt ?? this.preDefinedTriggerPrompt,
            SIGNAL: EXECUTION_SIGNALS.CONTINUE
        })
        const result = await this.runStack(initialStepResult, reversedQueue, undefined)
        const split = lastHistoryIndex
        const before = this.conversationHistory.slice(0, split)
        const after = this.conversationHistory.slice(split)
        const updated = [
            ...before,
            {
                role: "user",
                answer: triggerPrompt
            } as ModelOutput,
            ...after
        ]
        this.conversationHistory = updated

        const content: Array<PipelineOutput> = []
        const data = result.data as ModelOutput
        if ((data.answer?.length ?? 0) > 0) {
            content.push({
                type: "string",
                data: data?.answer ?? ""
            })
        }

        if ((data.toolCallResults?.length ?? 0) > 0) {
            for (const response of (data.toolCallResults ?? [])) {
                content.push({
                    type: "tool_response",
                    data: response.content
                })
            }
        }

        return content
    }

}

export class AgentSpec {
    name: string
    description: string
    examples?: string
    agent: AgentBuilder

    constructor(name: string, description: string, agent: AgentBuilder, examples?: string) {
        this.name = name
        this.agent = agent
        this.description = description
        this.examples = examples
    }
}