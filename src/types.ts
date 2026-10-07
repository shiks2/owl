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

