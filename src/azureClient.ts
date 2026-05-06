// Azure OpenAI / Foundry Chat Completions client.
// Supports: tool/function calling, multimodal content (text + image_url),
// streaming (SSE) with assembled tool_calls, and token-usage capture.

export type Role = 'system' | 'user' | 'assistant' | 'tool';

export interface ImagePart {
    type: 'image_url';
    image_url: { url: string; detail?: 'auto' | 'low' | 'high' };
}
export interface TextPart {
    type: 'text';
    text: string;
}
export type ContentPart = TextPart | ImagePart;
export type MessageContent = string | ContentPart[] | null;

export interface ToolCall {
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
}

export interface ChatMessage {
    role: Role;
    content: MessageContent;
    name?: string;
    tool_calls?: ToolCall[];
    tool_call_id?: string;
}

export interface ToolSpec {
    type: 'function';
    function: {
        name: string;
        description: string;
        parameters: Record<string, unknown>;
    };
}

export interface Usage {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
}

export interface ChatRequestOptions {
    tools?: ToolSpec[];
    toolChoice?: 'auto' | 'none' | 'required';
    temperature?: number;
    topP?: number;
    maxCompletionTokens?: number;
    signal?: AbortSignal;
}

export interface ChatChoice {
    finish_reason: string;
    message: {
        role: 'assistant';
        content: string | null;
        tool_calls?: ToolCall[];
    };
}

export interface ChatCompletion {
    id: string;
    model: string;
    choices: ChatChoice[];
    usage?: Usage;
}

export interface ChatResult {
    choice: ChatChoice;
    usage?: Usage;
}

export type StreamDelta =
    | { kind: 'text'; text: string }
    | { kind: 'tool_call_delta'; index: number; id?: string; name?: string; argumentsDelta?: string }
    | { kind: 'finish'; reason: string }
    | { kind: 'usage'; usage: Usage };

export interface AzureClientConfig {
    endpoint: string;
    apiKey: string;
    deployment: string;
    apiVersion: string;
    maxCompletionTokens: number;
    temperature: number;
    topP: number;
}

export class AzureOpenAIClient {
    private endpoint: string;
    private apiKey: string;
    private deployment: string;
    private apiVersion: string;
    private defaultMaxTokens: number;
    private defaultTemperature: number;
    private defaultTopP: number;

    constructor(cfg: AzureClientConfig) {
        this.endpoint = cfg.endpoint.replace(/\/+$/, '');
        this.apiKey = cfg.apiKey;
        this.deployment = cfg.deployment;
        this.apiVersion = cfg.apiVersion;
        this.defaultMaxTokens = cfg.maxCompletionTokens;
        this.defaultTemperature = cfg.temperature;
        this.defaultTopP = cfg.topP;
    }

    update(cfg: Partial<AzureClientConfig>): void {
        if (cfg.endpoint !== undefined) this.endpoint = cfg.endpoint.replace(/\/+$/, '');
        if (cfg.apiKey !== undefined) this.apiKey = cfg.apiKey;
        if (cfg.deployment !== undefined) this.deployment = cfg.deployment;
        if (cfg.apiVersion !== undefined) this.apiVersion = cfg.apiVersion;
        if (cfg.maxCompletionTokens !== undefined) this.defaultMaxTokens = cfg.maxCompletionTokens;
        if (cfg.temperature !== undefined) this.defaultTemperature = cfg.temperature;
        if (cfg.topP !== undefined) this.defaultTopP = cfg.topP;
    }

    isReady(): boolean {
        return this.endpoint.length > 0 && this.apiKey.length > 0 && this.deployment.length > 0;
    }

    private buildUrl(): string {
        return `${this.endpoint}/openai/deployments/${encodeURIComponent(this.deployment)}/chat/completions?api-version=${encodeURIComponent(this.apiVersion)}`;
    }

    private buildBody(messages: ChatMessage[], opts: ChatRequestOptions, stream: boolean): Record<string, unknown> {
        const body: Record<string, unknown> = {
            messages,
            max_completion_tokens: opts.maxCompletionTokens ?? this.defaultMaxTokens,
            temperature: opts.temperature ?? this.defaultTemperature,
            top_p: opts.topP ?? this.defaultTopP
        };
        if (opts.tools && opts.tools.length > 0) {
            body.tools = opts.tools;
            body.tool_choice = opts.toolChoice ?? 'auto';
        }
        if (stream) {
            body.stream = true;
            body.stream_options = { include_usage: true };
        }
        return body;
    }

