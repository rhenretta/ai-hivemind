'use client';

import { KeyRound, Plus, Trash2, Shield, Loader2 } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';

const API_BASE = process.env['NEXT_PUBLIC_NERVE_CENTER_URL'] ?? 'http://localhost:3001';

interface MaskedCredential {
    id: string;
    serviceName: string;
    serviceLabel: string;
    credentialType: string;
    envVarName: string;
    maskedValue: string;
    createdAt: string;
    updatedAt: string;
}

export default function SettingsPage() {
    const [credentials, setCredentials] = useState<MaskedCredential[]>([]);
    const [loading, setLoading] = useState(true);
    const [showForm, setShowForm] = useState(false);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState<string | null>(null);

    // Form state
    const [serviceLabel, setServiceLabel] = useState('');
    const [serviceName, setServiceName] = useState('');
    const [envVarName, setEnvVarName] = useState('');
    const [value, setValue] = useState('');
    const [credentialType, setCredentialType] = useState('api_key');

    const fetchCredentials = useCallback(async () => {
        try {
            const res = await fetch(`${API_BASE}/api/credentials`);
            if (res.ok) {
                const data = (await res.json()) as MaskedCredential[];
                setCredentials(data);
            }
        } catch {
            // Backend may not be running
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => { void fetchCredentials(); }, [fetchCredentials]);

    // Auto-derive serviceName and envVarName from label
    const handleLabelChange = (label: string) => {
        setServiceLabel(label);
        const slug = label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
        setServiceName(slug);
        setEnvVarName(`${slug.toUpperCase()}_API_KEY`);
    };

    const handleSubmit = async () => {
        if (serviceLabel.trim() === '' || serviceName.trim() === '' || envVarName.trim() === '' || value.trim() === '') {
            setError('All fields are required');
            return;
        }
        setSaving(true);
        setError(null);
        try {
            const res = await fetch(`${API_BASE}/api/credentials`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    serviceName: serviceName.trim(),
                    serviceLabel: serviceLabel.trim(),
                    envVarName: envVarName.trim(),
                    value: value.trim(),
                    credentialType,
                }),
            });
            if (!res.ok) {
                const body = await res.text();
                setError(body !== '' ? body : 'Failed to save');
                return;
            }
            // Reset form and refresh
            setServiceLabel('');
            setServiceName('');
            setEnvVarName('');
            setValue('');
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
            await fetch(`${API_BASE}/api/credentials/${id}`, { method: 'DELETE' });
            await fetchCredentials();
        } catch {
            // Ignore
        }
    };

    return (
        <div className="flex-1 overflow-y-auto p-6">
            <div className="max-w-2xl mx-auto space-y-6">
                {/* Header */}
                <div>
                    <h1 className="text-xl font-semibold text-foreground flex items-center gap-2">
                        <Shield className="w-5 h-5 text-primary" />
                        Settings
                    </h1>
                    <p className="text-sm text-muted-foreground mt-1">
                        Manage API keys and service credentials available to agents.
                    </p>
                </div>

                {/* Service credentials section */}
                <div className="rounded-xl border border-border/50 bg-card overflow-hidden">
                    <div className="flex items-center justify-between px-4 py-3 border-b border-border/50">
                        <h2 className="text-sm font-medium text-foreground flex items-center gap-2">
                            <KeyRound className="w-4 h-4 text-muted-foreground" />
                            Service Credentials
                        </h2>
                        <button
                            onClick={() => setShowForm(!showForm)}
                            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg bg-primary text-primary-foreground hover:bg-primary/90 transition-colors"
                        >
                            <Plus className="w-3.5 h-3.5" />
                            Add Key
                        </button>
                    </div>

                    {/* Add form */}
                    {showForm && (
                        <div className="px-4 py-4 border-b border-border/50 bg-secondary/20 space-y-3">
                            <div className="grid grid-cols-2 gap-3">
                                <div>
                                    <label className="block text-xs text-muted-foreground mb-1">Service Name</label>
                                    <input
                                        type="text"
                                        value={serviceLabel}
                                        onChange={(e) => handleLabelChange(e.target.value)}
                                        placeholder="e.g. OpenAI"
                                        className="w-full px-3 py-2 text-sm bg-background border border-border/50 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary/50"
                                    />
                                </div>
                                <div>
                                    <label className="block text-xs text-muted-foreground mb-1">Type</label>
                                    <select
                                        value={credentialType}
                                        onChange={(e) => setCredentialType(e.target.value)}
                                        className="w-full px-3 py-2 text-sm bg-background border border-border/50 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary/50"
                                    >
                                        <option value="api_key">API Key</option>
                                        <option value="oauth_token">OAuth Token</option>
                                        <option value="secret">Secret</option>
                                    </select>
                                </div>
                            </div>
                            <div>
                                <label className="block text-xs text-muted-foreground mb-1">
                                    Environment Variable
                                    <span className="text-muted-foreground/60 ml-1">(agents access keys via this env var)</span>
                                </label>
                                <input
                                    type="text"
                                    value={envVarName}
                                    onChange={(e) => setEnvVarName(e.target.value)}
                                    placeholder="e.g. OPENAI_API_KEY"
                                    className="w-full px-3 py-2 text-sm font-mono bg-background border border-border/50 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary/50"
                                />
                            </div>
                            <div>
                                <label className="block text-xs text-muted-foreground mb-1">API Key / Secret</label>
                                <input
                                    type="password"
                                    value={value}
                                    onChange={(e) => setValue(e.target.value)}
                                    placeholder="sk-..."
                                    className="w-full px-3 py-2 text-sm font-mono bg-background border border-border/50 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary/50"
                                />
                            </div>
                            {error !== null && (
                                <p className="text-xs text-red-400">{error}</p>
                            )}
                            <div className="flex gap-2 justify-end">
                                <button
                                    onClick={() => { setShowForm(false); setError(null); }}
                                    className="px-3 py-1.5 text-xs font-medium rounded-lg border border-border text-muted-foreground hover:text-foreground transition-colors"
                                >
                                    Cancel
                                </button>
                                <button
                                    onClick={() => void handleSubmit()}
                                    disabled={saving}
                                    className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50 transition-colors"
                                >
                                    {saving && <Loader2 className="w-3 h-3 animate-spin" />}
                                    Save
                                </button>
                            </div>
                        </div>
                    )}

                    {/* Credential list */}
                    {loading ? (
                        <div className="flex items-center justify-center py-8">
                            <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />
                        </div>
                    ) : credentials.length === 0 ? (
                        <div className="px-4 py-8 text-center">
                            <p className="text-sm text-muted-foreground">
                                No credentials configured. Add API keys so agents can use external services.
                            </p>
                        </div>
                    ) : (
                        <div className="divide-y divide-border/30">
                            {credentials.map((cred) => (
                                <div key={cred.id} className="flex items-center gap-3 px-4 py-3">
                                    <div className="flex-1 min-w-0">
                                        <div className="flex items-center gap-2">
                                            <span className="text-sm font-medium text-foreground">{cred.serviceLabel}</span>
                                            <span className="text-[10px] px-1.5 py-0.5 rounded bg-secondary/60 text-muted-foreground">
                                                {cred.credentialType}
                                            </span>
                                        </div>
                                        <div className="flex items-center gap-2 mt-0.5">
                                            <code className="text-xs text-muted-foreground font-mono">{cred.envVarName}</code>
                                            <span className="text-xs text-muted-foreground/50">
                                                ****{cred.maskedValue}
                                            </span>
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
                        </div>
                    )}
                </div>

                {/* Info card */}
                <div className="rounded-xl border border-border/30 bg-secondary/10 px-4 py-3">
                    <p className="text-xs text-muted-foreground leading-relaxed">
                        Credentials are encrypted with AES-256-GCM and stored locally.
                        Agents see only the service name and env var — never the raw key.
                        The SWE agent receives the decrypted value as an environment variable
                        inside the sandbox so it can make API calls.
                    </p>
                </div>
            </div>
        </div>
    );
}
