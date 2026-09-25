import { useId } from 'react';
import type { MetricsSnapshot, Variant } from '../shared/types.js';
import { buildSignupChartModel, formatSignupTimestamp, type SignupChartPoint, type SignupChartTrack } from './signup-chart-model.js';

const WIDTH = 820;
const HEIGHT = 318;
const LEFT = 76;
const RIGHT = 800;
const TOP = 22;
const BOTTOM = 238;

function pointX(time: number, start: number, end: number): number {
  return end === start ? (LEFT + RIGHT) / 2 : LEFT + (time - start) / (end - start) * (RIGHT - LEFT);
}

function pointY(value: number, maximum: number): number {
  return BOTTOM - value / maximum * (BOTTOM - TOP);
}

function stepPath(points: SignupChartPoint[], start: number, end: number, maximum: number): string {
  if (!points.length) return '';
  let path = `M ${pointX(points[0]!.time, start, end)} ${pointY(points[0]!.signups, maximum)}`;
  for (let index = 1; index < points.length; index++) {
    const previous = points[index - 1]!;
    const current = points[index]!;
    const x = pointX(current.time, start, end);
    path += ` L ${x} ${pointY(previous.signups, maximum)} L ${x} ${pointY(current.signups, maximum)}`;
  }
  return path;
}

function plural(value: number, word: string): string {
  return `${value} ${word}${value === 1 ? '' : 's'}`;
}

export default function SignupChart({ metrics, variants, loading }: {
  metrics: MetricsSnapshot | null;
  variants: Variant[];
  loading: boolean;
}) {
  const id = useId().replaceAll(':', '');
  const model = buildSignupChartModel({ metrics, variants });
  const observedThrough = model.observationTimestamp ? formatSignupTimestamp(model.observationTimestamp) : null;
  const summary = !model.hasData
    ? loading ? 'Loading local persona-wave results.' : 'No persona-wave results have been recorded yet.'
    : model.totalSignups === 0
      ? `No simulated sign-ups have been recorded across ${plural(model.tracks.length, 'version')} through ${observedThrough}.`
      : `The latest recorded total is ${plural(model.totalSignups, 'simulated sign-up')} across ${plural(model.tracks.length, 'version')} through ${observedThrough}.`;

  return <div className="signup-chart" aria-label="Local persona simulation results">
    <p className="signup-chart-scope">Local simulated persona judgments from the latest wave. These are not live customer sign-ups or ad performance.</p>
    <p className="signup-chart-takeaway" role="status">{summary}</p>
    {loading && !model.hasData ? <div className="signup-chart-empty" role="status">Loading persona-wave results…</div> : !model.hasData ?
      <div className="signup-chart-empty" role="status"><strong>No wave results yet</strong><span>Start an experiment to record simulated sign-ups by version.</span></div> : <>
        <figure className="signup-chart-figure">
          <svg className="signup-chart-svg" viewBox={`0 0 ${WIDTH} ${HEIGHT}`} role="img" aria-labelledby={`${id}-title ${id}-description`}>
            <title id={`${id}-title`}>Cumulative simulated sign-ups by version</title>
            <desc id={`${id}-description`}>A step chart of local persona-wave sign-ups over elapsed time. Each line starts at zero and carries forward only through the observed wave window. Circle tooltips give the exact recorded time.</desc>
            {model.yTicks.map((value) => {
              const y = pointY(value, model.yMaximum);
              return <g key={value}>
                <line className="signup-grid-line" x1={LEFT} x2={RIGHT} y1={y} y2={y} />
                <text className="signup-tick-label signup-y-tick" x={LEFT - 12} y={y + 4} textAnchor="end">{value.toLocaleString()}</text>
              </g>;
            })}
            <line className="signup-axis-line" x1={LEFT} x2={LEFT} y1={TOP} y2={BOTTOM} />
            <line className="signup-axis-line" x1={LEFT} x2={RIGHT} y1={BOTTOM} y2={BOTTOM} />
            {model.domainStart !== null && model.domainEnd !== null && model.tracks.map((track) => <g key={track.variantId}>
              <path className={`signup-series-line signup-series-${track.colorKey}`} d={stepPath(track.points, model.domainStart!, model.domainEnd!, model.yMaximum)} />
              {track.points.filter((point) => point.marker).map((point) => <circle
                key={`${track.variantId}-${point.timestamp}-${point.signups}`}
                className={`signup-series-point signup-series-${track.colorKey}`}
                cx={pointX(point.time, model.domainStart!, model.domainEnd!)} cy={pointY(point.signups, model.yMaximum)} r="4.5">
                <title>{`${track.label} · ${track.headline} · ${plural(point.signups, 'cumulative simulated sign-up')} · ${formatSignupTimestamp(point.timestamp)}`}</title>
              </circle>)}
            </g>)}
            {model.domainStart !== null && model.domainEnd !== null && model.xTicks.map((tick, index) => {
              const x = pointX(tick.time, model.domainStart!, model.domainEnd!);
              const anchor = model.xTicks.length === 1 ? 'middle' : index === 0 ? 'start' : index === model.xTicks.length - 1 ? 'end' : 'middle';
              return <g key={`${tick.time}-${index}`}>
                <line className="signup-tick-line" x1={x} x2={x} y1={BOTTOM} y2={BOTTOM + 5} />
                <text className="signup-tick-label signup-x-tick" x={x} y={BOTTOM + 22} textAnchor={anchor}>{tick.label}</text>
              </g>;
            })}
            <text className="signup-axis-title signup-y-title" x="18" y={(TOP + BOTTOM) / 2} textAnchor="middle" transform={`rotate(-90 18 ${(TOP + BOTTOM) / 2})`}>Cumulative sign-ups (count)</text>
            <text className="signup-axis-title signup-x-title" x={(LEFT + RIGHT) / 2} y="300" textAnchor="middle">{model.xAxisTitle}</text>
          </svg>
          <figcaption className="sr-only">{summary} Horizontal ticks show elapsed time, and vertical ticks show cumulative sign-up counts.</figcaption>
        </figure>

        <div className="signup-results-table-wrap">
          <table className="signup-results-table">
            <caption>Legend and latest cumulative simulated sign-ups by version</caption>
            <thead><tr><th scope="col">Version</th><th scope="col">Headline</th><th scope="col">Sign-ups</th><th scope="col">Observed through</th></tr></thead>
            <tbody>{model.tracks.map((track) => <tr key={track.variantId}>
              <th scope="row"><span className={`signup-key signup-key-${track.colorKey}`} aria-hidden="true" />{track.label}</th>
              <td>{track.headline}</td>
              <td>{track.latestSignups.toLocaleString()}</td>
              <td>{observedThrough ?? '—'}</td>
            </tr>)}</tbody>
          </table>
        </div>
      </>}
  </div>;
}
