// src/utils/ai.ts
// src/utils/ai.ts
import type { RepoMap, Question } from "../types";
import type { GithubFile } from "./github";

// Workers AI `.run` returns a union (object | string | async response).
// Normalize it to the generated text so callers can safely JSON.parse it.
function extractResponseText(output: unknown): string {
  if (typeof output === "string") return output;
  if (output && typeof output === "object" && "response" in output) {
    return String((output as { response: unknown }).response);
  }
  return "";
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

  const response = await env.AI.run(
    "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
    {
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: `Analyze these files:\n${contextString}` }
      ],
      response_format: { type: "json_object" }
    }
  );

  return JSON.parse(extractResponseText(response)) as RepoMap;
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

  const response = await env.AI.run(
    "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
    {
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: JSON.stringify(repoMap) }
      ],
      response_format: { type: "json_object" }
    }
  );

  const parsed = JSON.parse(extractResponseText(response));
  return parsed.questions as Question[];
}
