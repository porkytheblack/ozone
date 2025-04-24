import { Model } from "ozone-model"

export class Router {
    models: Record<`${number}`, Model>

    constructor() {
        this.models = {}
    }

    register(model: Model) {
        this.models[model.PromptLevel] = model
        return this
    }

    route(promptLevel: `${number}`) {
        return this.models[promptLevel]
    }
}