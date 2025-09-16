import { z } from "zod"
import { Router } from "ozone-router"
import { AgentRouter } from "ozone-agent-router"
import { AgentBuilder, PipelineOutput, TaggedStepResult } from "ozone-builder"
import { randomBytes } from "crypto"
import { Tool } from "ozone-tool"


const planIntentExecution = z.object({
    steps: z.array(
        z.object({
            agent: z.string(),
            name: z.string(),
            description: z.string(),
            completion_criteria: z.string(),
            stepIndex: z.number()
        })
    ) 
})

const beginStep = z.object({
    stepPrompt: z.string()
})

const beginStepTool = Tool.create({
    name: "begin_step",
    description: "Create an appropriate prompt for the next step in the execution flow, using details from the previous step to provide additional context",
    schema: beginStep,
    handle: async (data) => {
        return data
    }
})

const summarizeOnCompletion = z.object({
    summary: z.string()
})

const summarizeTool = Tool.create({
    name: "summarize",
    description: "Summarize the exection flow",
    schema: summarizeOnCompletion,
    handle: async (data) => {
        return data
    },
})


class PlannedStep {
    __tag = "PlannedStep"
    agent: string
    name: string
    description: string
    completion_criteria: string
    stepIndex: number
    id: string = ''
    status: 'pending' | 'completed' | 'failed' = 'pending'
    results: TaggedStepResult | undefined


    constructor(args: {name: string, description: string, completion_criteria: string, agent: string, stepIndex: number}){
        this.name = args.name
        this.description = args.description
        this.completion_criteria = args.completion_criteria
        this.agent = args.agent
        this.id = randomBytes(16).toString('hex')
        this.stepIndex = args.stepIndex
    }
    
    async process(agent: AgentBuilder, prompt: string){
        agent.clearHistory()
        const response = await agent.run(prompt)
        return response
    }


    setStatus(new_status: 'pending' | 'completed' | 'failed'){
        this.status = new_status
    }

    setResult(taggedStepResult: TaggedStepResult){
        this.results = taggedStepResult
    }
}

interface PlannerExecutorArgs {
    model_router: Router ,
    agent_router: AgentRouter, 
    maxRetries: number | undefined,
    getPlannerInstructions?: (router: AgentRouter)=> string,
    plannerPromptExamples?: string,
    getPlannerTools?: (executor: PlannerExecutor) => Array<Tool<any>>
}

export class PlannerExecutor {
    __tag = "PlannerExecutor"
    agent: AgentBuilder
    steps: Array<PlannedStep> = []
    router: AgentRouter
    plannerPrompt: string | undefined
    plannerTools: Array<Tool<any>> | undefined
    plannerToolExamples: string | undefined

    constructor(
        args: PlannerExecutorArgs
    ){
        const { 
            agent_router,
            maxRetries = 3, 
            model_router,
            getPlannerInstructions,
            getPlannerTools,
            plannerPromptExamples
         } = args
        this.router = agent_router
        this.agent = new AgentBuilder(model_router, maxRetries, true)
        if(getPlannerTools){
            this.plannerTools = getPlannerTools(this)
        }
        if(getPlannerInstructions){
            this.plannerPrompt = getPlannerInstructions(this.router)
        }
        if(plannerPromptExamples){
            this.plannerToolExamples = plannerPromptExamples
        }
    }


