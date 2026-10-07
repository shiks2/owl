import { parseGitHubUrl, fetchRepoTree, getImportantFiles, fetchFileContents } from '../src/utils/github';

async function run() {
    const url = "https://github.com/shiks2/OpenGIF"; // Or Orna, Project Klause, etc.
    const token = process.env.GITHUB_TOKEN;
    const parsed = parseGitHubUrl(url);

    if (parsed) {
        console.log(`Fetching tree for ${parsed.owner}/${parsed.repo}...`);
        const { tree, truncated, allPaths } = await fetchRepoTree(parsed.owner, parsed.repo, token);

        if (truncated) {
            console.warn(`[Warning] GitHub truncated the file tree for this repository (>100k files or >7MB).`);
        }

        console.log(`Repository contains ${allPaths.length} files in file tree:`);
        console.log(allPaths.slice(0, 10).map(p => `  - ${p}`).join('\n') + (allPaths.length > 10 ? `\n  ... and ${allPaths.length - 10} more` : ''));

        const important = getImportantFiles(tree);
        console.log(`\nSelected top ${important.length} files for deep inspection. Fetching contents...`);

        const contents = await fetchFileContents(parsed.owner, parsed.repo, important, token);
        contents.forEach(file => {
            console.log(`\n--- ${file.path} (${file.size} bytes) ---`);
            console.log(file.content.substring(0, 150) + "...\n");
        });
    }
}

run().catch(console.error);