    async chat(messages: ChatMessage[], opts: ChatRequestOptions = {}): Promise<ChatResult> {
        if (!this.isReady()) {
            throw new Error('Azure client is not configured. Set endpoint, deployment and API key.');
        }
        const response = await fetch(this.buildUrl(), {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'api-key': this.apiKey
            },
            body: JSON.stringify(this.buildBody(messages, opts, false)),
            signal: opts.signal
        });
        if (!response.ok) {
            throw new Error(`Azure OpenAI ${response.status} ${response.statusText}: ${await safeText(response)}`);
        }
        const data = (await response.json()) as ChatCompletion;
        if (!data.choices || data.choices.length === 0) throw new Error('Azure OpenAI returned no choices.');
        return { choice: data.choices[0], usage: data.usage };
    }

    /**
     * Streaming chat. Yields deltas. The caller assembles them into a final
     * ChatChoice + Usage. Tool-call deltas are partial — index identifies the
     * tool call slot; id/name appear once, argumentsDelta accumulates.
     */
    async *chatStream(messages: ChatMessage[], opts: ChatRequestOptions = {}): AsyncGenerator<StreamDelta> {
        if (!this.isReady()) throw new Error('Azure client is not configured.');
        const response = await fetch(this.buildUrl(), {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'api-key': this.apiKey,
                'Accept': 'text/event-stream'
            },
            body: JSON.stringify(this.buildBody(messages, opts, true)),
            signal: opts.signal
        });
        if (!response.ok) {
            throw new Error(`Azure OpenAI ${response.status} ${response.statusText}: ${await safeText(response)}`);
        }
        if (!response.body) throw new Error('No response body for stream.');

        const reader = (response.body as any).getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const events = buffer.split('\n\n');
            buffer = events.pop() ?? '';
            for (const evt of events) {
                const line = evt.split('\n').find((l: string) => l.startsWith('data: '));
                if (!line) continue;
                const data = line.slice(6).trim();
                if (data === '[DONE]') return;
                let parsed: any;
                try { parsed = JSON.parse(data); } catch { continue; }
                const choice = parsed.choices?.[0];
                if (choice) {
                    const delta = choice.delta;
                    if (delta?.content) yield { kind: 'text', text: delta.content };
                    if (Array.isArray(delta?.tool_calls)) {
                        for (const tc of delta.tool_calls) {
                            yield {
                                kind: 'tool_call_delta',
                                index: tc.index ?? 0,
                                id: tc.id,
                                name: tc.function?.name,
                                argumentsDelta: tc.function?.arguments
                            };
                        }
                    }
                    if (choice.finish_reason) yield { kind: 'finish', reason: choice.finish_reason };
                }
                if (parsed.usage) yield { kind: 'usage', usage: parsed.usage as Usage };
            }
        }
    }

    /** Drives chatStream and assembles the final choice + usage. */
    async streamAssembled(
        messages: ChatMessage[],
        opts: ChatRequestOptions,
        onText?: (chunk: string) => void
    ): Promise<ChatResult> {
        let text = '';
        let finish = 'stop';
        let usage: Usage | undefined;
        const callsByIndex = new Map<number, { id: string; name: string; args: string }>();

        for await (const delta of this.chatStream(messages, opts)) {
            switch (delta.kind) {
                case 'text':
                    text += delta.text;
                    onText?.(delta.text);
                    break;
                case 'tool_call_delta': {
                    const slot = callsByIndex.get(delta.index) ?? { id: '', name: '', args: '' };
                    if (delta.id) slot.id = delta.id;
                    if (delta.name) slot.name = delta.name;
                    if (delta.argumentsDelta) slot.args += delta.argumentsDelta;
                    callsByIndex.set(delta.index, slot);
                    break;
                }
                case 'finish':
                    finish = delta.reason;
                    break;
                case 'usage':
                    usage = delta.usage;
                    break;
            }
        }

        const tool_calls: ToolCall[] = [];
        const indices = Array.from(callsByIndex.keys()).sort((a, b) => a - b);
        for (const i of indices) {
            const slot = callsByIndex.get(i)!;
            if (slot.id || slot.name) {
                tool_calls.push({
                    id: slot.id || `call_${i}`,
                    type: 'function',
                    function: { name: slot.name, arguments: slot.args }
                });
            }
        }

        const choice: ChatChoice = {
            finish_reason: finish,
            message: {
                role: 'assistant',
                content: text || null,
                tool_calls: tool_calls.length > 0 ? tool_calls : undefined
            }
        };
        return { choice, usage };
    }
}

async function safeText(res: Response): Promise<string> {
    try { return await res.text(); } catch { return '<no body>'; }
}
