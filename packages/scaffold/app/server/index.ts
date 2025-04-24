import "dotenv/config"
import express from "express"
import cors from "cors"
import agentRouter from '../agents'
import z from "zod"
import { TaggedStepResult } from "ozone-builder"


const PORT = process.env.PORT ?? "4040"

const app = express()
app.use(express.json())
app.use(express.urlencoded())
app.use(cors())

function stringifyTaggedStepResult(step: TaggedStepResult) {

    try {
        const stringified = JSON.stringify(
            {
                data: step.data,
                agent: step.agent,
                SIGNAL: step.SIGNAL,
                executor: step.executor,
                step: step.step,
            }
        )
    
        return stringified
    } catch (e)
    {
        return `{"error": "Unable To deserialize"}`
    }
    
}


app.get("/agents/spec", async (req, res)=>{
    const agents_list = agentRouter.all.map((spec)=>{
        const n: any = spec
        n.agent = undefined
        return n 
    })

    res.status(200).send({
        agents: agents_list
    })
})

// work with server sent events
app.post("/agents/:agent_name/trigger", async (req, res)=>{
    const schema = z.object({
        instruction: z.string().nonempty()
    })

    const parsed = schema.safeParse(req.body)

    if(!parsed.success){
        res.status(400).send({
            errors: parsed.error.flatten().fieldErrors
        })
        return
    }

    const data = parsed.data;
    const agent_name = req.params.agent_name;
    const agent = agentRouter.get(agent_name)
    if(!agent){
        res.status(404).send({
            error: "No agent found"
        })
        return
    }

    res.setHeader('Content-Type', "text/event-stream")
    res.setHeader("Cache-Control", "no-cache")
    res.setHeader("Connection", "keep-alive")

    req.on("close", ()=> {
        console.log(`client disconnected`)
    })

    agent.onStepComplete((step)=>{
        
        const stringified = stringifyTaggedStepResult(step)
        res.write(`data: ${stringified}\n\n`)
    })

    const result = await agent.run(data.instruction)
    const stringified = stringifyTaggedStepResult(result)

    res.write(`data: ${stringified}\n\n`)
    
})


app.listen(PORT, (err)=>{
    if(err){
        console.log(`Unable to run on PORT ${PORT}`)
    }else{
        console.log(`Successfull started agent server on PORT ${PORT}`)
    }
})