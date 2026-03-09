'use client';

import {
    type SystemEvent,
    type SessionArtifacts,
    type SweArtifactEntry,
    type QaVerdictSummary,
} from '@ai-hivemind/shared';
import {
    Box,
    CheckCircle,
    ChevronDown,
    ChevronRight,
    Clock,
    Code,
    ExternalLink,
    FileText,
    FlaskConical,
    GitBranch,
    KeyRound,
    Loader2,
    Package,
    Plus,
    Search,
    Trash2,
    XCircle,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { type SessionEntry } from '@/stores/sessionStore';

const NERVE_CENTER_URL =
    process.env['NEXT_PUBLIC_NERVE_CENTER_URL'] ?? 'http://localhost:3001';

// ── Status badge colors ─────────────────────────────────────────────────────

const STATUS_COLOR: Record<string, string> = {
    exploring: 'bg-blue-500/20 text-blue-400',
    planning: 'bg-indigo-500/20 text-indigo-400',
    active: 'bg-amber-500/20 text-amber-400',
    blocked: 'bg-orange-500/20 text-orange-400',
    completed: 'bg-emerald-500/20 text-emerald-400',
    failed: 'bg-red-500/20 text-red-400',
};

// ── Helpers ──────────────────────────────────────────────────────────────────

function formatDate(iso: string): string {
    try {
        return new Date(iso).toLocaleString();
    } catch {
        return iso;
    }
}

function StatusBadge({ status }: { status: string }) {
    return (
        <span className={`px-2 py-0.5 text-xs font-medium rounded-full capitalize ${STATUS_COLOR[status] ?? 'bg-gray-500/20 text-gray-400'}`}>
            {status}
        </span>
    );
}

// ── Props ────────────────────────────────────────────────────────────────────

interface DetailsTabProps {
    sessionId: string;
    session: SessionEntry;
    events: SystemEvent[];
}

// ── Component ────────────────────────────────────────────────────────────────

export function DetailsTab({ sessionId, session, events }: DetailsTabProps) {
    const [artifacts, setArtifacts] = useState<SessionArtifacts | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        setLoading(true);
        setError(null);
        fetch(`${NERVE_CENTER_URL}/api/sessions/${sessionId}/artifacts`)
            .then((r) => {
                if (!r.ok) throw new Error(`HTTP ${r.status}`);
                return r.json() as Promise<SessionArtifacts>;
            })
            .then((data) => { setArtifacts(data); setLoading(false); })
            .catch((err: unknown) => { setError(String(err)); setLoading(false); });
    }, [sessionId]);

    // QA verdicts from live event stream (always up-to-date)
    const qaVerdicts = useMemo(() => {
        return events
            .filter((e) => e.eventType === 'QA_VERDICT')
            .map((e): QaVerdictSummary => ({
                eventId: e.eventId,
                timestamp: e.timestamp,
                subtask: typeof e.payload['subtask'] === 'string' ? e.payload['subtask'] : '',
                passed: e.payload['passed'] === true,
                issues: Array.isArray(e.payload['issues']) ? e.payload['issues'] as string[] : [],
                warnings: Array.isArray(e.payload['warnings']) ? e.payload['warnings'] as string[] : [],
                summary: typeof e.payload['summary'] === 'string' ? e.payload['summary'] : undefined,
                checksRun: Array.isArray(e.payload['checksRun']) ? e.payload['checksRun'] as string[] : [],
            }));
    }, [events]);

    return (
        <div className="overflow-y-auto p-6 space-y-6 max-w-3xl">
            {/* Section 1: Session Metadata */}
            <MetadataSection session={session} />

            {/* Section 2: Sandbox Status */}
            <SandboxSection sandbox={artifacts?.sandbox ?? null} loading={loading} />

            {/* Section 2.5: Session Environment Variables */}
            <EnvVarsSection sessionId={sessionId} />

            {/* Section 3: Active Task */}
            {artifacts?.taskState !== null && artifacts?.taskState !== undefined && (
                <TaskStateSection taskState={artifacts.taskState} />
            )}

            {/* Section 4: Code Changes */}
            <SweArtifactsSection
                artifacts={artifacts?.sweArtifacts ?? []}
                loading={loading}
                error={error}
            />

            {/* Section 5: Research Findings */}
            <ResearchSection
                findings={artifacts?.researchFindings ?? []}
                loading={loading}
            />

            {/* Section 6: QA Results */}
            <QaSection verdicts={qaVerdicts} />
        </div>
    );
}

