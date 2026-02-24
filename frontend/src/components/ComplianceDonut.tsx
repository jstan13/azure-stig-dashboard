import { PieChart, Pie, Cell, Tooltip, ResponsiveContainer, Legend } from 'recharts';

interface Props {
  open: number;
  notAFinding: number;
  notApplicable: number;
  notReviewed: number;
  size?: number;
}

const COLOURS = {
  open:          '#d13438',   // red
  not_a_finding: '#107c10',   // green
  not_applicable:'#605e5c',   // grey
  not_reviewed:  '#c8c6c4',   // light grey
};

export default function ComplianceDonut({ open, notAFinding, notApplicable, notReviewed, size = 260 }: Props) {
  const data = [
    { name: 'Open',           value: open,          fill: COLOURS.open },
    { name: 'Not a Finding',  value: notAFinding,   fill: COLOURS.not_a_finding },
    { name: 'Not Applicable', value: notApplicable, fill: COLOURS.not_applicable },
    { name: 'Not Reviewed',   value: notReviewed,   fill: COLOURS.not_reviewed },
  ].filter((d) => d.value > 0);

  const total = open + notAFinding + notApplicable + notReviewed;
  const score = total > 0
    ? Math.round((notAFinding / (total - notApplicable)) * 100)
    : 0;

  return (
    <div style={{ position: 'relative', width: size, height: size }}>
      <ResponsiveContainer width="100%" height="100%">
        <PieChart>
          <Pie
            data={data}
            cx="50%"
            cy="50%"
            innerRadius="55%"
            outerRadius="80%"
            dataKey="value"
            strokeWidth={2}
          >
            {data.map((entry, index) => (
              <Cell key={`cell-${index}`} fill={entry.fill} />
            ))}
          </Pie>
          <Tooltip formatter={(value, name) => [`${value}`, name]} />
          <Legend />
        </PieChart>
      </ResponsiveContainer>
      {/* Centre label */}
      <div
        style={{
          position: 'absolute',
          top: '38%',
          left: '50%',
          transform: 'translate(-50%, -50%)',
          textAlign: 'center',
          pointerEvents: 'none',
        }}
      >
        <div style={{ fontSize: 28, fontWeight: 700, color: score >= 80 ? '#107c10' : score >= 60 ? '#c7a200' : '#d13438' }}>
          {score}%
        </div>
        <div style={{ fontSize: 11, color: '#605e5c' }}>Compliant</div>
      </div>
    </div>
  );
}
