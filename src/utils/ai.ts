// src/utils/ai.ts
import type { RepoMap, Question } from "../types";
import type { GithubFile } from "./github";

const MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

type ChatMessage = { role: string; content: string };

// Workers AI `.run` returns a union (object | string | async response).
// With `response_format: json_object`, the `response` field may be a JSON
// string OR an already-parsed object depending on the model/runtime.
// Normalize everything to the parsed JSON value.
function extractJson(output: unknown): unknown {
  let value = output;
  if (value && typeof value === "object" && "response" in value) {
    value = (value as { response: unknown }).response;
  }
  if (typeof value === "string") {
    let text = value.trim();
    const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fence) text = fence[1].trim();
    if (!text) throw new Error("Model returned an empty response");
    return JSON.parse(text);
  }
  return value;
}

// The model is occasionally flaky with JSON output (empty responses, invalid
// JSON). Retry a few times, first with JSON mode (better formatting) and then
// falling back to a plain prompt in case constrained output is the problem.
async function runJson(env: Env, messages: ChatMessage[]): Promise<unknown> {
  const attempts: boolean[] = [true, true, false, false];
  let lastError: unknown = new Error("Failed to generate JSON response");

  for (const useJsonMode of attempts) {
    try {
      const response = useJsonMode
        ? await env.AI.run(MODEL, {
            messages,
            response_format: { type: "json_object" as const }
          })
        : await env.AI.run(MODEL, { messages });
      return extractJson(response);
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError;
}

// 1. Generate the map of the repository
export async function generateRepoMap(
  env: Env,
  owner: string,
  repo: string,
  files: GithubFile[]
): Promise<RepoMap> {
  let contextString = `Repository: ${owner}/${repo}\n\n`;
  for (const f of files) {
    contextString += `--- FILE: ${f.path} ---\n${f.content.substring(0, 2500)}\n\n`;
  }

  const systemPrompt = `You are an expert software architect. Analyze the provided codebase and generate a technical summary. 
You MUST respond with ONLY a valid JSON object matching this exact structure:
{
  "owner": "${owner}",
  "repo": "${repo}",
  "stack": ["React", "TypeScript", "Go"],
  "entryPoints": ["src/index.ts"],
  "fileSummaries": { "src/index.ts": "Main entry point" }
}`;

  const result = await runJson(env, [
    { role: "system", content: systemPrompt },
    { role: "user", content: `Analyze these files:\n${contextString}` }
  ]);

  return result as RepoMap;
}

// 2. Generate interview questions based on the map
export async function generateQuestions(
  env: Env,
  repoMap: RepoMap
): Promise<Question[]> {
  const systemPrompt = `You are a senior software engineer conducting a code review interview.
Based on the provided repository map, generate exactly 5 interview questions about the architecture, implementation, and potential security/edge cases.
You MUST respond with ONLY a valid JSON object containing an array called "questions", matching this exact structure:
{
  "questions": [
    {
      "id": "q1",
      "text": "Why did you choose this specific state management pattern in the frontend?",
      "relatedFiles": ["frontend/lib/main.dart"],
      "difficulty": "architecture"
    }
  ]
}`;

  const result = await runJson(env, [
    { role: "system", content: systemPrompt },
    { role: "user", content: JSON.stringify(repoMap) }
  ]);

  const parsed = result as { questions: Question[] };
  return parsed.questions;
}
