import {Effect} from "effect";

export interface ModelInput {
    question: string;
    toolName?: string;
    toolDescription?: string;
    tool?: Record<string, any> | undefined,
    tools?: Array<{
        name: string,
        description: string,
        args: Record<string, any>
    }>
}

export interface ModelOutput {
    role?: "user" | "assistant" | "system"
    answer: string | undefined;
    toolResponses?: Array<{ name: string, args: Record<string, any>, id?: string }> | undefined
    toolCallResults?: Array<{ id: string, tool: string, content: string }>
}

export class Model {
    public Name: string;
    public PromptLevel: `${number}`;
    private Asker: (input: ModelInput, history?: Array<ModelOutput>) => Effect.Effect<ModelOutput, any>

    constructor(
        name: string,
        promptLevel: `${number}`,
        Asker: (input: ModelInput, history?: Array<ModelOutput>) => Effect.Effect<ModelOutput, any>
    ) {
        this.Name = name;
        this.PromptLevel = promptLevel;
        this.Asker = Asker;
    }

    ask(input: ModelInput, history?: Array<ModelOutput>): Effect.Effect<ModelOutput, any> {
        return this.Asker(input, history);
    }

    static define(args: {
        name: string,
        promptLevel: `${number}`,
        Asker: (input: ModelInput, history?: Array<ModelOutput>) => Effect.Effect<ModelOutput, any>
    }) {
        const {name, promptLevel, Asker} = args;
        return new Model(name, promptLevel, Asker);
    }
}