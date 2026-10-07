# 🦉 Owl

**Your AI-Powered Technical Codebase Interviewer**

**[▶️ Live Demo](https://owl.shiks-publications.workers.dev/)**

Owl is an intelligent application built for the Cloudflare AI Challenge that turns any public GitHub repository into an interactive technical interview. Paste a repository URL, and Owl will ingest the codebase, map out its architecture, and rigorously quiz you on your own code.

---

## ✨ Features

- **Automated Codebase Ingestion:** Instantly fetches and analyzes the core architecture of any public GitHub repository.
- **Intelligent Noise Filtering:** Automatically ignores binaries, lockfiles, and OS junk to focus solely on meaningful source code.
- **Architectural Repo Mapping:** Generates a high-level technical summary, identifying the tech stack, entry points, and key components.
- **Targeted AI Interrogation:** Dynamically generates bespoke, architecture-specific interview questions using Llama 3.3.
- **Real-Time Interactive Chat:** Conducts the interview via a seamless, WebSocket-powered chat interface.

---

## 🏗️ Architecture

The application operates through a streamlined pipeline managed entirely on Cloudflare's edge:

1. **GitHub Ingestion:** The backend uses the GitHub API to fetch the repository's file tree, smartly ranks and filters the files, and retrieves the raw text of the most architecturally significant files.
2. **Cloudflare Workers AI:** The raw codebase text is passed to Llama 3.3 70B, which produces a structured JSON `RepoMap`.
3. **Question Generation:** The `RepoMap` is then fed back into the LLM to generate targeted, context-aware interview questions.
4. **Durable Objects:** Cloudflare Durable Objects orchestrate this state machine. They maintain the WebSocket connections with the client, broadcast real-time status updates (e.g., "Fetching repository..."), and persist the session state (the `RepoMap`, the queue of generated questions, and the user's answers).

---

## 🏆 Cloudflare Requirements Fulfilled

This project proudly fulfills the core requirements of the Cloudflare AI Challenge:

1. **LLM Integration:** Utilizes `@cf/meta/llama-3.3-70b-instruct-fp8-fast` via Workers AI for both codebase summarization and question generation.
2. **Workflow / Coordination:** Cloudflare Workers orchestrate a multi-step, asynchronous pipeline, seamlessly coordinating the GitHub API fetch, the LLM mapping phase, and the LLM generation phase.
3. **User Input:** Features a responsive React-based chat UI deployed on Cloudflare Pages, maintaining real-time, low-latency communication with the backend over WebSockets.
4. **Memory / State Management:** Cloudflare Durable Objects are heavily utilized to maintain independent session state for every chat instance, persisting the `RepoMap`, the interview question list, and the user's progress.

---

## 🚀 Local Setup

To run Owl locally, follow these steps:

### 1. Clone the repository
```bash
git clone https://github.com/your-username/owl.git
cd owl
```

### 2. Install dependencies
```bash
npm install
```

### 3. Configuration
Ensure your `wrangler.json` (or `wrangler.jsonc`) is properly configured with your Cloudflare AI bindings. 
You will also need to provide a GitHub Personal Access Token to avoid rate limits during codebase ingestion:

```bash
npx wrangler secret put GITHUB_TOKEN
```

### 4. Run Locally
Start the development server:
```bash
npm run dev
```

---

## 📜 Prompt History

This project was built using an AI-assisted agentic coding workflow. You can view the exact prompts, bug fixes, and iterative development logs in the [`PROMPTS.md`](./PROMPTS.md) file.