// ── Section Components ──────────────────────────────────────────────────────

function SectionCard({ title, icon, children }: { title: string; icon: React.ReactNode; children: React.ReactNode }) {
    return (
        <div className="rounded-lg border border-border/50 bg-card">
            <div className="flex items-center gap-2 px-4 py-3 border-b border-border/50">
                {icon}
                <h3 className="text-sm font-medium text-foreground">{title}</h3>
            </div>
            <div className="p-4">
                {children}
            </div>
        </div>
    );
}

function MetadataSection({ session }: { session: SessionEntry }) {
    return (
        <SectionCard title="Session Info" icon={<FileText className="w-4 h-4 text-muted-foreground" />}>
            <div className="space-y-3">
                <div className="flex items-center justify-between">
                    <span className="text-sm text-muted-foreground">Status</span>
                    <StatusBadge status={session.status} />
                </div>
                <div className="flex items-center justify-between">
                    <span className="text-sm text-muted-foreground">Created</span>
                    <span className="text-sm text-foreground">{formatDate(session.createdAt)}</span>
                </div>
                <div className="flex items-center justify-between">
                    <span className="text-sm text-muted-foreground">Updated</span>
                    <span className="text-sm text-foreground">{formatDate(session.updatedAt)}</span>
                </div>

                {session.stepsTotal > 0 && (
                    <div className="flex items-center justify-between">
                        <span className="text-sm text-muted-foreground">Progress</span>
                        <span className="text-sm text-foreground">
                            {session.stepsComplete} / {session.stepsTotal} steps
                        </span>
                    </div>
                )}

                {session.repoConfig !== null && (
                    <div className="mt-3 pt-3 border-t border-border/50 space-y-2">
                        <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground uppercase tracking-wider">
                            <GitBranch className="w-3 h-3" />
                            Repository
                        </div>
                        <div className="flex items-center gap-2">
                            <a
                                href={session.repoConfig.url}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="text-sm text-primary hover:underline flex items-center gap-1"
                            >
                                {session.repoConfig.url}
                                <ExternalLink className="w-3 h-3" />
                            </a>
                        </div>
                        <div className="text-xs text-muted-foreground">
                            Branch: {session.repoConfig.defaultBranch}
                        </div>
                    </div>
                )}

                {session.projectProfile !== null && (
                    <div className="mt-3 pt-3 border-t border-border/50 space-y-2">
                        <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground uppercase tracking-wider">
                            <Package className="w-3 h-3" />
                            Project Profile
                        </div>
                        <div className="grid grid-cols-2 gap-2 text-sm">
                            <div>
                                <span className="text-muted-foreground">Package Manager: </span>
                                <span className="text-foreground">{session.projectProfile.packageManager}</span>
                            </div>
                            {session.projectProfile.framework !== undefined && (
                                <div>
                                    <span className="text-muted-foreground">Framework: </span>
                                    <span className="text-foreground">{session.projectProfile.framework}</span>
                                </div>
                            )}
                            {session.projectProfile.language !== undefined && (
                                <div>
                                    <span className="text-muted-foreground">Language: </span>
                                    <span className="text-foreground">{session.projectProfile.language}</span>
                                </div>
                            )}
                            {session.projectProfile.monorepo && (
                                <div className="text-foreground">Monorepo</div>
                            )}
                        </div>
                        {session.projectProfile.devCommand !== undefined && (
                            <div className="text-xs">
                                <span className="text-muted-foreground">Dev: </span>
                                <code className="text-foreground bg-secondary/50 px-1 py-0.5 rounded">
                                    {session.projectProfile.devCommand}
                                </code>
                            </div>
                        )}
                        {session.projectProfile.buildCommand !== undefined && (
                            <div className="text-xs">
                                <span className="text-muted-foreground">Build: </span>
                                <code className="text-foreground bg-secondary/50 px-1 py-0.5 rounded">
                                    {session.projectProfile.buildCommand}
                                </code>
                            </div>
                        )}
                    </div>
                )}
            </div>
        </SectionCard>
    );
}

