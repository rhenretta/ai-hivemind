/**
 * sandboxManager.ts — Docker-Based Per-Feature Sandbox
 *
 * Each root feature task (identified by traceId) gets a dedicated Docker
 * container running the `ai-hivemind-sandbox:latest` image. Claude Code CLI
 * runs inside this container via `docker exec`, providing complete isolation
 * from the host filesystem and processes.
 *
 * Dev server ports inside the container are mapped to random host ports so
 * the QA agent can probe sandbox endpoints from the host.
 *
 * Container lifecycle:
 *   1. `docker create` — create a stopped container with resource limits + port mapping
 *   2. `docker start`  — start the container (runs `tail -f /dev/null` to stay alive)
 *   3. `docker cp`     — inject source code (~580KB tar) into /workspace/
 *   4. `docker exec`   — run `claude -p <prompt>` inside the container
 *   5. `docker cp`     — extract changed files after completion
 *   6. `docker rm -f`  — destroy the container
 *
 * The Docker image (`ai-hivemind-sandbox:latest`) has all dependencies
 * pre-installed via `pnpm install --frozen-lockfile`. Only source code is
 * injected per-task, keeping container creation fast.
 */

import { execSync, spawn, spawnSync, type ChildProcess } from 'node:child_process';
import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';

import { credentialStore } from './credentialStore.js';
import { logger } from './logger.js';

// ── Constants ─────────────────────────────────────────────────────────────────

const SANDBOX_IMAGE = 'ai-hivemind-sandbox:latest';
const CONTAINER_WORKDIR = '/workspace';
const CONTAINER_PREFIX = 'sandbox-';

export const MONOREPO_ROOT = process.env['MONOREPO_ROOT'] ??
    path.resolve(new URL('.', import.meta.url).pathname, '..', '..', '..', '..');

/** Source directories to inject into the container */
const SOURCE_DIRS = ['apps', 'packages'];

/** Root config files to inject */
const ROOT_FILES = [
    'package.json', 'pnpm-workspace.yaml', 'pnpm-lock.yaml',
    'tsconfig.json', 'turbo.json', 'CLAUDE.md',
];

/** Exclusion patterns for tar (same as rsync excludes) */
const TAR_EXCLUDES = ['node_modules', 'dist', '.next', '.turbo', '.cache', '.git'];

/** Patterns to skip when merging files back from container */
const MERGE_SKIP = ['node_modules', 'dist', '.next', '.turbo', '.cache'];

// ── Types ─────────────────────────────────────────────────────────────────────

export interface SandboxHandle {
    /** Docker container name, e.g. "sandbox-a1b2c3d4" */
    containerName: string;
    /** Working directory inside the container (always /workspace) */
    workDir: string;
    /** Port the Express backend listens on (same inside and outside container) */
    backendPort: number;
    /** Port the Next.js frontend listens on (same inside and outside container) */
    webPort: number;
    /** Legacy portMap for backward compat — keys === values (1:1 mapping) */
    portMap: Record<number, number>;
}

// ── Internal state ────────────────────────────────────────────────────────────

/** Map traceId → container name for idempotent lookups */
const activeContainers = new Map<string, string>();

// ── Port allocation ──────────────────────────────────────────────────────────

/**
 * Get a random available port by binding to port 0 and reading the OS-assigned port.
 * The server is closed immediately, making the port available for Docker to bind.
 */
