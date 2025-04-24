import { AgentBuilder, EXECUTION_SIGNALS, ExecutionStackError, TaggedStepResult } from "ozone-builder"
import modelRouter from "../../model-router"
import { Effect } from "effect"

const entryAgent = new AgentBuilder(
    modelRouter, 
    3,
    // use history if needed 
)


entryAgent
.prompt({
    instruction: `
    `, 
    examples: `
    `,
    promptLevel: `1`,
    tools: []
})
.evaluate({
    validationRequirement: "",
    promptLevel: `1`,
    examples: ``
})
.next((input)=>Effect.tryPromise({
    try: async ()=>{
        return new TaggedStepResult({
            SIGNAL: EXECUTION_SIGNALS.STOP,
            data: null,
            executor: 'Next'
        })
    },
    catch(error) {
        return new ExecutionStackError({
            stepResult: new TaggedStepResult({
                SIGNAL: EXECUTION_SIGNALS.ERROR,
                data: error
            })
        })
    },
}))

export default entryAgent