function SandboxSection({ sandbox, loading }: { sandbox: SessionArtifacts['sandbox']; loading: boolean }) {
    return (
        <SectionCard title="Sandbox" icon={<Box className="w-4 h-4 text-muted-foreground" />}>
            {loading ? (
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                    <Loader2 className="w-4 h-4 animate-spin" />
                    Loading...
                </div>
            ) : sandbox === null ? (
                <p className="text-sm text-muted-foreground">No sandbox active for this session.</p>
            ) : (
                <div className="space-y-2">
                    <div className="flex items-center gap-2">
                        <span className={`w-2 h-2 rounded-full ${sandbox.running ? 'bg-emerald-400' : 'bg-gray-500'}`} />
                        <code className="text-sm text-foreground">{sandbox.containerName}</code>
                        <span className="text-xs text-muted-foreground">
                            {sandbox.running ? 'Running' : 'Stopped'}
                        </span>
                    </div>
                    <div className="flex gap-4 text-xs text-muted-foreground">
                        <span>Backend: <code className="text-foreground">:{sandbox.backendPort}</code></span>
                        <span>Web: <code className="text-foreground">:{sandbox.webPort}</code></span>
                    </div>
                </div>
            )}
        </SectionCard>
    );
}

interface MaskedCredential {
    id: string;
    serviceName: string;
    serviceLabel: string;
    credentialType: string;
    envVarName: string;
    maskedValue: string;
}

