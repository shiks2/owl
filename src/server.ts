import { createWorkersAI } from "workers-ai-provider";
import { callable, routeAgentRequest } from "agents";
import { AIChatAgent, type OnChatMessageOptions } from "@cloudflare/ai-chat";
import {
  convertToModelMessages,
  createUIMessageStream,
  createUIMessageStreamResponse,
  pruneMessages,
  stepCountIs,
  streamText
} from "ai";
import {
  parseGitHubUrl,
  fetchRepoTree,
  getImportantFiles,
  fetchFileContents
} from "./utils/github";
import { generateRepoMap, generateQuestions, evaluateAnswer } from "./utils/ai";
import type { Question, AnswerState } from "./types";

// Stream a known piece of text as an assistant UI message WITHOUT calling a
// model. The fp8 Llama model tends to loop/repeat when asked to reproduce a
// question verbatim, so we emit the already-generated question directly.
function textMessageStreamResponse(text: string): Response {
  const stream = createUIMessageStream({
    execute: ({ writer }) => {
      const partId = `text-${crypto.randomUUID()}`;
      writer.write({ type: "start" });
      writer.write({ type: "text-start", id: partId });
      writer.write({ type: "text-delta", id: partId, delta: text });
      writer.write({ type: "text-end", id: partId });
      writer.write({ type: "finish", finishReason: "stop" });
    }
  });
  return createUIMessageStreamResponse({ stream });
}

// ── Abuse / cost controls (per session) ───────────────────────────────
// Each session is a Durable Object. These caps bound how many times a single
// session can trigger the expensive repo-ingestion pipeline (GitHub API calls
// plus multiple LLM invocations), which is the main abuse/cost surface.
const MAX_INTERVIEWS_PER_SESSION = 5;
const INGEST_COOLDOWN_MS = 30_000; // 30s between interviews

export class ChatAgent extends AIChatAgent<Env> {
  maxPersistedMessages = 100;
  chatRecovery = true;
  // Wait for MCP connections to be re-established after hibernation before
  // processing a message, so MCP tools aren't intermittently missing.
  waitForMcpConnections = true;

  onStart() {
    // Configure OAuth popup behavior for MCP servers that require authentication
    this.mcp.configureOAuthCallback({
      customHandler: (result) => {
        if (result.authSuccess) {
          return new Response("<script>window.close();</script>", {
            headers: { "content-type": "text/html" },
            status: 200
          });
        }
        return new Response(
          `Authentication Failed: ${result.authError || "Unknown error"}`,
          { headers: { "content-type": "text/plain" }, status: 400 }
        );
      }
    });
  }

  @callable()
  async addServer(name: string, url: string) {
    return await this.addMcpServer(name, url);
  }

  @callable()
  async removeServer(serverId: string) {
    await this.removeMcpServer(serverId);
  }

