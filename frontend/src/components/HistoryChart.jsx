import {
  CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis, Legend,
} from 'recharts';
import { formatPrice } from '../lib/format.js';

/**
 * Price and stock over time on one pair of axes.
 *
 * Only real observations are plotted — there is no interpolation across failed
 * scrapes, so a gap in the line genuinely means "we have no good data for then".
 */
export default function HistoryChart({ items }) {
  if (!items?.length) return null;

  const data = items.map((d) => ({
    t: new Date(d.scrapedAt).getTime(),
    price: d.price,
    stock: d.stockQuantity,
  }));

  const tick = (t) =>
    new Date(t).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });

  return (
    <div style={{ width: '100%', height: 300 }}>
      <ResponsiveContainer>
        <LineChart data={data} margin={{ top: 8, right: 16, bottom: 4, left: 4 }}>
          <CartesianGrid stroke="#eef0f3" vertical={false} />
          <XAxis
            dataKey="t" type="number" scale="time" domain={['dataMin', 'dataMax']}
            tickFormatter={tick} tick={{ fontSize: 11, fill: '#6b7280' }} minTickGap={40}
          />
          <YAxis
            yAxisId="price" tick={{ fontSize: 11, fill: '#6b7280' }} width={68}
            tickFormatter={(v) => `₹${(v / 1000).toFixed(v >= 1000 ? 0 : 1)}k`} domain={['auto', 'auto']}
          />
          <YAxis
            yAxisId="stock" orientation="right" tick={{ fontSize: 11, fill: '#6b7280' }}
            width={42} domain={[0, 'auto']} allowDecimals={false}
          />
          <Tooltip
            labelFormatter={tick}
            formatter={(value, name) => (name === 'Price' ? formatPrice(value) : `${value} units`)}
            contentStyle={{ fontSize: 13, borderRadius: 8, border: '1px solid #e3e6ea' }}
          />
          <Legend wrapperStyle={{ fontSize: 12 }} />
          <Line
            yAxisId="price" type="monotone" dataKey="price" name="Price"
            stroke="#1f4ed8" strokeWidth={2} dot={{ r: 2.5 }} activeDot={{ r: 4 }} isAnimationActive={false}
          />
          <Line
            yAxisId="stock" type="monotone" dataKey="stock" name="Stock"
            stroke="#15803d" strokeWidth={1.6} strokeDasharray="4 3" dot={{ r: 2 }} isAnimationActive={false}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