function EnvVarsSection({ sessionId }: { sessionId: string }) {
    const [credentials, setCredentials] = useState<MaskedCredential[]>([]);
    const [loading, setLoading] = useState(true);
    const [showForm, setShowForm] = useState(false);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState<string | null>(null);

    // Form state
    const [envVarName, setEnvVarName] = useState('');
    const [value, setValue] = useState('');
    const [serviceLabel, setServiceLabel] = useState('');

    const fetchCredentials = useCallback(async () => {
        try {
            const res = await fetch(`${NERVE_CENTER_URL}/api/sessions/${sessionId}/credentials`);
            if (res.ok) {
                const data = (await res.json()) as MaskedCredential[];
                setCredentials(data);
            }
        } catch {
            // Backend may not be running
        } finally {
            setLoading(false);
        }
    }, [sessionId]);

    useEffect(() => { void fetchCredentials(); }, [fetchCredentials]);

    const handleSubmit = async () => {
        const trimmedName = envVarName.trim();
        const trimmedValue = value.trim();
        if (trimmedName === '' || trimmedValue === '') {
            setError('Variable name and value are required');
            return;
        }
        setSaving(true);
        setError(null);
        try {
            const res = await fetch(`${NERVE_CENTER_URL}/api/sessions/${sessionId}/credentials`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    envVarName: trimmedName,
                    value: trimmedValue,
                    serviceLabel: serviceLabel.trim() !== '' ? serviceLabel.trim() : trimmedName,
                    serviceName: trimmedName.toLowerCase(),
                }),
            });
            if (!res.ok) {
                const body = await res.text();
                setError(body !== '' ? body : 'Failed to save');
                return;
            }
            setEnvVarName('');
            setValue('');
            setServiceLabel('');
            setShowForm(false);
            await fetchCredentials();
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Network error');
        } finally {
            setSaving(false);
        }
    };

    const handleDelete = async (id: string) => {
        try {
            await fetch(`${NERVE_CENTER_URL}/api/sessions/${sessionId}/credentials/${id}`, { method: 'DELETE' });
            await fetchCredentials();
        } catch {
            // Ignore
        }
    };

    return (
        <div className="rounded-lg border border-border/50 bg-card">
            <div className="flex items-center justify-between px-4 py-3 border-b border-border/50">
                <div className="flex items-center gap-2">
                    <KeyRound className="w-4 h-4 text-muted-foreground" />
                    <h3 className="text-sm font-medium text-foreground">Environment Variables</h3>
                </div>
                <button
                    onClick={() => setShowForm(!showForm)}
                    className="flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium rounded-lg bg-primary text-primary-foreground hover:bg-primary/90 transition-colors"
                >
                    <Plus className="w-3 h-3" />
                    Add
                </button>
            </div>

            {/* Add form */}
            {showForm && (
                <div className="px-4 py-3 border-b border-border/50 bg-secondary/20 space-y-2.5">
                    <div>
                        <label className="block text-xs text-muted-foreground mb-1">Variable Name</label>
                        <input
                            type="text"
                            value={envVarName}
                            onChange={(e) => setEnvVarName(e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, ''))}
                            placeholder="e.g. GITHUB_TOKEN"
                            className="w-full px-3 py-1.5 text-sm font-mono bg-background border border-border/50 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary/50"
                        />
                    </div>
                    <div>
                        <label className="block text-xs text-muted-foreground mb-1">Value</label>
                        <input
                            type="password"
                            value={value}
                            onChange={(e) => setValue(e.target.value)}
                            placeholder="Secret value..."
                            className="w-full px-3 py-1.5 text-sm font-mono bg-background border border-border/50 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary/50"
                        />
                    </div>
                    <div>
                        <label className="block text-xs text-muted-foreground mb-1">
                            Label <span className="text-muted-foreground/60">(optional)</span>
                        </label>
                        <input
                            type="text"
                            value={serviceLabel}
                            onChange={(e) => setServiceLabel(e.target.value)}
                            placeholder="e.g. GitHub Access Token"
                            className="w-full px-3 py-1.5 text-sm bg-background border border-border/50 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary/50"
                        />
                    </div>
                    {error !== null && (
                        <p className="text-xs text-red-400">{error}</p>
                    )}
                    <div className="flex gap-2 justify-end">
                        <button
                            onClick={() => { setShowForm(false); setError(null); }}
                            className="px-3 py-1 text-xs font-medium rounded-lg border border-border text-muted-foreground hover:text-foreground transition-colors"
                        >
                            Cancel
                        </button>
                        <button
                            onClick={() => void handleSubmit()}
                            disabled={saving}
                            className="flex items-center gap-1.5 px-3 py-1 text-xs font-medium rounded-lg bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50 transition-colors"
                        >
                            {saving && <Loader2 className="w-3 h-3 animate-spin" />}
                            Save
                        </button>
                    </div>
                </div>
            )}

            <div className="p-4">
                {loading ? (
                    <div className="flex items-center gap-2 text-sm text-muted-foreground">
                        <Loader2 className="w-4 h-4 animate-spin" />
                        Loading...
                    </div>
                ) : credentials.length === 0 ? (
                    <p className="text-sm text-muted-foreground">
                        No session-specific env vars. Add variables that will be injected into this session&apos;s sandbox only.
                    </p>
                ) : (
                    <div className="space-y-2">
                        {credentials.map((cred) => (
                            <div key={cred.id} className="flex items-center gap-3 rounded-md bg-secondary/20 px-3 py-2">
                                <div className="flex-1 min-w-0">
                                    <code className="text-sm font-mono text-foreground">{cred.envVarName}</code>
                                    <div className="flex items-center gap-2 mt-0.5">
                                        {cred.serviceLabel !== cred.envVarName && (
                                            <span className="text-xs text-muted-foreground">{cred.serviceLabel}</span>
                                        )}
                                        <span className="text-xs text-muted-foreground/50">{cred.maskedValue}</span>
                                    </div>
                                </div>
                                <button
                                    onClick={() => void handleDelete(cred.id)}
                                    className="p-1.5 rounded-lg text-muted-foreground hover:text-red-400 hover:bg-red-500/10 transition-colors"
                                    title="Delete"
                                >
                                    <Trash2 className="w-3.5 h-3.5" />
                                </button>
                            </div>
                        ))}
                        <p className="text-[11px] text-muted-foreground/60 pt-1">
                            Session variables override global credentials for the same name. Encrypted at rest.
                        </p>
                    </div>
                )}
            </div>
        </div>
    );
}

function TaskStateSection({ taskState }: { taskState: NonNullable<SessionArtifacts['taskState']> }) {
    return (
        <SectionCard title="Active Task" icon={<Loader2 className="w-4 h-4 text-amber-400 animate-spin" />}>
            <div className="space-y-2">
                <div className="flex items-center gap-2">
                    <StatusBadge status={taskState.phase} />
                    <span className="text-xs text-muted-foreground">Attempt #{taskState.attempt}</span>
                </div>
                <p className="text-sm text-foreground">{taskState.objective}</p>
                {taskState.filesChanged.length > 0 && (
                    <div className="text-xs text-muted-foreground">
                        {taskState.filesChanged.length} file{taskState.filesChanged.length !== 1 ? 's' : ''} changed
                    </div>
                )}
            </div>
        </SectionCard>
    );
}