    setup(){
        this.agent.prompt({
            instruction: this.plannerPrompt ?? `
            # Planning Agent - Execution Orchestrator

            ## Core Responsibility
            You are an intelligent Planning Agent responsible for decomposing complex user intents into executable, sequential plans. Your primary role is to bridge the gap between user requests and actionable agent workflows.

            ## Planning Process
            1. **Intent Analysis**: Analyze the user's query to understand their true intent and desired outcome
            2. **Plan Generation**: Create a structured execution plan with clear, sequential steps
            3. **Agent Assignment**: Match each step to the most appropriate specialized agent from available options
            4. **Execution Management**: Monitor step execution, handle failures, and adapt the plan as needed

            ## Available Agents
            ${this.router.serialize()}

            ## Execution Rules
            - **Sequential Processing**: Handle one step at a time in strict order
            - **Single Tool Usage**: Use only one tool per interaction
            - **Mandatory Tool Usage**: Always use a tool for every response
            - **Failure Handling**: Retry failed steps up to 3 times before stopping
            - **Success Validation**: Verify step completion against defined criteria

            ## Step Creation Guidelines
            Each step must include:
            - **Clear objective**: What needs to be accomplished
            - **Success criteria**: How to determine if the step is complete
            - **Agent assignment**: Which specialized agent should handle this step
            - **Context transfer**: All necessary information for the assigned agent

            ## Error Recovery
            - On step failure: Analyze the failure reason and create a refined retry prompt
            - After 3 failures: Stop execution and provide a detailed summary
            - On success: Extract results and prepare context for the next step

            ## Output Requirements
            - Provide detailed execution summaries upon completion
            - Include step-by-step results and any encountered issues
            - Ensure the user can understand the full execution journey
            `,
            promptLevel: `1`,
            examples: this.plannerToolExamples ?? `
            ## Example 1: User Data Analysis Request

            **User Query**: "Analyze the sales data from last quarter and create a summary report"

            **Planning Response**:
            1. **Intent Analysis**: User wants to analyze historical sales data and generate insights
            2. **Execution Plan**:
            - Step 1: Data Retrieval Agent - Extract sales data for last quarter
            - Step 2: Analysis Agent - Perform statistical analysis on the data
            - Step 3: Report Generation Agent - Create formatted summary report

            **Tool Usage**:
            \`\`\`json
            {
            "steps": [
                {
                "agent": "data-retrieval",
                "name": "Extract Q3 Sales Data",
                "description": "Retrieve all sales transactions from July-September 2025",
                "completion_criteria": "Successfully extracted all sales records with validation",
                "stepIndex": 1
                },
                {
                "agent": "data-analysis",
                "name": "Analyze Sales Trends",
                "description": "Calculate metrics, trends, and key insights from sales data",
                "completion_criteria": "Generated statistical analysis with trends and anomalies identified",
                "stepIndex": 2
                },
                {
                "agent": "report-generator",
                "name": "Create Summary Report",
                "description": "Format analysis into executive summary with visualizations",
                "completion_criteria": "Professional report generated with charts and key findings",
                "stepIndex": 3
                }
            ]
            }
            \`\`\`

            ## Example 2: Multi-step Content Creation

            **User Query**: "Create a blog post about AI trends, research the topic first, then write and optimize it"

            **Step Execution Flow**:
            1. Use \`planIntentExecution\` to break down the content creation process
            2. Use \`beginStep\` with context: "Research current AI trends from reliable sources, focus on 2025 developments"
            3. After research completion, use \`beginStep\` again: "Write engaging blog post using research findings about AI trends..."
            4. Use \`summarizeOnCompletion\` when all steps are done

            ## Example 3: Error Handling

            **Scenario**: Step fails due to API timeout

            **Recovery Process**:
            - Analyze failure: "API timeout occurred during data retrieval"
            - Use \`beginStep\` with refined prompt: "Retry data retrieval with smaller batch sizes and timeout handling"
            - If fails again: Document failure and proceed to next viable step or stop execution

            ## Tool Usage Patterns

            **Sequential Processing**:
            - Always complete current step before moving to next
            - Use step results to inform next step's prompt
            - Maintain context continuity throughout execution

            **Prompt Construction**:
            - Include previous step results in next step prompt
            - Provide clear success criteria for each step
            - Ensure agent has all necessary context to succeed
            `,
            tools: this.plannerTools ?? [
                Tool.create({
                    name: "planner",
                    description: "Create an execution plan for the user's intent",
                    schema: planIntentExecution,
                    handle: async (data) => {
                        this.steps = data.steps?.map((s) => {
                            return new PlannedStep({
                                name: s.name,
                                description: s.description,
                                agent: s.agent,
                                completion_criteria: s.completion_criteria,
                                stepIndex: s.stepIndex
                            })
                        })
                        return data
                    },
                }),
                summarizeTool,
                beginStepTool
            ]
        })
    }


    async run(prompt: string){
        await this.agent.run(prompt)
        if (this.steps.length == 0) {
            throw new Error("No steps were generated")
        }

        const promptResult = await this.agent.run("determine a prompt for executing the first step")

        const initialPrompt = (promptResult?.at(0)?.data as z.infer<typeof beginStep>)?.stepPrompt ?? promptResult?.at(0)?.data

        const summary = await this.executeStep(initialPrompt)

        return summary
    }


    async executeStep(prompt: string, end?: boolean): Promise<Array<PipelineOutput>> {
        const sorted_steps = this.steps.sort((a, b) => a.stepIndex - b.stepIndex)

        const step = sorted_steps.find((v) => v.status == "pending")
        const stepIndex = sorted_steps.findIndex((v) => v.status == "pending")

        if (end || !step) {

            const content = await this.agent.run(prompt)

            return content

        };
        const spec = await this.router.get(step.agent)
        if (!spec) return [];
        const result = await step.process(spec.agent, prompt)
        const stringified_result = JSON.stringify(result)
        step.setStatus("completed")


        if (stepIndex == sorted_steps.length - 1) {

            return await this.executeStep("Summarize the execution details", true)
        }

        const data_prompt = `
        COMPLETED STEP: ${step.name}
        DESCRIPTION: ${step.description}
        COMPLETION CRITERIA: ${step.completion_criteria}
        RESULTS:
        ${
            stringified_result
        }
        `;


        const promptResult = await this.agent.run(`
        make use of the begin_step tool and provide a valid prompt for the next step in the sequence:
        ${data_prompt}    
        `)

        const res = (promptResult?.at(0)?.data as z.infer<typeof beginStep>)?.stepPrompt ?? promptResult?.at(0)?.data

        return await this.executeStep(res)
    }
}