/**
 * Severity heat-map: a grid of (resource group × CAT-I/II/III) cells coloured
 * by open finding count. Click a cell to drill into that resource group.
 */
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Stack, Text, Spinner, SpinnerSize, MessageBar, MessageBarType } from '@fluentui/react';
import { api } from '../hooks/useApi';

interface Cell {
  scope: string;
  tenantName?: string;
  subscriptionName?: string;
  subscriptionId: string;
  resourceGroup: string;
  machines: number;
  catI: number; catII: number; catIII: number;
}

function colorFor(count: number, max: number, sev: 'I' | 'II' | 'III'): string {
  if (count === 0) return '#f3f2f1';
  const t = Math.min(1, count / Math.max(1, max));
  if (sev === 'I')   return mix('#fce4e6', '#a4262c', t);
  if (sev === 'II')  return mix('#fde7d6', '#ca5010', t);
  return mix('#f3f2f1', '#605e5c', t);
}
function mix(a: string, b: string, t: number): string {
  const ah = a.replace('#', ''); const bh = b.replace('#', '');
  const ar = parseInt(ah.slice(0, 2), 16), ag = parseInt(ah.slice(2, 4), 16), ab = parseInt(ah.slice(4, 6), 16);
  const br = parseInt(bh.slice(0, 2), 16), bg = parseInt(bh.slice(2, 4), 16), bb = parseInt(bh.slice(4, 6), 16);
  const r = Math.round(ar + (br - ar) * t);
  const g = Math.round(ag + (bg - ag) * t);
  const b2 = Math.round(ab + (bb - ab) * t);
  return `rgb(${r},${g},${b2})`;
}

export default function SeverityHeatmap() {
  const navigate = useNavigate();
  const [cells, setCells] = useState<Cell[]>([]);
  const [loading, setLoading] = useState(true);
  const [error,   setError]   = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const res = await api.get<{ cells: Cell[] }>('/api/hierarchy/heatmap');
        setCells(res.data.cells);
      } catch (e: any) {
        setError(e?.message || 'Failed to load heatmap');
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  if (loading) return <Spinner size={SpinnerSize.medium} label="Loading heatmap…" />;
  if (error)   return <MessageBar messageBarType={MessageBarType.error}>{error}</MessageBar>;
  if (!cells.length) return null;

  const maxI   = Math.max(...cells.map((c) => c.catI));
  const maxII  = Math.max(...cells.map((c) => c.catII));
  const maxIII = Math.max(...cells.map((c) => c.catIII));

  return (
    <div style={{ background: '#fff', border: '1px solid #edebe9', borderRadius: 8, padding: 20 }}>
      <Stack horizontal horizontalAlign="space-between" verticalAlign="center" style={{ marginBottom: 12 }}>
        <Text variant="large" style={{ fontWeight: 600 }}>Severity heat-map</Text>
        <Text style={{ color: '#605e5c', fontSize: 12 }}>
          Open findings by resource group and severity. Click a row to drill in.
        </Text>
      </Stack>

      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
        <thead>
          <tr style={{ borderBottom: '1px solid #edebe9' }}>
            <th style={th}>Subscription</th>
            <th style={th}>Resource group</th>
            <th style={{ ...th, textAlign: 'right' }}>Machines</th>
            <th style={thCenter}>CAT&nbsp;I</th>
            <th style={thCenter}>CAT&nbsp;II</th>
            <th style={thCenter}>CAT&nbsp;III</th>
          </tr>
        </thead>
        <tbody>
          {cells.map((c) => (
            <tr
              key={c.scope}
              style={{ cursor: 'pointer' }}
              onClick={() => navigate(`/groups/${encodeURIComponent(c.resourceGroup)}`)}
            >
              <td style={td}>
                <div style={{ fontWeight: 600 }}>{c.subscriptionName}</div>
                <div style={{ color: '#8a8886', fontSize: 11 }}>{c.tenantName}</div>
              </td>
              <td style={td}>{c.resourceGroup}</td>
              <td style={{ ...td, textAlign: 'right' }}>{c.machines}</td>
              <td style={cellStyle(colorFor(c.catI,   maxI,   'I'))}>{c.catI}</td>
              <td style={cellStyle(colorFor(c.catII,  maxII,  'II'))}>{c.catII}</td>
              <td style={cellStyle(colorFor(c.catIII, maxIII, 'III'))}>{c.catIII}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const th: React.CSSProperties = { textAlign: 'left', padding: '6px 10px', color: '#605e5c', fontWeight: 600, fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.4 };
const thCenter: React.CSSProperties = { ...th, textAlign: 'center', width: 70 };
const td: React.CSSProperties = { padding: '8px 10px', borderTop: '1px solid #f3f2f1' };
const cellStyle = (bg: string): React.CSSProperties => ({
  textAlign: 'center', padding: '8px 0', borderTop: '1px solid #f3f2f1',
  background: bg, color: '#201f1e', fontWeight: 700, width: 70,
});
