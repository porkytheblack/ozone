import { z } from "zod";
import { ModelInput, ModelOutput } from "ozone-model"
import zodToJsonSchema from "zod-to-json-schema";
import { Data, Effect, Either } from "effect";
import { Router } from "ozone-router";
import { TaggedError } from "effect/Data";

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
    AGENT_HANDOVER = 9
}


interface StepResult<T = any> {
    SIGNAL: EXECUTION_SIGNALS,
    data: T,
    executor?: "Input" | "Next" | "Evaluator" | "StepGenerator"
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

type Tool<T = any> = {
    name: string,
    description: string,
    schema: z.ZodTypeAny,
    args: Record<string, any>,
    handle: (args: T) => Promise<any>
}

type PromptLevel = `${number}`

export class Prompt {
    __tag = "Input" as const;
    instruction: string
    promptLevel: PromptLevel
    examples?: string
    tools?: Array<Tool>
    prePrompt?: string

    constructor(
        instruction: string, 
        examples?: string,
        tools?: Array<Tool>,
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
}

const reasonSchema = z.object({
    reason: z.string()
})
class Evaluator {
    __tag = "Evaluator" as const
    promptLevel?: `${number}`
    validationRequirement: string
    examples?: string

    constructor (validationRequirement: string, examples?: string, promptLevel: `${number}` | undefined = `1`) {
        this.validationRequirement = validationRequirement
        this.examples = examples
        this.promptLevel = promptLevel
    }

