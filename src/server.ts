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

    const githubRepo = parseGitHubUrl(textContent);

    if (githubRepo) {
      await this.ctx.storage.put("state", "ingesting");
      this.broadcast(
        JSON.stringify({ type: "status", status: "Fetching repository..." })
      );

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
      await this.ctx.storage.put("questions", questions);
      await this.ctx.storage.put("state", "interviewing");

      this.broadcast(JSON.stringify({ type: "clear-status" }));

      const firstQuestion = questions[0].text;
      return textMessageStreamResponse(firstQuestion);
    }

    const state = await this.ctx.storage.get("state");
    if (state === "interviewing") {
      const questions = (await this.ctx.storage.get("questions")) as any[];
      let currentIdx = ((await this.ctx.storage.get("currentQuestionIndex")) as number) || 0;
      
      const question = questions[currentIdx];
      
      this.broadcast(JSON.stringify({ type: "status", status: "Evaluating your answer..." }));
      const feedback = await evaluateAnswer(this.env, question, textContent);
      this.broadcast(JSON.stringify({ type: "clear-status" }));
      
      let answers = (await this.ctx.storage.get("answers")) as any[] || [];
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
