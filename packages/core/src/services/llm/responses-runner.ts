import { effectiveEffort, degradationNotes } from './degradation';
import { endpointUrl, type PostRequest, type PostResponse } from './http';
import { isUnsupportedParamError, paramsToDrop, presentParams, stepFor, withoutParams, type OptionalParam } from './optional-params';
import { responsesRequestBody, responsesText, type StrictSchema } from './responses';
import { responsesUsage, type UsageTally } from './usage';

export interface ResponsesCall {
  connection: { baseUrl: string; model: string; apiKey: string };
  instructions: string;
  input: string;
  maxOutputTokens?: number;
  json?: boolean;
  jsonSchema?: StrictSchema | null;
  reasoningEffort: string | null;
  timeoutMs: number;
  signal?: AbortSignal;
}

/** One /responses call prepared for the retry loop of a transmission. */
export interface PreparedResponses {
  url: string;
  attempt: (tally: UsageTally) => Promise<string>;
}

/** Sends /responses requests; learns per endpoint and model which optional parameters and which gentler fallbacks it accepts. */
export class ResponsesRunner {
  /** Parameters (and downgrades) an endpoint has rejected; kept in memory so they are not re-learned every call. */
  private readonly rejectedParams = new Map<string, Set<OptionalParam>>();

  constructor(
    private readonly post: (request: PostRequest) => Promise<PostResponse>,
    private readonly warn: (message: string, data?: Record<string, unknown>) => void,
  ) {}

  prepare(call: ResponsesCall): PreparedResponses {
    const { connection, signal } = call;
    const url = endpointUrl(connection.baseUrl, 'responses');
    const endpointKey = `${url}\n${connection.model}`;
    const rejected = this.rejectedParams.get(endpointKey) ?? new Set<OptionalParam>();
    const build = () =>
      responsesRequestBody({
        model: connection.model,
        instructions: call.instructions,
        input: call.input,
        maxOutputTokens: call.maxOutputTokens,
        reasoningEffort: effectiveEffort(call.reasoningEffort, { baseUrl: connection.baseUrl, rejected }),
        json: call.json,
        jsonSchema: call.jsonSchema && !rejected.has('json_schema') ? call.jsonSchema : undefined,
      });
    const send = async (tally: UsageTally) => {
      const body = withoutParams(build(), rejected);
      tally.countRequest();
      const response = await this.post({ url, apiKey: connection.apiKey, body, timeoutMs: call.timeoutMs, signal });
      // an answer cut short or empty was paid for as well
      tally.add(responsesUsage(response.text));
      for (const note of degradationNotes({ jsonSchema: Boolean(call.jsonSchema), effort: call.reasoningEffort }, { body })) tally.note(note);
      return response;
    };
    return {
      url,
      attempt: async (tally) => {
        let response = await send(tally);
        // some compatible endpoints do not know optional parameters → retry without exactly the ones the error names (or a gentler step first)
        while (response.status === 400 && isUnsupportedParamError(response.text)) {
          const body = build();
          const steps = paramsToDrop(response.text, presentParams(body, rejected)).map((param) => stepFor(param, body));
          if (steps.length === 0) break;
          for (const step of steps) rejected.add(step);
          this.rejectedParams.set(endpointKey, rejected);
          this.warn('Endpoint rejected optional parameters – retrying with a gentler request', { steps });
          response = await send(tally);
        }
        return responsesText(response);
      },
    };
  }
}
