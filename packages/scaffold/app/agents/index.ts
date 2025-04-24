import { AgentBuilder } from "ozone-builder";
import entryAgent from "./entry";



class AgentRouter {
    private agents: Array<AgentBuilder> = []

    register(agent: AgentBuilder){
        this.agents.push(agent)
    }

    get(agent_name: string){
        const agent = this.agents.find((a)=> a.spec.name && a.spec.name == agent_name)
        return agent
    }

    get all(){
        return this.agents.map((a)=>a.spec)
    }
}

const agentRouter = new AgentRouter()


agentRouter.register(entryAgent)

export default agentRouter