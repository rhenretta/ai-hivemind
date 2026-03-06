interface ProgressBarProps {
    current: number;
    total: number;
    className?: string;
    showLabel?: boolean;
}

export function ProgressBar({ current, total, className = '', showLabel = true }: ProgressBarProps) {
    const percent = total > 0 ? Math.round((current / total) * 100) : 0;

    return (
        <div className={`flex items-center gap-2 ${className}`}>
            <div className="flex-1 h-1.5 bg-secondary rounded-full overflow-hidden">
                <div
                    className="h-full bg-primary rounded-full transition-all duration-500"
                    style={{ width: `${percent}%` }}
                />
            </div>
            {showLabel && total > 0 && (
                <span className="text-xs text-muted-foreground whitespace-nowrap">
                    {current} of {total}
                </span>
            )}
        </div>
    );
}
