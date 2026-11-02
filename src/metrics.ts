/** Tiny in-process counters exposed in Prometheus text format at /metrics. */
export const metrics = {
  connections: 0,
  joins: 0,
  messagesIn: 0,
  messagesOut: 0,
  dropped: 0,
  kicked: 0,
  ticks: 0,
  lastTickMs: 0,
};

export function renderMetrics(extra: Record<string, number>): string {
  const all = { ...metrics, ...extra };
  return (
    Object.entries(all)
      .map(([k, v]) => `sontu_${k.replace(/[A-Z]/g, (c) => '_' + c.toLowerCase())} ${v}`)
      .join('\n') + '\n'
  );
}
