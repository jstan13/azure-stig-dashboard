interface Props {
  score: number;
  size?: 'small' | 'medium' | 'large';
}

function scoreColour(score: number): { bg: string; text: string } {
  if (score >= 80) return { bg: '#dff6dd', text: '#107c10' };
  if (score >= 60) return { bg: '#fff4ce', text: '#835b00' };
  return { bg: '#fde7e9', text: '#a4262c' };
}

const sizes = {
  small:  { padding: '2px 8px',  fontSize: 11, borderRadius: 10 },
  medium: { padding: '4px 12px', fontSize: 13, borderRadius: 12 },
  large:  { padding: '6px 16px', fontSize: 16, borderRadius: 14 },
};

export default function ComplianceBadge({ score, size = 'medium' }: Props) {
  const { bg, text } = scoreColour(score);
  const s = sizes[size];
  return (
    <span
      style={{
        background: bg,
        color: text,
        fontWeight: 600,
        ...s,
        display: 'inline-block',
        whiteSpace: 'nowrap',
      }}
    >
      {score}%
    </span>
  );
}