    serialize(_input: ModelOutput) {
        const input = _input.answer ?? {}
        const content = `
            <instructions>
            ${this.validationRequirement}
            </instructions>
            ${this.examples ? `<examples>
                ${this.examples}
                </examples>` : ""}
            <input>
            ${
                typeof input == "object" ? JSON.stringify(input) : input
            }
            </input>
        `

        const model_input: ModelInput = {
            question: content,
            tools: [
                {
                    name: "isCorrect",
                    description: "Marks the input as correct and provides a reason for correctness",
                    args: zodToJsonSchema(reasonSchema)
                },
                {
                    name: "isWrong",
                    description: "Marks the input as wrong and provides a reason for wrongness",
                    args: zodToJsonSchema(reasonSchema)
                },
                // { // TODO: I guess we could just have a prompt to request this from the user before any serious processing begins
                //     name: "isQuestion",
                //     description: "Marks the input as a question that needs to be answered by the user, and provides a reason why",
                //     args: zodToJsonSchema(reasonSchema)
                // }
            ],
        }

        return model_input
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

const generatedStep = z.object({
    agentName: z.string(),
    agentInstruction: z.string()
})

const runSteps = z.object({
    steps: z.array(generatedStep)
})

// returns additional stuff to add to the execution stack
class StepGenerator {
    __tag = "StepGenerator" as const
    private instruction: string
    promptLevel: PromptLevel
    private examples?: string
    agents: Array<AgentSpec>

    constructor(
        instruction: string,
        agents: Array<AgentSpec>,
        examples?: string,
        promptLevel: PromptLevel | undefined = `1`
    ) {
        this.instruction = instruction
        this.examples = examples
        this.agents = agents
        this.promptLevel = promptLevel
    }

    serialize(input: string) {



        const content = `
            <instructions>
            ${this.instruction}
            </instructions>

            <agents>
            ${this.agents?.map((agent) => {
            return (
                `
                                <agent>
                                    NAME: ${agent.name}
                                    DESCRIPTION: ${agent.description}
                                </agent>
                                `
            )
        })
            }
            </agents>

            ${this.examples ? `<examples>
            ${this.examples}
            </examples>` : ""}
            <input>
            ${typeof input == "object" ? JSON.stringify(input) : input}
            <input>
        `

        const model_input: ModelInput = {
            question: content,
            tools: [
                {
                    args: zodToJsonSchema(runSteps),
                    description: "Provide a sequential list of steps that need to be followed in order to complete a task or an inquiry or solve a problem.",
                    name: "runSteps"
                }
            ]
        }

        return model_input
    }
}

export class AgentBuilder<TOutput = any>{
    private router: Router
    private executionStack: Array<Next | Prompt | Evaluator | StepGenerator> = []
    private maxRetries: number = 3
    private conversationHistory: Array<ModelOutput> = []
    private useHistory: boolean = false
    private _onStepComplete: ((step: TaggedStepResult) => void) | undefined = undefined
    private stepExecutionHistory: Array<TaggedStepResult> = []
    private _name?: string
    private _description?: string
    private preDefinedTriggerPrompt?: string




    constructor(
        router: Router,
        maxRetries: number | undefined = 3,
        useHistory: boolean | undefined = false,
    ) {
        this.router = router 
        this.maxRetries = maxRetries
        this.useHistory = useHistory
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

    onStepComplete(_onStepComplete: (result: TaggedStepResult) => void) {
        this._onStepComplete = _onStepComplete;
    }

    get stepHistory(){
        return this.stepExecutionHistory
    }

    prompt(args: {
        instruction: string, 
        examples?: string,
        tools?: Array<Tool>,
        promptLevel?: PromptLevel
    }){
        this.executionStack.push(
            new Prompt(args.instruction, args.examples, args.tools, args.promptLevel)
        )
        return this
    }

    evaluate(args: {
        validationRequirement: string, 
        examples?: string, 
        promptLevel: PromptLevel | undefined 
    }){
        this.executionStack.push(
            new Evaluator(args.validationRequirement, args.examples, args.promptLevel)
        )
        return this
    }

    next<Input = any, Output = any>(handler: (input: Input)=>Effect.Effect<TaggedStepResult, ExecutionStackError>) {
        this.executionStack.push(
            new Next(handler) 
        )
        return this
    }

    stepGenerator(args: {
        instruction: string,
        agents: Array<AgentSpec>,
        examples?: string,
        promptLevel?: PromptLevel
    }) {
        const generator = new StepGenerator(
            args.instruction,
            args.agents,
            args.examples,
            args.promptLevel
        )
        this.executionStack.push(generator)
        return this
    }

    private getNextEffect(router: Router, input: any, executor: Prompt | Next | Evaluator | StepGenerator, builder: AgentBuilder, step?: number) {
        const chatHistory = builder.useHistory == false ? [] : builder.conversationHistory

        switch(executor.__tag){
            case "Evaluator": {
                const model = router.route(executor.promptLevel ?? `1`)
                const model_input = executor.serialize(input)
                return model.ask(model_input, chatHistory).pipe(
                    Effect.andThen((modelOutput) => Effect.try(() => {
                        modelOutput.role = "assistant"
                        return modelOutput
                    })),
                    Effect.andThen((modelOutput)=> Effect.try(()=>{
                        return {
                            output: modelOutput,
                            input
                        }
                    }))
                )
            }
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
            case "StepGenerator": {
                console.log("generator Input::", input)
                const model = router.route(executor.promptLevel)
                const model_input = executor.serialize(input)

                return model.ask(model_input, chatHistory).pipe(
                    Effect.andThen((modelOutput) => Effect.try(() => {
                        modelOutput.role = "assistant"
                        return modelOutput
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

    async runStack(prevStep: TaggedStepResult, stack: Array<Next | Prompt | Evaluator | StepGenerator>, step: number | undefined = 1): Promise<TaggedStepResult> {
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
                prevStep.SIGNAL == EXECUTION_SIGNALS.TOOL_VALIDATION_FAILED
            ) {
                console.log("I'm gonna throw up 🤢🤢🤮")
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

                if (next.__tag == "StepGenerator") {
                    const toolResponse = (right as ModelOutput)?.toolResponses?.at(0)

                    if (!toolResponse || toolResponse.name !== "runSteps") {
                        return new TaggedStepResult({
                            data: right,
                            SIGNAL: EXECUTION_SIGNALS.NO_TOOL_RESPONSE,
                            executor: "StepGenerator"
                        })
                    }

                    const argsValidation = runSteps.safeParse(toolResponse.args)

                    if (!argsValidation.success) {
                        return new TaggedStepResult({
                            data: {
                                toolResponse,
                                error: argsValidation.error.flatten().fieldErrors
                            },
                            SIGNAL: EXECUTION_SIGNALS.TOOL_VALIDATION_FAILED,
                            executor: 'StepGenerator'
                        })
                    }

                    const chosenSteps = argsValidation.data;

                    const n = next as StepGenerator;

                    const agents = chosenSteps.steps.map((step) => {
                        const spec = n.agents.find((agent) => step.agentName == agent.name)
                        if (!spec) return undefined;
                        return {
                            spec,
                            step
                        }
                    })?.filter(a => a !== undefined)

                    const newExecutionStack = agents.reverse().map((agent_spec) => {
                        const agent = agent_spec.spec.agent;
                        const currentExecutionStack = agent.executionStack;
                        (currentExecutionStack.at(0) as Prompt).prePrompt = agent_spec.step.agentInstruction;
                        console.log("Instruction::", agent_spec.step.agentInstruction)
                        return currentExecutionStack.reverse()
                    }).flat()

                    stack = stack.concat(newExecutionStack)

                    return new TaggedStepResult({
                        SIGNAL: EXECUTION_SIGNALS.CONTINUE,
                        data: undefined,
                        executor: "StepGenerator"
                    })

                }

                // in this case we know we're either dealing with an evaluator or a prompt, so we can handle validation of the output here in case it's a prompt using tools or an evaluation result and
                if (next.__tag == "Evaluator") { // handle evaluator
                    var temp = right as { output: ModelOutput, input: string };
                    const validationResponse = temp.output.toolResponses?.at(0)
                    if (!validationResponse) {
                        return new TaggedStepResult({
                            data: temp,
                            SIGNAL: EXECUTION_SIGNALS.ERROR,
                            executor: 'Evaluator'
                        })
                    }

                    if (validationResponse.name == "isCorrect") {
                        return new TaggedStepResult({
                            data: temp.input,
                            SIGNAL: EXECUTION_SIGNALS.CONTINUE,
                            executor: 'Evaluator'
                        })
                    }

                    if (validationResponse.name == "isWrong") {
                        return new TaggedStepResult({
                            data: temp,
                            SIGNAL: EXECUTION_SIGNALS.EVALUATION_FAILED,
                            executor: 'Evaluator'
                        })
                    }

                    return new TaggedStepResult({
                        data: temp,
                        SIGNAL: EXECUTION_SIGNALS.ERROR,
                        executor: 'Evaluator'
                    })
                }

                if (next.__tag == "Input" && (next.tools?.length ?? 0) > 0) { // handle tool responses
                    // cut down on ambiguity single tool responses only //maybe error out if ambiguity is detected
                    const toolResponse = (right as ModelOutput)?.toolResponses?.at(0)
                    if (!toolResponse) {

                        return new TaggedStepResult({
                            data: right,
                            SIGNAL: EXECUTION_SIGNALS.NO_TOOL_RESPONSE,
                            executor: 'Input'
                        })
                    }

                    const tool = next.tools?.find((_t) => _t.name == toolResponse?.name)

                    this.conversationHistory.push(right as ModelOutput)

                    if (!tool) {
                        return new TaggedStepResult({
                            data: right,
                            SIGNAL: EXECUTION_SIGNALS.NO_TOOL_RESPONSE,
                            executor: 'Input'
                        })
                    }

                    const argsValidation = tool.schema.safeParse(toolResponse.args)

                    if (!argsValidation.success) {
                        return new TaggedStepResult({
                            data: {
                                toolResponse,
                                error: argsValidation.error.flatten().fieldErrors
                            },
                            SIGNAL: EXECUTION_SIGNALS.TOOL_VALIDATION_FAILED,
                            executor: 'Input'
                        })
                    }

                    const toolData = argsValidation.data;

                    const tool_execution_effect = Effect.either(Effect.tryPromise({
                        try: async () => {
                            const result = await tool.handle(toolData)
                            if (result instanceof TaggedStepResult) {
                                return result
                            }
                            return new TaggedStepResult({
                                data: result,
                                SIGNAL: EXECUTION_SIGNALS.CONTINUE,
                                executor: 'Input'
                            })
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

                    const either_result = Either.match(result, {
                        onLeft(left) {
                            return new TaggedStepResult({
                                data: left,
                                SIGNAL: EXECUTION_SIGNALS.ERROR,
                                executor: "Input"
                            })
                        },
                        onRight(right) {
                            return right
                        },
                    })

                    return either_result
                }

                if (next.__tag == "Input") {
                    this.conversationHistory.push(right as ModelOutput)
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

    async run(triggerPrompt?: string) {
        const reversedQueue = this.executionStack.reverse() // reverse order so that we can use pop when we run the stack
        const initialStepResult = new TaggedStepResult({
            data: triggerPrompt ?? this.preDefinedTriggerPrompt,
            SIGNAL: EXECUTION_SIGNALS.CONTINUE
        })
        return await this.runStack(initialStepResult, reversedQueue)
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