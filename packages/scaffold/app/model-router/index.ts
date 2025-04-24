// define model routers here
import { Model, ModelOutput } from "ozone-model"
import { Router } from "ozone-router"
import { Effect } from "effect"
const modelRouter = new Router()


// register model handlers to the router
modelRouter.register(Model.define({
    name: 'gpt-40',
    promptLevel: `1`,
    Asker(input, history) {
        return Effect.tryPromise({
            try: async () =>{
                // example model output
                return {} as ModelOutput
            }, 
            catch(error) {
                return error 
            },
        })
    },
}))

// add other model handlers



export default modelRouter