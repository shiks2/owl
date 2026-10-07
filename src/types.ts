export interface TreeItem {
    path: string;
    mode?: string;
    type: string;
    sha: string;
    size?: number;
    url?: string;
}

export interface GithubFile {
    path: string;
    content: string;
    size: number;
}

export interface RepoTreeResult {
    tree: TreeItem[];
    truncated: boolean;
    allPaths: string[];
}

// src/types.ts

export interface RepoMap {
    owner: string;
    repo: string;
    stack: string[];
    entryPoints: string[];
    // Map of file paths to brief LLM-generated summaries
    fileSummaries: Record<string, string>;
}

export interface Question {
    id: string;
    text: string;
    relatedFiles: string[]; // e.g., ["src/main.go", "config.yaml"]
    difficulty: 'architecture' | 'implementation' | 'security';
}

export interface AnswerState {
    questionId: string;
    userText: string;
    evaluation: string; // The LLM's feedback on the user's answer
    passed: boolean;
}

export interface OwlSession {
    phase: 'idle' | 'ingesting' | 'generating_questions' | 'interviewing' | 'completed';
    repoUrl: string | null;
    repoMap: RepoMap | null;
    questions: Question[];
    currentQuestionIndex: number;
    answers: AnswerState[];
}