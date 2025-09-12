import { AgentBuilder } from "ozone-builder"


export interface AgentSpec {
    name: string,
    description: string,
    examples?: string,
    agent: AgentBuilder
}

export class AgentRouter {
    private agents: Array<AgentSpec> = []

    register(spec: AgentSpec){
        this.agents.push(spec)
    }

    serialize(){
        let serialization = `
        AGENT SPECIFICATIONS:
        This is a list of the available agents and what they do accompanied with examples of how each one executes it's tasks:
        ` 


        for (const agent of this.agents ){

            const agent_serialization = `
            \n\n
            -------------------------------------------------------------------BEGIN AGENT SPEC-------------------------------------------------------------------
            NAME: ${agent.name}
            DESCRIPTION: ${agent.description}
            ${agent.examples ? `EXAMPLES:` : ``}
            ${agent.examples ?? ''}
            -------------------------------------------------------------------END AGENT SPEC---------------------------------------------------------------------
            \n\n
            `

            serialization = serialization + '\n\n' + agent_serialization;
        }

        return serialization
    }


    async get(name: string){
        const agent = this.agents.find(a=>a.name == name)
        return agent 
    }

}