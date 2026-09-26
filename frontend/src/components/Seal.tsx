/** The brand mark: a vermilion seal stamp bearing 記 ("record"). */
export function Seal({ size = 30, className }: { size?: number; className?: string }) {
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 64 64" aria-hidden="true">
      <rect x="3" y="3" width="58" height="58" rx="11" fill="var(--accent)" />
      <rect x="8.5" y="8.5" width="47" height="47" rx="7" fill="none" stroke="var(--accent-ink)" strokeWidth="2.2" opacity="0.8" />
      <text
        x="32"
        y="44.5"
        textAnchor="middle"
        fontFamily="'Noto Serif TC','Songti TC','Source Han Serif TC','PMingLiU',serif"
        fontSize="31"
        fontWeight="700"
        fill="var(--accent-ink)"
      >
        記
      </text>
    </svg>
  );
}

export function Wordmark() {
  return (
    <span className="wordmark">
      <Seal size={28} />
      <span className="wordmark-text">Minutes</span>
    </span>
  );
}