function SweArtifactsSection({
    artifacts,
    loading,
    error,
}: {
    artifacts: SweArtifactEntry[];
    loading: boolean;
    error: string | null;
}) {
    if (loading) {
        return (
            <SectionCard title="Code Changes" icon={<Code className="w-4 h-4 text-muted-foreground" />}>
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                    <Loader2 className="w-4 h-4 animate-spin" />
                    Loading...
                </div>
            </SectionCard>
        );
    }
    if (error !== null) {
        return (
            <SectionCard title="Code Changes" icon={<Code className="w-4 h-4 text-muted-foreground" />}>
                <p className="text-sm text-red-400">Failed to load: {error}</p>
            </SectionCard>
        );
    }
    if (artifacts.length === 0) {
        return (
            <SectionCard title="Code Changes" icon={<Code className="w-4 h-4 text-muted-foreground" />}>
                <p className="text-sm text-muted-foreground">No code changes recorded yet.</p>
            </SectionCard>
        );
    }

    return (
        <SectionCard title={`Code Changes (${artifacts.length})`} icon={<Code className="w-4 h-4 text-muted-foreground" />}>
            <div className="space-y-3">
                {artifacts.map((entry) => (
                    <SweArtifactCard key={entry.memoryId} entry={entry} />
                ))}
            </div>
        </SectionCard>
    );
}

function SweArtifactCard({ entry }: { entry: SweArtifactEntry }) {
    const [expanded, setExpanded] = useState(false);
    const artifact = entry.artifact as { subtask?: string; filesChanged?: string[]; commandsRun?: string[]; errors?: string[]; success?: boolean; summary?: string } | null;

    return (
        <div className="rounded-md border border-border/30 bg-secondary/20">
            <button
                onClick={() => setExpanded(!expanded)}
                className="w-full flex items-center gap-2 px-3 py-2 text-left"
            >
                {expanded ? <ChevronDown className="w-3.5 h-3.5 text-muted-foreground shrink-0" /> : <ChevronRight className="w-3.5 h-3.5 text-muted-foreground shrink-0" />}
                <span className="text-sm text-foreground flex-1 line-clamp-1">
                    {artifact?.subtask ?? 'Code change'}
                </span>
                {artifact?.success !== undefined && (
                    artifact.success
                        ? <CheckCircle className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                        : <XCircle className="w-3.5 h-3.5 text-red-400 shrink-0" />
                )}
                {artifact?.filesChanged !== undefined && (
                    <span className="text-xs text-muted-foreground shrink-0">
                        {artifact.filesChanged.length} file{artifact.filesChanged.length !== 1 ? 's' : ''}
                    </span>
                )}
                <span className="text-xs text-muted-foreground shrink-0">
                    <Clock className="w-3 h-3 inline mr-0.5" />
                    {formatDate(entry.timestamp)}
                </span>
            </button>

            {expanded && artifact !== null && (
                <div className="px-3 pb-3 space-y-2 border-t border-border/30 pt-2">
                    {artifact.summary !== undefined && (
                        <p className="text-xs text-foreground">{artifact.summary}</p>
                    )}
                    {artifact.filesChanged !== undefined && artifact.filesChanged.length > 0 && (
                        <div>
                            <span className="text-xs font-medium text-muted-foreground">Files:</span>
                            <ul className="mt-1 space-y-0.5">
                                {artifact.filesChanged.map((f, i) => (
                                    <li key={i} className="text-xs text-foreground font-mono">{f}</li>
                                ))}
                            </ul>
                        </div>
                    )}
                    {artifact.errors !== undefined && artifact.errors.length > 0 && (
                        <div>
                            <span className="text-xs font-medium text-red-400">Errors:</span>
                            <ul className="mt-1 space-y-0.5">
                                {artifact.errors.map((e, i) => (
                                    <li key={i} className="text-xs text-red-300 font-mono">{e}</li>
                                ))}
                            </ul>
                        </div>
                    )}
                </div>
            )}
        </div>
    );
}

