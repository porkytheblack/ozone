import { Effect } from "effect"
import { z } from "zod"

export interface ToolDesc {
    name: string,
    description: string,
    parameters: Record<string,any>
}

export class Tool<S extends z.ZodObject<{}, z.core.$strip>> {
    __tag = "Tool" as const
    private schema: S
    private handler: (data: z.infer<S>)=> Promise<any>
    private name: string
    private description: string

    constructor(args: {
        schema: S,
        handle: (data: z.infer<S>)=> Promise<any>,
        name: string,
        description: string
    }){
        this.schema = args.schema
        this.handler = args.handle
        this.name = args.name
        this.description = args.description 
    }

    static create<S extends z.ZodObject<{}, z.core.$strip>>(args: {
        schema: S,
        handle: (data: z.infer<S>)=> Promise<any>,
        name: string,
        description: string
    }) {
        return new Tool(args)
    }

    get tool(): ToolDesc{
        return {
            name: this.name,
            description: this.description,
            parameters: z.toJSONSchema(this.schema)
        }
    }

    parse(data: any){
        return this.schema.safeParse(data)
    }

    async run(data: z.infer<S>){
        return Effect.runPromise(Effect.tryPromise({
            try: async ()=>{
                return await this.handler(data)
            },
            catch(error) {
                throw error
            },
        }))
    }


}