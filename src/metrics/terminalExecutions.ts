import { chainMetricLabels } from "../chain/protocolMetadata.js";
import type { RelayExecutionRow } from "../db/repositories.js";
import type { AppMetrics } from "./metrics.js";

export function extractTerminalErrorCode(lastErrorJson: string | null): string {
  if (!lastErrorJson) {
    return "none";
  }
  try {
    const parsed = JSON.parse(lastErrorJson) as { code?: unknown };
    if (typeof parsed.code === "string" && parsed.code.length > 0) {
      return parsed.code;
    }
  } catch {
    // ignore malformed error JSON
  }
  return "none";
}

export function recordTerminalTransition(
  metrics: Pick<AppMetrics, "executionsTerminalCounter"> | undefined,
  row: RelayExecutionRow,
): void {
  if (!metrics?.executionsTerminalCounter) {
    return;
  }
  metrics.executionsTerminalCounter.inc({
    ...chainMetricLabels(row.chainId),
    state: row.state,
    code: extractTerminalErrorCode(row.lastErrorJson),
  });
}
