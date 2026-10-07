
const USER_AGENT = 'Owl-Cloudflare-Agent';
const NAME_REGEX = /^[A-Za-z0-9_.-]+$/;

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

export function parseGitHubUrl(url: string): { owner: string; repo: string } | null {
    try {
        const parsed = new URL(url);
        if (parsed.hostname !== 'github.com' && parsed.hostname !== 'www.github.com') return null;
        const parts = parsed.pathname.split('/').filter(Boolean);
        if (parts.length < 2) return null;

        const owner = parts[0];
        const repo = parts[1].replace(/\.git$/, '');

        if (!NAME_REGEX.test(owner) || !NAME_REGEX.test(repo)) return null;

        return { owner, repo };
    } catch {
        return null;
    }
}

export async function fetchRepoTree(owner: string, repo: string, token?: string): Promise<RepoTreeResult> {
    const headers: Record<string, string> = {
        'User-Agent': USER_AGENT,
        'Accept': 'application/vnd.github.v3+json',
    };
    if (token) {
        headers['Authorization'] = `Bearer ${token}`;
    }

    const response = await fetch(
        `https://api.github.com/repos/${owner}/${repo}/git/trees/HEAD?recursive=1`,
        { headers }
    );
    if (!response.ok) {
        if (response.status === 404) {
            throw new Error(`Repository "${owner}/${repo}" not found or private.`);
        }
        if (response.status === 403 || response.status === 429) {
            throw new Error(`GitHub API rate limit exceeded. Set GITHUB_TOKEN secret to increase limits.`);
        }
        throw new Error(`GitHub API Error (${response.status}): ${response.statusText || 'Request failed'}`);
    }

    const data = await response.json() as { tree: TreeItem[]; truncated?: boolean };
    const blobTree = data.tree.filter((item) => item.type === 'blob');
    const allPaths = blobTree.map((item) => item.path);

    return {
        tree: blobTree,
        truncated: Boolean(data.truncated),
        allPaths,
    };
}

export function getImportantFiles(tree: TreeItem[], maxFiles = 15): TreeItem[] {
    const ignorePatterns = [
        /node_modules\//, /(^|\/)\./, // hidden files/folders (.git, .vscode, .DS_Store)
        /:Zone\.Identifier$/i,        // Windows NTFS Zone.Identifier streams
        /(^|\/)(Thumbs\.db|desktop\.ini)$/i, // Windows metadata
        /(^|\/)\._/,                  // macOS AppleDouble files
        /package-lock\.json$/, /yarn\.lock$/, /pnpm-lock\.yaml$/, /go\.sum$/, /Cargo\.lock$/,
        /\.(png|jpe?g|gif|svg|ico|webp)$/i,
        /\.(mp4|webm|wav|mp3|ogg)$/i,
        /\.(pdf|docx?|xlsx?|pptx?)$/i,
        /\.(bin|exe|dll|so|dylib)$/i,
        /dist\//, /build\//, /out\//
    ];

    const validFiles = tree.filter((file) => {
        return !ignorePatterns.some(pattern => pattern.test(file.path)) && (file.size ?? 0) < 100000; // Skip files > 100KB
    });

    // Multi-signal scoring: manifests, entry points, source dirs, extensions, and shallow paths
    const scoreFile = (path: string) => {
        let score = 0;

        // 1. High-priority documentation & manifests
        if (/readme(\.md)?$/i.test(path)) score += 100;
        else if (/(package\.json|go\.mod|cargo\.toml|pyproject\.toml|requirements\.txt|pubspec\.yaml|build\.gradle(\.kts)?|pom\.xml|composer\.json)$/i.test(path)) score += 80;

        // 2. Main entry points
        if (/(main|index|app|server|mod|entry)\.(ts|tsx|js|jsx|go|rs|py|dart|java|kt|rb|php|cs|c|cpp)$/i.test(path)) score += 50;

        // 3. Key source code directories
        if (/(^|\/)(src|lib|app|cmd|internal|server|pkg|core)\//i.test(path)) score += 20;

        // 4. Source code file extensions
        if (/\.(ts|tsx|js|jsx|go|rs|py|dart|java|kt|rb|php|cs|c|cpp|h|hpp|swift|scala|sql|graphql|proto)$/i.test(path)) score += 15;
        else if (/\.(json|yaml|yml|toml|env\.example|dockerfile)$/i.test(path)) score += 5;

        // 5. Prefer shallow paths over deep nested paths (depth penalty)
        const depth = (path.match(/\//g) || []).length;
        score -= depth * 2;

        return score;
    };

    return validFiles
        .sort((a, b) => {
            const diff = scoreFile(b.path) - scoreFile(a.path);
            return diff !== 0 ? diff : a.path.localeCompare(b.path);
        })
        .slice(0, maxFiles);
}

// 4. Fetch the actual text content of the selected files
export async function fetchFileContents(
    owner: string,
    repo: string,
    files: TreeItem[],
    token?: string
): Promise<GithubFile[]> {
    const headers: Record<string, string> = {
        'User-Agent': USER_AGENT,
        'Accept': 'application/vnd.github.v3.raw',
    };

    if (token) {
        headers['Authorization'] = `Bearer ${token}`;
    }

    // Fetch all selected files in parallel using HEAD
    const fetchPromises = files.map(async (file) => {
        const response = await fetch(
            `https://raw.githubusercontent.com/${owner}/${repo}/HEAD/${file.path}`,
            { headers }
        );

        if (!response.ok) {
            if (response.status === 403 || response.status === 429) {
                throw new Error(`GitHub API rate limit exceeded while fetching raw files. Set GITHUB_TOKEN secret to increase limits.`);
            }
            return null;
        }

        const content = await response.text();
        return { path: file.path, content, size: file.size ?? content.length };
    });

    const results = await Promise.all(fetchPromises);
    return results.filter((r): r is GithubFile => r !== null);
}