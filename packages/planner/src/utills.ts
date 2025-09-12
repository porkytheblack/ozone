import { ModelOutput } from "ozone-model";


export function extractSummary(output: ModelOutput){
    let summary = output?.toolResponses?.at(0)?.args['summary']

    if(!summary){
        summary = output?.answer
    }

    if(!summary) return "No summary was generated"

    return summary
}