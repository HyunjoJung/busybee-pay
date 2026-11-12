// Minimal Gemini REST client: JSON-schema structured output + a function-calling agent loop.
// Uses the public Generative Language API (works with a free AI Studio key).
import { settings } from './config.js';

const API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
// HTTP statuses that mean "this model is busy / temporarily unavailable" -> try the next configured model.
const RETRYABLE = new Set([429, 500, 503, 504]);

export class GeminiError extends Error {
  constructor(message, status, model) {
    super(message);
    this.status = status;
    this.model = model;
  }
}

async function generateContent(body) {
  if (!settings.gemini.apiKey) throw new GeminiError('GEMINI_API_KEY is not set (see .env.example).', 400);
  let lastError;
  for (const model of settings.gemini.models) {
    let res;
    try {
      res = await fetch(`${API_BASE}/${model}:generateContent`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': settings.gemini.apiKey },
        body: JSON.stringify(body),
      });
    } catch (err) {
      lastError = new GeminiError(`Network error calling ${model}: ${err.message}`, 0, model);
      continue;
    }
    const data = await res.json().catch(() => ({}));
    if (res.ok) return { model, data };
    lastError = new GeminiError(data?.error?.message || `Gemini HTTP ${res.status}`, res.status, model);
    if (!RETRYABLE.has(res.status)) break;
  }
  throw lastError;
}

function textOf(parts = []) {
  return parts
    .filter((p) => typeof p.text === 'string' && !p.thought)
    .map((p) => p.text)
    .join('')
    .trim();
}

/**
 * Ask Gemini for a JSON object that follows `schema` (JSON Schema).
 * Returns { data, model }.
 */
export async function generateJSON({ system, prompt, schema, temperature }) {
  const body = {
    systemInstruction: system ? { parts: [{ text: system }] } : undefined,
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: {
      responseMimeType: 'application/json',
      responseJsonSchema: schema,
      ...(temperature === undefined ? {} : { temperature }),
    },
  };
  const { model, data } = await generateContent(body);
  const candidate = data.candidates?.[0];
  const text = textOf(candidate?.content?.parts);
  if (!text) throw new GeminiError(`Empty response from ${model} (finishReason=${candidate?.finishReason || 'n/a'})`, 502, model);
  try {
    return { data: JSON.parse(text), model };
  } catch {
    throw new GeminiError(`Model ${model} returned invalid JSON`, 502, model);
  }
}

/**
 * Function-calling loop.
 * tools: { [name]: { description, parameters (JSON schema), run: async (args) => any } }
 * Returns { text, steps: [{ tool, args, result }], model }.
 */
export async function runAgent({ system, history = [], message, tools, maxSteps = settings.gemini.agentMaxSteps }) {
  const contents = [
    ...history.map((h) => ({ role: h.role === 'assistant' ? 'model' : 'user', parts: [{ text: h.text }] })),
    { role: 'user', parts: [{ text: message }] },
  ];
  const functionDeclarations = Object.entries(tools).map(([name, t]) => ({
    name,
    description: t.description,
    parametersJsonSchema: t.parameters,
  }));
  const steps = [];
  let model;
  for (let i = 0; i < maxSteps; i++) {
    const res = await generateContent({
      systemInstruction: system ? { parts: [{ text: system }] } : undefined,
      contents,
      tools: [{ functionDeclarations }],
    });
    model = res.model;
    const content = res.data.candidates?.[0]?.content;
    const parts = content?.parts || [];
    const calls = parts.filter((p) => p.functionCall);
    if (!calls.length) {
      return { text: textOf(parts) || '(no answer)', steps, model };
    }
    // Echo the model turn back verbatim (keeps thought signatures intact), then answer every call.
    contents.push({ role: 'model', parts });
    const responses = [];
    for (const call of calls) {
      const { name, args = {}, id } = call.functionCall;
      const tool = tools[name];
      let result;
      try {
        result = tool ? await tool.run(args) : { error: `Unknown tool ${name}` };
      } catch (err) {
        result = { error: err.message };
      }
      steps.push({ tool: name, args, result });
      responses.push({ functionResponse: { name, ...(id ? { id } : {}), response: { result } } });
    }
    contents.push({ role: 'user', parts: responses });
  }
  return { text: 'I stopped after reaching the maximum number of tool steps.', steps, model };
}
