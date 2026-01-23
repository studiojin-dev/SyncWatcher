import { IconBrandGithub, IconExternalLink, IconUser, IconVersions } from '@tabler/icons-react';

export interface LicenseData {
    name: string;
    version: string;
    license: string;
    repository?: string | { url: string };
    url?: string;
    author?: string;
}

interface LicenseCardProps {
    data: LicenseData;
}

export function LicenseCard({ data }: LicenseCardProps) {
    const repoUrl = data.url || (typeof data.repository === 'string' ? data.repository : data.repository?.url);
    const hasUrl = !!repoUrl;

    return (
        <div className="bg-[var(--bg-primary)] border-2 border-[var(--border-main)] p-4 shadow-[2px_2px_0_0_var(--shadow-color)] hover:translate-x-[-1px] hover:translate-y-[-1px] hover:shadow-[3px_3px_0_0_var(--shadow-color)] transition-all">
            <div className="flex justify-between items-start mb-2">
                <h3 className="font-bold text-lg leading-tight break-all">
                    {data.name}
                </h3>
                <span className="text-xs font-mono px-2 py-1 bg-[var(--bg-tertiary)] border border-[var(--border-main)] whitespace-nowrap">
                    {data.license || 'Unknown'}
                </span>
            </div>

            <div className="space-y-1 text-sm text-[var(--text-secondary)]">
                {data.version && (
                    <div className="flex items-center gap-2">
                        <IconVersions size={14} />
                        <span className="font-mono text-xs">{data.version}</span>
                    </div>
                )}

                {data.author && (
                    <div className="flex items-center gap-2">
                        <IconUser size={14} />
                        <span className="truncate">{data.author}</span>
                    </div>
                )}

                {hasUrl && (
                    <a
                        href={repoUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="flex items-center gap-2 text-[var(--accent-main)] hover:underline mt-2 inline-block max-w-full truncate"
                    >
                        {repoUrl.includes('github.com') ? <IconBrandGithub size={14} /> : <IconExternalLink size={14} />}
                        <span className="truncate">{repoUrl}</span>
                    </a>
                )}
            </div>
        </div>
    );
}
