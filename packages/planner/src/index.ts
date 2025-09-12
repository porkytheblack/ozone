import { z } from "zod"
import { Router } from "ozone-router"
import { AgentRouter } from "ozone-agent-router"
import { AgentBuilder, EXECUTION_SIGNALS, TaggedStepResult, Tool } from "ozone-builder"
import zodToJsonSchema from "zod-to-json-schema"
import { ModelOutput } from "ozone-model"
import { randomBytes } from "crypto"
import { extractSummary } from "./utills"


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


const markStepAsDone = z.object({
    step: z.string(),
    reason: z.string()
})

const markStepAsFailed = z.object({
    step: z.string(),
    reason: z.string()
})

const repeatPreviousStep = z.object({
    newPrompt: z.string()
})

const summarizeOnCompletion = z.object({
    summary: z.string()
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
    getPlannerTools?: (executor: PlannerExecutor)=> Array<Tool>
}

export class PlannerExecutor {
    __tag = "PlannerExecutor"
    agent: AgentBuilder
    steps: Array<PlannedStep> = []
    router: AgentRouter
    plannerPrompt: string | undefined
    plannerTools: Array<Tool> | undefined
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
                {
                    args: zodToJsonSchema(planIntentExecution),
                    description:`Plan the steps required to successfuly execute the user's intent `,
                    name: 'planIntentExecution',
                    schema: planIntentExecution,
                    handle: async (args: z.infer<typeof planIntentExecution>) => {
                        // modify steps
                        
                        const steps = args?.steps?.map((step)=>{
                            // const agent = this.router.get(step.agent)

                            return new PlannedStep({
                                agent: step.agent,
                                completion_criteria: step.completion_criteria,
                                description: step.description,
                                name: step.name,
                                stepIndex: step.stepIndex
                            })
                        
                        })

                        // console.log("Steps ::", steps)

                        this.steps = steps
                        
                        return {
                            steps: this.steps
                        }
                    },
                },
                {
                    args: zodToJsonSchema(summarizeOnCompletion),
                    description: `Once successful or unsuccessful execution of the stack is complete, summarize the details of execution to make it easier for the user to understand`,
                    name: 'summarizeOnCompletion',
                    schema: summarizeOnCompletion,
                    handle(args) {
                        // modify execution stack
                        return args
                    },
                },
                {
                    args: zodToJsonSchema(beginStep),
                    description: `Provide a prompt with all relevant context for the next agent to successfully complete`,
                    name: 'beginStep',
                    schema: beginStep,
                    handle: async (args) => {
                        // console.log("Step prompt::\n\n", JSON.stringify(args), "\n\n")
                        return args
                    }
                }
            ]
        })
    }


    async run(prompt: string){
        
        const stepResult = await this.agent.run(prompt)

        const steps = stepResult?.data?.steps as Array<PlannedStep>

        const promptResult = await this.agent.run("determine a prompt for executing the first step")

        const initialPrompt = promptResult?.data?.stepPrompt ?? promptResult?.data?.conent ?? ""


        const summary = await this.executeStep(initialPrompt)

        return summary
    }


    async executeStep(prompt: string): Promise<any>{
        // grab first pending step
        const step = this.steps.sort((a,b)=>a.stepIndex-b.stepIndex).find((v)=>v.status == "pending")
        if(!step) {
            // means we've reached the end of the step execution stack

            const result = await this.agent.run("summarize the execution process")

            return extractSummary(result.data)

        };
        const spec = await this.router.get(step.agent)
        if(!spec) return null;
        const result = await step.process(spec.agent, prompt)
        if(!(result.SIGNAL === EXECUTION_SIGNALS.STOP || result.SIGNAL === EXECUTION_SIGNALS.CONTINUE)){
            return result
        }
        console.log("COMPLETED::", step.id)
        step.setStatus("completed")

        const data_result = (()=>{
            if (result.data instanceof String) return result.data;
            const res: ModelOutput = result.data
            
            return res.toolCallResults?.at(0)?.content
        })();


        const data_prompt = `
        COMPLETED STEP: ${step.name}
        DESCRIPTION: ${step.description}
        COMPLETION CRITERIA: ${step.completion_criteria}
        RESULTS:
        ${
            data_result
        }
        `;


        const promptResult = await this.agent.run(`
        use beginStep and determine a valid prompt for the next step in the sequence:
        ${data_prompt}    
        `)

        const res = promptResult?.data?.toolCallResults?.at(0)?.content ?? promptResult?.data?.answer ?? "";
        
        // console.log("Res ::", promptResult?.data)
        return await this.executeStep(res)
    }
}