  async onChatMessage(_onFinish: unknown, options?: OnChatMessageOptions) {
    const lastMessage = this.messages[this.messages.length - 1];
    let textContent = "";
    if (lastMessage.parts) {
      for (const part of lastMessage.parts) {
        if (part.type === "text") {
          textContent = part.text;
          break;
        }
      }
    }

    const state = await this.ctx.storage.get("state");
    const githubRepo = parseGitHubUrl(textContent);

    // Only a repository URL can start a new interview, and never while one is
    // already in progress — otherwise a URL inside a candidate's answer would
    // wipe the current interview state.
    if (githubRepo && state !== "interviewing") {
      // ── Abuse / cost guard: bound the expensive ingestion pipeline ──
      const now = Date.now();
      const ingestCount =
        ((await this.ctx.storage.get("ingestCount")) as number) ?? 0;
      const lastIngestAt =
        ((await this.ctx.storage.get("lastIngestAt")) as number) ?? 0;

      if (ingestCount >= MAX_INTERVIEWS_PER_SESSION) {
        return textMessageStreamResponse(
          "You've reached the limit of repository interviews for this session. Open a new session to analyze another repository."
        );
      }
      if (now - lastIngestAt < INGEST_COOLDOWN_MS) {
        const waitSeconds = Math.ceil(
          (INGEST_COOLDOWN_MS - (now - lastIngestAt)) / 1000
        );
        return textMessageStreamResponse(
          `Please wait ${waitSeconds}s before analyzing another repository.`
        );
      }

      await this.ctx.storage.put("lastIngestAt", now);
      await this.ctx.storage.put("ingestCount", ingestCount + 1);

      await this.ctx.storage.put("state", "ingesting");
      this.broadcast(
        JSON.stringify({ type: "status", status: "Fetching repository..." })
      );

      try {
        const githubToken = (this.env as Env & { GITHUB_TOKEN?: string })
          .GITHUB_TOKEN;
        const repoTree = await fetchRepoTree(
          githubRepo.owner,
          githubRepo.repo,
          githubToken
        );
        const importantFiles = getImportantFiles(repoTree.tree, 15);
        const fileContents = await fetchFileContents(
          githubRepo.owner,
          githubRepo.repo,
          importantFiles,
          githubToken
        );

        this.broadcast(
          JSON.stringify({
            type: "status",
            status: "Analyzing codebase architecture with Llama 3.3..."
          })
        );

        const repoMap = await generateRepoMap(
          this.env,
          githubRepo.owner,
          githubRepo.repo,
          fileContents
        );
        await this.ctx.storage.put("repoMap", repoMap);

        this.broadcast(
          JSON.stringify({
            type: "status",
            status: "Generating your interview questions..."
          })
        );

        const questions = await generateQuestions(this.env, repoMap);

        // Reset interview progress for a fresh interview.
        await this.ctx.storage.put("questions", questions);
        await this.ctx.storage.put("currentQuestionIndex", 0);
        await this.ctx.storage.put("answers", []);
        await this.ctx.storage.put("state", "interviewing");

        this.broadcast(JSON.stringify({ type: "clear-status" }));

        return textMessageStreamResponse(questions[0].text);
      } catch (error) {
        await this.ctx.storage.put("state", "idle");
        this.broadcast(JSON.stringify({ type: "clear-status" }));
        const reason =
          error instanceof Error
            ? error.message
            : "an unexpected error occurred";
        return textMessageStreamResponse(
          `Sorry, I couldn't analyze that repository (${reason}). Please make sure it's a public GitHub repo and try again.`
        );
      }
    }

    if (state === "interviewing") {
      const questions =
        (await this.ctx.storage.get<Question[]>("questions")) ?? [];
      let currentIdx =
        ((await this.ctx.storage.get("currentQuestionIndex")) as number) || 0;

      const question = questions[currentIdx];

      // Defensive: end gracefully if the index is out of sync with the data.
      if (!question) {
        await this.ctx.storage.put("state", "completed");
        return textMessageStreamResponse(
          "The interview has concluded. Thanks for participating!"
        );
      }

      this.broadcast(
        JSON.stringify({ type: "status", status: "Evaluating your answer..." })
      );
      const feedback = await evaluateAnswer(this.env, question, textContent);
      this.broadcast(JSON.stringify({ type: "clear-status" }));

      let answers =
        (await this.ctx.storage.get<AnswerState[]>("answers")) ?? [];
      answers.push({
        questionId: question.id,
        userText: textContent,
        evaluation: feedback.feedback,
        passed: feedback.passed
      });
      await this.ctx.storage.put("answers", answers);

      currentIdx++;
      await this.ctx.storage.put("currentQuestionIndex", currentIdx);

      if (currentIdx < questions.length) {
        const nextQ = questions[currentIdx].text;
        const msg = `${feedback.feedback}\n\n---\n\n**Next Question:** ${nextQ}`;
        return textMessageStreamResponse(msg);
      } else {
        await this.ctx.storage.put("state", "completed");
        const passCount = answers.filter((a) => a.passed).length;
        const msg = `${feedback.feedback}\n\n---\n\n**Interview Complete!** You passed ${passCount} out of ${questions.length} questions. Thanks for participating.`;
        return textMessageStreamResponse(msg);
      }
    }

    const mcpTools = this.mcp.getAITools();
    const workersai = createWorkersAI({ binding: this.env.AI });

    const result = streamText({
      model: workersai("@cf/meta/llama-3.3-70b-instruct-fp8-fast", {
        sessionAffinity: this.sessionAffinity
      }),
      system: `You are a helpful assistant. Only answer questions related to the current context.`,
      // Prune old tool calls and reasoning to save tokens on long conversations
      messages: pruneMessages({
        messages: await convertToModelMessages(this.messages),
        toolCalls: "before-last-2-messages",
        reasoning: "before-last-message"
      }),
      tools: {
        // MCP tools from connected servers
        ...mcpTools
      },
      stopWhen: stepCountIs(20),
      abortSignal: options?.abortSignal
    });

    return result.toUIMessageStreamResponse();
  }
}

export default {
  async fetch(request: Request, env: Env) {
    return (
      (await routeAgentRequest(request, env)) ||
      new Response("Not found", { status: 404 })
    );
  }
} satisfies ExportedHandler<Env>;
