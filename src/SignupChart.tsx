import { useId } from 'react';
import type { MetricsSnapshot, Variant } from '../shared/types.js';
import { buildSignupChartModel, formatPercent, type ComparisonMetricKey, type ComparisonVersion } from './signup-chart-model.js';

const WIDTH = 820;
const HEIGHT = 318;
const LEFT = 64;
const RIGHT = 800;
const TOP = 22;
const BOTTOM = 248;
const GROUP_GAP = 28;

function valueOf(version: ComparisonVersion, key: ComparisonMetricKey): number {
  if (key === 'impressions') return version.impressions;
  if (key === 'clicks') return version.clicks;
  return version.signups;
}

function plural(value: number, word: string): string {
  return `${value.toLocaleString()} ${word}${value === 1 ? '' : 's'}`;
}

export default function SignupChart({ metrics, variants, loading }: {
  metrics: MetricsSnapshot | null;
  variants: Variant[];
  loading: boolean;
}) {
  const id = useId().replaceAll(':', '');
  const model = buildSignupChartModel({ metrics, variants });
  const groupCount = model.metrics.length;
  const versionCount = Math.max(1, model.versions.length);
  const plotWidth = RIGHT - LEFT;
  const groupWidth = (plotWidth - GROUP_GAP * (groupCount - 1)) / groupCount;
  const barGap = 8;
  const barWidth = Math.max(18, (groupWidth - barGap * (versionCount - 1)) / versionCount);

  const summary = !model.hasData
    ? loading ? 'Loading experiment results.' : 'No experiment results have been recorded yet.'
    : `Comparing ${model.versions.length} version${model.versions.length === 1 ? '' : 's'}: ${plural(model.totalImpressions, 'ad view')}, ${plural(model.totalClicks, 'click')}, and ${plural(model.totalSignups, 'sign-up')}.`;

  return <div className="signup-chart" aria-label="Version comparison results">
    <p className="signup-chart-scope">Side-by-side comparison of each headline version. Bars show totals for this experiment window, not a time series.</p>
    <p className="signup-chart-takeaway" role="status">{summary}</p>
    {loading && !model.hasData ? <div className="signup-chart-empty" role="status">Loading experiment results…</div> : !model.hasData ?
      <div className="signup-chart-empty" role="status"><strong>No results yet</strong><span>Start an experiment to compare ad views, clicks, and sign-ups by version.</span></div> : <>
        <figure className="signup-chart-figure">
          <svg className="signup-chart-svg" viewBox={`0 0 ${WIDTH} ${HEIGHT}`} role="img" aria-labelledby={`${id}-title ${id}-description`}>
            <title id={`${id}-title`}>Version comparison of ad views, clicks, and sign-ups</title>
            <desc id={`${id}-description`}>Grouped bar chart comparing each creative version across ad views, clicks, and sign-ups for the current experiment window.</desc>
            {model.yTicks.map((value) => {
              const y = BOTTOM - (value / model.yMaximum) * (BOTTOM - TOP);
              return <g key={value}>
                <line className="signup-grid-line" x1={LEFT} x2={RIGHT} y1={y} y2={y} />
                <text className="signup-tick-label signup-y-tick" x={LEFT - 12} y={y + 4} textAnchor="end">{value.toLocaleString()}</text>
              </g>;
            })}
            <line className="signup-axis-line" x1={LEFT} x2={LEFT} y1={TOP} y2={BOTTOM} />
            <line className="signup-axis-line" x1={LEFT} x2={RIGHT} y1={BOTTOM} y2={BOTTOM} />
            {model.metrics.map((metric, groupIndex) => {
              const groupX = LEFT + groupIndex * (groupWidth + GROUP_GAP);
              return <g key={metric.key}>
                {model.versions.map((version, versionIndex) => {
                  const value = valueOf(version, metric.key);
                  const height = model.yMaximum === 0 ? 0 : (value / model.yMaximum) * (BOTTOM - TOP);
                  const x = groupX + versionIndex * (barWidth + barGap);
                  const y = BOTTOM - height;
                  return <rect
                    key={`${metric.key}-${version.variantId}`}
                    className={`signup-bar signup-series-${version.colorKey}`}
                    x={x} y={y} width={barWidth} height={Math.max(height, value > 0 ? 2 : 0)} rx="4"
                  >
                    <title>{`${version.label} · ${metric.label}: ${value.toLocaleString()}`}</title>
                  </rect>;
                })}
                <text className="signup-tick-label signup-x-tick" x={groupX + groupWidth / 2} y={BOTTOM + 28} textAnchor="middle">{metric.label}</text>
              </g>;
            })}
            <text className="signup-axis-title signup-y-title" x="18" y={(TOP + BOTTOM) / 2} textAnchor="middle" transform={`rotate(-90 18 ${(TOP + BOTTOM) / 2})`}>Count</text>
            <text className="signup-axis-title signup-x-title" x={(LEFT + RIGHT) / 2} y="300" textAnchor="middle">Metric by version</text>
          </svg>
          <figcaption className="sr-only">{summary} Each group compares versions on one metric.</figcaption>
        </figure>

        <div className="signup-results-table-wrap">
          <table className="signup-results-table">
            <caption>Version totals for this experiment window</caption>
            <thead><tr><th scope="col">Version</th><th scope="col">Headline</th><th scope="col">Ad views</th><th scope="col">Clicks</th><th scope="col">Sign-ups</th><th scope="col">Click rate</th><th scope="col">Signup / view</th></tr></thead>
            <tbody>{model.versions.map((version) => <tr key={version.variantId}>
              <th scope="row"><span className={`signup-key signup-key-${version.colorKey}`} aria-hidden="true" />{version.label}</th>
              <td>{version.headline}</td>
              <td>{version.impressions.toLocaleString()}</td>
              <td>{version.clicks.toLocaleString()}</td>
              <td>{version.signups.toLocaleString()}</td>
              <td>{formatPercent(version.clickRate)}</td>
              <td>{formatPercent(version.signupRate)}</td>
            </tr>)}</tbody>
          </table>
        </div>
      </>}
  </div>;
}