function ResearchSection({
    findings,
    loading,
}: {
    findings: SessionArtifacts['researchFindings'];
    loading: boolean;
}) {
    if (loading) {
        return (
            <SectionCard title="Research Findings" icon={<Search className="w-4 h-4 text-muted-foreground" />}>
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                    <Loader2 className="w-4 h-4 animate-spin" />
                    Loading...
                </div>
            </SectionCard>
        );
    }
    if (findings.length === 0) {
        return (
            <SectionCard title="Research Findings" icon={<Search className="w-4 h-4 text-muted-foreground" />}>
                <p className="text-sm text-muted-foreground">No research findings recorded yet.</p>
            </SectionCard>
        );
    }

    return (
        <SectionCard title={`Research Findings (${findings.length})`} icon={<Search className="w-4 h-4 text-muted-foreground" />}>
            <div className="space-y-3">
                {findings.map((finding) => (
                    <ResearchCard key={finding.memoryId} finding={finding} />
                ))}
            </div>
        </SectionCard>
    );
}

function ResearchCard({ finding }: { finding: SessionArtifacts['researchFindings'][number] }) {
    const [expanded, setExpanded] = useState(false);
    const isLong = finding.content.length > 200;

    return (
        <div className="rounded-md border border-border/30 bg-secondary/20 p-3 space-y-2">
            <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                    <span className="text-xs text-muted-foreground">{finding.agentId}</span>
                    <span className="text-xs text-muted-foreground">{formatDate(finding.timestamp)}</span>
                </div>
                {finding.tags.length > 0 && (
                    <div className="flex gap-1">
                        {finding.tags.map((tag) => (
                            <span key={tag} className="px-1.5 py-0.5 text-[10px] rounded bg-primary/10 text-primary">
                                {tag}
                            </span>
                        ))}
                    </div>
                )}
            </div>
            <p className={`text-xs text-foreground whitespace-pre-wrap ${!expanded && isLong ? 'line-clamp-3' : ''}`}>
                {finding.content}
            </p>
            {isLong && (
                <button
                    onClick={() => setExpanded(!expanded)}
                    className="text-xs text-primary hover:underline"
                >
                    {expanded ? 'Show less' : 'Show more'}
                </button>
            )}
        </div>
    );
}

function QaSection({ verdicts }: { verdicts: QaVerdictSummary[] }) {
    if (verdicts.length === 0) {
        return (
            <SectionCard title="QA Results" icon={<FlaskConical className="w-4 h-4 text-muted-foreground" />}>
                <p className="text-sm text-muted-foreground">No QA results yet.</p>
            </SectionCard>
        );
    }

    return (
        <SectionCard title={`QA Results (${verdicts.length})`} icon={<FlaskConical className="w-4 h-4 text-muted-foreground" />}>
            <div className="space-y-3">
                {verdicts.map((verdict) => (
                    <div key={verdict.eventId} className="rounded-md border border-border/30 bg-secondary/20 p-3 space-y-2">
                        <div className="flex items-center justify-between">
                            <div className="flex items-center gap-2">
                                {verdict.passed
                                    ? <CheckCircle className="w-4 h-4 text-emerald-400" />
                                    : <XCircle className="w-4 h-4 text-red-400" />}
                                <span className="text-sm text-foreground">
                                    {verdict.passed ? 'Passed' : 'Failed'}
                                </span>
                            </div>
                            <span className="text-xs text-muted-foreground">{formatDate(verdict.timestamp)}</span>
                        </div>

                        {verdict.subtask !== '' && (
                            <p className="text-xs text-muted-foreground">{verdict.subtask}</p>
                        )}

                        {verdict.summary !== undefined && (
                            <p className="text-xs text-foreground">{verdict.summary}</p>
                        )}

                        {verdict.issues.length > 0 && (
                            <div>
                                <span className="text-xs font-medium text-red-400">Issues:</span>
                                <ul className="mt-1 space-y-0.5">
                                    {verdict.issues.map((issue, i) => (
                                        <li key={i} className="text-xs text-red-300">{issue}</li>
                                    ))}
                                </ul>
                            </div>
                        )}

                        {verdict.warnings.length > 0 && (
                            <div>
                                <span className="text-xs font-medium text-amber-400">Warnings:</span>
                                <ul className="mt-1 space-y-0.5">
                                    {verdict.warnings.map((w, i) => (
                                        <li key={i} className="text-xs text-amber-300">{w}</li>
                                    ))}
                                </ul>
                            </div>
                        )}

                        {verdict.checksRun.length > 0 && (
                            <div className="text-xs text-muted-foreground">
                                {verdict.checksRun.length} check{verdict.checksRun.length !== 1 ? 's' : ''} run
                            </div>
                        )}
                    </div>
                ))}
            </div>
        </SectionCard>
    );
}