function getAvailablePort(): Promise<number> {
    return new Promise((resolve, reject) => {
        const server = net.createServer();
        server.listen(0, '127.0.0.1', () => {
            const addr = server.address();
            if (addr === null || typeof addr === 'string') {
                server.close();
                reject(new Error('Failed to get available port'));
                return;
            }
            const port = addr.port;
            server.close(() => resolve(port));
        });
        server.on('error', reject);
    });
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Build the sandbox Docker image. Called once on backend startup.
 * Uses Dockerfile.sandbox at the monorepo root.
 *
 * The image layers are cached by Docker — subsequent builds are near-instant
 * unless package.json or pnpm-lock.yaml change.
 */
export function buildSandboxImage(): void {
    const dockerfile = path.join(MONOREPO_ROOT, 'Dockerfile.sandbox');
    if (!fs.existsSync(dockerfile)) {
        logger.warn('[SandboxManager] Dockerfile.sandbox not found — skipping image build');
        return;
    }

    logger.info('[SandboxManager] Building sandbox Docker image...');
    try {
        execSync(
            `docker build -f Dockerfile.sandbox -t ${SANDBOX_IMAGE} .`,
            {
                cwd: MONOREPO_ROOT,
                stdio: 'pipe',
                timeout: 5 * 60 * 1000, // 5 minutes for first build
            },
        );
        logger.info('[SandboxManager] Sandbox image built successfully');
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error(`[SandboxManager] Failed to build sandbox image: ${msg}`);
        throw new Error(`Sandbox image build failed: ${msg}`);
    }
}

/**
 * Create (or return existing) sandbox container for a feature.
 * Idempotent — safe to call multiple times with the same traceId.
 *
 * Steps:
 *   1. docker create with resource limits + port mapping
 *   2. docker start
 *   3. tar-pipe source code into /workspace/
 *
 * Returns a SandboxHandle with the container name and work directory.
 */
export async function createFeatureSandbox(traceId: string): Promise<SandboxHandle> {
    const existing = activeContainers.get(traceId);
    if (existing !== undefined) {
        // Verify container still exists and get port map
        try {
            execSync(`docker inspect ${existing}`, { stdio: 'pipe' });
            logger.info(`[SandboxManager] Reusing existing container for traceId=${traceId}`);
            const portMap = inspectPortMap(existing);
            // Derive backendPort/webPort from portMap (1:1, so keys === values)
            const ports = Object.keys(portMap).map(Number);
            const backendPort = ports.find(p => portMap[p] === p && p !== ports[0]) ?? ports[1] ?? 3001;
            const webPort = ports.find(p => p !== backendPort) ?? ports[0] ?? 3000;
            return { containerName: existing, workDir: CONTAINER_WORKDIR, backendPort, webPort, portMap };
        } catch {
            // Container was removed externally — recreate
            activeContainers.delete(traceId);
        }
    }

    const containerName = `${CONTAINER_PREFIX}${traceId.slice(0, 8)}`;

    // Remove any leftover container with the same name
    try {
        execSync(`docker rm -f ${containerName}`, { stdio: 'pipe' });
    } catch {
        // Container didn't exist — fine
    }

    // Pick random available ports — same port inside and outside the container (1:1 mapping).
    // This eliminates all port rewriting: host, container, QA, and frontend all use the same ports.
    const backendPort = await getAvailablePort();
    const webPort = await getAvailablePort();

    // 1. Create container with resource limits and 1:1 port mapping
    const claudeConfigDir = path.join(os.homedir(), '.claude');

    const createArgs = [
        'create',
        '--name', containerName,
        '--memory', '4g',
        '--cpus', '2',
        '-w', CONTAINER_WORKDIR,
    ];

    // 1:1 port mapping — same port inside and outside
    createArgs.push('-p', `${backendPort.toString()}:${backendPort.toString()}`);
    createArgs.push('-p', `${webPort.toString()}:${webPort.toString()}`);

    // Inject port env vars so apps listen on the correct ports
    createArgs.push('-e', `PORT=${backendPort.toString()}`);
    createArgs.push('-e', `BACKEND_PORT=${backendPort.toString()}`);
    createArgs.push('-e', `WEB_PORT=${webPort.toString()}`);
    // Tell the sandbox frontend where its own backend is (prevents it from
    // connecting to the main site's backend on port 3001).
    createArgs.push('-e', `NEXT_PUBLIC_NERVE_CENTER_URL=http://localhost:${backendPort.toString()}`);

    // Mount Claude auth config directory (contains backups, cache, session data).
    // Mounted to node user's home, not /root (container runs as non-root).
    // Read-write because the CLI needs to write temporary session state.
    if (fs.existsSync(claudeConfigDir)) {
        createArgs.push('-v', `${claudeConfigDir}:/home/node/.claude`);
    }

    // Mount the Claude config file (~/.claude.json) which stores auth credentials.
    // This is separate from the ~/.claude/ directory and is required for login.
    const claudeConfigFile = path.join(os.homedir(), '.claude.json');
    if (fs.existsSync(claudeConfigFile)) {
        createArgs.push('-v', `${claudeConfigFile}:/home/node/.claude.json`);
    }

    // Inject ALL user-configured service credentials as env vars.
    // This includes ANTHROPIC_API_KEY, OPENAI_API_KEY, and any other
    // keys stored via the Settings page. No more hard-coded env vars.
    try {
        const credentialEnvVars = credentialStore.getDecryptedEnvVars();
        for (const [envName, envValue] of Object.entries(credentialEnvVars)) {
            createArgs.push('-e', `${envName}=${envValue}`);
        }
        if (Object.keys(credentialEnvVars).length > 0) {
            logger.info(`[SandboxManager] Injected ${Object.keys(credentialEnvVars).length} credential env var(s) into container`);
        }
    } catch (err) {
        logger.warn(`[SandboxManager] Failed to inject credentials: ${String(err)}`);
    }

    createArgs.push(SANDBOX_IMAGE, 'tail', '-f', '/dev/null');

    logger.info(`[SandboxManager] Creating container ${containerName} for traceId=${traceId} (backend=${backendPort.toString()}, web=${webPort.toString()})`);
    // Use spawnSync with array args to avoid shell escaping issues
    // (API key may contain special characters like $ or !)
    const createResult = spawnSync('docker', createArgs, { stdio: 'pipe' });
    if (createResult.status !== 0) {
        const stderr = createResult.stderr?.toString() ?? '';
        throw new Error(`docker create failed: ${stderr}`);
    }

    // 2. Start the container
    execSync(`docker start ${containerName}`, { stdio: 'pipe' });

    // 3. Inject source code via tar
    injectSourceCode(containerName);

    // 4. Generate a config-only .env.local inside the container.
    //    The backend dev script requires --env-file=../../.env.local (tsx crashes
    //    with exit code 9 if the file is missing). We generate it with non-secret
    //    configuration only — API keys come from container env vars (injected by
    //    credentialStore above), NOT from the host .env.local file.
    try {
        const envContent = [
            '# Generated by SandboxManager — config only, no secrets',
            `PORT=${backendPort.toString()}`,
            `BACKEND_PORT=${backendPort.toString()}`,
            'BACKEND_CORS_ORIGIN=*',
            `OPENAI_HIGH_TIER_MODEL=${process.env['OPENAI_HIGH_TIER_MODEL'] ?? 'gpt-4o'}`,
            `OPENAI_LOW_TIER_MODEL=${process.env['OPENAI_LOW_TIER_MODEL'] ?? 'gpt-4o-mini'}`,
            `MAX_CONDUCTOR_MS=${process.env['MAX_CONDUCTOR_MS'] ?? '900000'}`,
            'NODE_ENV=development',
            `LOG_LEVEL=${process.env['LOG_LEVEL'] ?? 'info'}`,
        ].join('\n') + '\n';

        // Write to a temp file and docker cp (avoids shell escaping in heredocs)
        const tmpEnv = path.join(os.tmpdir(), `sandbox-env-${containerName}.env`);
        fs.writeFileSync(tmpEnv, envContent);
        execSync(
            `docker cp "${tmpEnv}" ${containerName}:${CONTAINER_WORKDIR}/.env.local`,
            { stdio: 'pipe', timeout: 5_000 },
        );
        execSync(
            `docker exec --user 0 ${containerName} chown node:node ${CONTAINER_WORKDIR}/.env.local`,
            { stdio: 'pipe', timeout: 5_000 },
        );
        fs.unlinkSync(tmpEnv);
        logger.info('[SandboxManager] Generated config-only .env.local in container');
    } catch (e) {
        logger.warn('[SandboxManager] Failed to generate .env.local:', e);
    }

    // 5. Build packages/shared inside the container so .d.ts files exist.
    //    Source injection copies source but tsbuildinfo can be stale (or absent),
    //    causing incremental compilation to skip .d.ts generation. A clean build
    //    here guarantees downstream packages (backend, web) can resolve types.
    try {
        execSync(
            `docker exec ${containerName} sh -c "cd ${CONTAINER_WORKDIR}/packages/shared && rm -f tsconfig.tsbuildinfo && npx tsc -p tsconfig.json"`,
            { stdio: 'pipe', timeout: 30_000 },
        );
        logger.info('[SandboxManager] Built packages/shared inside container');
    } catch (e) {
        logger.warn('[SandboxManager] Failed to build packages/shared:', e);
    }

    // 6. Inject Claude OAuth credentials from macOS Keychain.
    // On macOS, Claude Code stores creds in the Keychain and DELETES
    // ~/.claude/.credentials.json. On Linux (inside Docker), the CLI
    // reads from .credentials.json. We bridge this gap.
    injectClaudeCredentials(containerName);

    // 7. Port map is 1:1 — same ports inside and outside
    const portMap: Record<number, number> = {
        [backendPort]: backendPort,
        [webPort]: webPort,
    };

    activeContainers.set(traceId, containerName);
    logger.info(`[SandboxManager] Container ${containerName} ready (backend=${backendPort.toString()}, web=${webPort.toString()})`);

    return { containerName, workDir: CONTAINER_WORKDIR, backendPort, webPort, portMap };
}

/**
 * Get the sandbox handle for a traceId without creating it.
 * Returns null if no sandbox exists.
 */
export function getFeatureSandbox(traceId: string): SandboxHandle | null {
    const containerName = activeContainers.get(traceId);
    if (containerName === undefined) return null;
    const portMap = inspectPortMap(containerName);
    // Derive ports from 1:1 portMap (keys === values)
    const ports = Object.keys(portMap).map(Number);
    const backendPort = ports[1] ?? 3001;
    const webPort = ports[0] ?? 3000;
    return { containerName, workDir: CONTAINER_WORKDIR, backendPort, webPort, portMap };
}

/**
 * Spawn a process inside the sandbox container.
 * Returns a ChildProcess with stdout/stderr piped for streaming.
 *
 * This is the primary interface for conductor.ts to run Claude Code
 * inside the container.
 */
export function execInSandbox(
    handle: SandboxHandle,
    command: string,
    args: string[],
): ChildProcess {
    return spawn('docker', ['exec', handle.containerName, command, ...args], {
        stdio: ['ignore', 'pipe', 'pipe'],
    });
}

/**
 * Merge changed files from sandbox container back to the real monorepo.
 * Called when the entire feature has passed all QA.
 *
 * Strategy:
 *   1. Extract source dirs from container to a temp directory
 *   2. Walk the extracted tree, compare against real monorepo
 *   3. Copy only files that differ (by content)
 *   4. Clean up temp directory
 *
 * Returns list of merged file paths (relative to monorepo root).
 */
export async function mergeFeatureSandbox(traceId: string): Promise<string[]> {
    const containerName = activeContainers.get(traceId);
    if (containerName === undefined) {
        logger.info(`[SandboxManager] No container found for traceId=${traceId}`);
        return [];
    }

    const merged: string[] = [];
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sandbox-merge-'));

    try {
        // Extract source directories from container
        for (const dir of SOURCE_DIRS) {
            try {
                execSync(
                    `docker cp ${containerName}:${CONTAINER_WORKDIR}/${dir} ${tmpDir}/`,
                    { stdio: 'pipe' },
                );
            } catch {
                logger.warn(`[SandboxManager] Could not extract ${dir} from container`);
            }
        }

        // Extract root config files
        for (const file of ROOT_FILES) {
            try {
                execSync(
                    `docker cp ${containerName}:${CONTAINER_WORKDIR}/${file} ${tmpDir}/`,
                    { stdio: 'pipe' },
                );
            } catch {
                // File may not exist in container
            }
        }

        // Walk extracted dirs and merge changed files
        for (const dir of SOURCE_DIRS) {
            const extractedDir = path.join(tmpDir, dir);
            const realDir = path.join(MONOREPO_ROOT, dir);
            if (!fs.existsSync(extractedDir)) continue;
            walkAndMerge(extractedDir, realDir, dir + '/', merged);
        }

        // Check root config files for changes
        for (const file of ROOT_FILES) {
            const extractedFile = path.join(tmpDir, file);
            const realFile = path.join(MONOREPO_ROOT, file);
            if (!fs.existsSync(extractedFile)) continue;

            if (!fs.existsSync(realFile) || !filesEqual(extractedFile, realFile)) {
                fs.copyFileSync(extractedFile, realFile);
                merged.push(file);
                logger.info(`[SandboxManager] Merged: ${file}`);
            }
        }

        logger.info(`[SandboxManager] Merge complete: ${merged.length.toString()} file(s) changed`);
    } finally {
        // Clean up temp directory
        try {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        } catch {
            // Best-effort cleanup
        }
    }

    return merged;
}

/**
 * Destroy the sandbox container.
 * Called after merge completes (or on feature failure).
 */
export function destroyFeatureSandbox(traceId: string): void {
    // Try in-memory lookup first, fall back to derived name (survives restarts)
    const containerName = activeContainers.get(traceId)
        ?? `${CONTAINER_PREFIX}${traceId.slice(0, 8)}`;

    try {
        execSync(`docker rm -f ${containerName}`, { stdio: 'pipe' });
        logger.info(`[SandboxManager] Destroyed container: ${containerName}`);
    } catch (e) {
        logger.warn(`[SandboxManager] Failed to destroy container ${containerName}:`, e);
    }

    activeContainers.delete(traceId);
}

/**
 * Remove sandbox containers older than 24 hours.
 * Call on backend startup for crash recovery — stale containers
 * from killed processes won't pile up.
 */
export function cleanupStaleSandboxes(): void {
    try {
        const output = execSync(
            `docker ps -a --filter "name=${CONTAINER_PREFIX}" --format "{{.Names}}\t{{.CreatedAt}}"`,
            { stdio: 'pipe', encoding: 'utf8' },
        );

        const cutoff = Date.now() - 24 * 60 * 60 * 1000;
        const lines = output.trim().split('\n').filter(Boolean);

        for (const line of lines) {
            const parts = line.split('\t');
            const name = parts[0];
            const createdStr = parts[1];
            if (name === undefined || createdStr === undefined) continue;

            const createdMs = new Date(createdStr).getTime();
            if (Number.isNaN(createdMs) || createdMs >= cutoff) continue;

            try {
                execSync(`docker rm -f ${name}`, { stdio: 'pipe' });
                logger.info(`[SandboxManager] Cleaned up stale container: ${name}`);
            } catch {
                // Ignore individual container removal failures
            }
        }
    } catch {
        // Docker may not be available — silently skip cleanup
        logger.debug('[SandboxManager] Docker not available for stale container cleanup');
    }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Inject source code from the monorepo into the container's /workspace/.
 * Only source files are sent (~580KB). node_modules are already installed
 * in the Docker image.
 *
 * Uses a three-step process for cross-platform reliability:
 *   1. Create a tar archive on the host (with exclusions)
 *   2. docker cp the tar file into the container
 *   3. docker exec tar xf inside the container to extract
 *
 * This avoids `docker cp -` (stdin pipe) which is unreliable on some
 * platforms and Docker versions.
 */
function injectSourceCode(containerName: string): void {
    const excludeFlags = TAR_EXCLUDES.map(e => `--exclude=${e}`).join(' ');

    // Build the list of items to tar
    const tarItems: string[] = [];
    for (const dir of SOURCE_DIRS) {
        if (fs.existsSync(path.join(MONOREPO_ROOT, dir))) {
            tarItems.push(dir);
        }
    }
    for (const file of ROOT_FILES) {
        if (fs.existsSync(path.join(MONOREPO_ROOT, file))) {
            tarItems.push(file);
        }
    }

    if (tarItems.length === 0) {
        logger.warn('[SandboxManager] No source files found to inject');
        return;
    }

    const tmpTar = path.join(os.tmpdir(), `sandbox-src-${containerName}.tar`);

    try {
        // Step 1: Create tar archive on host filesystem
        execSync(
            `tar -cf "${tmpTar}" ${excludeFlags} -C "${MONOREPO_ROOT}" ${tarItems.join(' ')}`,
            { stdio: 'pipe', timeout: 30_000 },
        );

        // Step 2: Copy tar file into the container
        execSync(
            `docker cp "${tmpTar}" ${containerName}:/tmp/source.tar`,
            { stdio: 'pipe', timeout: 30_000 },
        );

        // Step 3: Extract tar inside the container, fix ownership, and clean up.
        // docker cp copies files as root, but the container runs as sandboxuser.
        // We exec as root (--user 0) to extract and chown, then sandboxuser owns everything.
        execSync(
            `docker exec --user 0 ${containerName} sh -c "tar xf /tmp/source.tar -C ${CONTAINER_WORKDIR} && chown -R node:node ${CONTAINER_WORKDIR} && rm /tmp/source.tar"`,
            { stdio: 'pipe', timeout: 60_000 },
        );

        logger.info(`[SandboxManager] Source code injected into ${containerName}`);
    } finally {
        // Always clean up the host temp file
        try { fs.unlinkSync(tmpTar); } catch { /* ignore */ }
    }
}

/**
 * Extract Claude OAuth credentials from macOS Keychain and write them
 * into the container as ~/.claude/.credentials.json.
 *
 * On macOS, Claude Code stores OAuth tokens in the Keychain (service:
 * "Claude Code-credentials", account: <username>) and DELETES the
 * file-based .credentials.json. On Linux (inside Docker), the CLI
 * reads from .credentials.json. This function bridges the gap.
 *
 * Safe to call on any platform — silently skips on Linux/Windows.
 */
export function injectClaudeCredentials(containerName: string): void {
    if (process.platform !== 'darwin') return;

    try {
        const username = os.userInfo().username;
        const raw = execSync(
            `security find-generic-password -s "Claude Code-credentials" -a "${username}" -w`,
            { stdio: 'pipe', encoding: 'utf8', timeout: 5000 },
        ).trim();

        // Validate it's parseable JSON with the expected structure
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        const oauth = parsed['claudeAiOauth'] as Record<string, unknown> | undefined;
        if (typeof oauth?.['accessToken'] !== 'string') {
            logger.warn('[SandboxManager] Keychain credential missing claudeAiOauth.accessToken');
            return;
        }

        // Write to a temp file on host, then docker-cp into the container.
        // Avoids shell-escaping issues with the JSON content.
        const tmpCreds = path.join(os.tmpdir(), `claude-creds-${containerName}.json`);
        try {
            fs.writeFileSync(tmpCreds, raw, { mode: 0o600 });
            execSync(
                `docker cp "${tmpCreds}" ${containerName}:/home/node/.claude/.credentials.json`,
                { stdio: 'pipe', timeout: 5000 },
            );
            // Fix ownership (docker cp writes as root)
            execSync(
                `docker exec --user 0 ${containerName} chown node:node /home/node/.claude/.credentials.json`,
                { stdio: 'pipe', timeout: 5000 },
            );
            logger.info('[SandboxManager] Injected Claude OAuth credentials from macOS Keychain');
        } finally {
            try { fs.unlinkSync(tmpCreds); } catch { /* ignore */ }
        }
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.debug(`[SandboxManager] Could not inject Keychain credentials: ${msg}`);
    }
}

/** Recursively walk extracted dir, copy changed/new files to real dir */
function walkAndMerge(extractedDir: string, realDir: string, relPrefix: string, merged: string[]): void {
    const entries = fs.readdirSync(extractedDir, { withFileTypes: true });
    for (const entry of entries) {
        const extractedPath = path.join(extractedDir, entry.name);
        const realPath = path.join(realDir, entry.name);
        const relPath = relPrefix + entry.name;

        // Skip node_modules, dist, .next, .turbo inside source dirs
        if (MERGE_SKIP.includes(entry.name)) continue;

        if (entry.isDirectory()) {
            walkAndMerge(extractedPath, realPath, relPath + '/', merged);
        } else if (entry.isFile()) {
            if (!fs.existsSync(realPath) || !filesEqual(extractedPath, realPath)) {
                // Ensure parent directory exists in real monorepo
                const parentDir = path.dirname(realPath);
                if (!fs.existsSync(parentDir)) {
                    fs.mkdirSync(parentDir, { recursive: true });
                }
                fs.copyFileSync(extractedPath, realPath);
                merged.push(relPath);
                logger.info(`[SandboxManager] Merged: ${relPath}`);
            }
        }
    }
}

/** Compare two files by content (Buffer.equals) */
function filesEqual(a: string, b: string): boolean {
    try {
        const bufA = fs.readFileSync(a);
        const bufB = fs.readFileSync(b);
        return bufA.equals(bufB);
    } catch {
        return false;
    }
}

/**
 * Inspect a running container's port mappings.
 * Returns a map of container port → host port.
 * E.g. { 3000: 49152, 3001: 49153 }
 */
function inspectPortMap(containerName: string): Record<number, number> {
    const portMap: Record<number, number> = {};
    try {
        const raw = execSync(
            `docker port ${containerName}`,
            { stdio: 'pipe', encoding: 'utf8' },
        ).trim();

        // Output format: "3000/tcp -> 0.0.0.0:49152"
        for (const line of raw.split('\n')) {
            const match = /^(\d+)\/tcp\s+->\s+[\d.]+:(\d+)/.exec(line);
            if (match !== null) {
                const containerPort = parseInt(match[1]!, 10);
                const hostPort = parseInt(match[2]!, 10);
                portMap[containerPort] = hostPort;
            }
        }
    } catch {
        // Container may not have port mappings
    }
    return portMap;
}
