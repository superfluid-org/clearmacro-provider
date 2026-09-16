import metadata from "@superfluid-finance/metadata";

/** Canonical Superfluid network slug for a chain id, falling back to the numeric id. */
export function networkName(chainId: number): string {
  return metadata.getNetworkByChainId(chainId)?.name ?? String(chainId);
}

/** Shared chain_id + network metric labels; non-numeric chain ids (e.g. "unknown") pass through. */
export function chainMetricLabels(chainId: number | string): { chain_id: string; network: string } {
  const numeric = typeof chainId === "number" ? chainId : Number(chainId);
  return {
    chain_id: String(chainId),
    network: Number.isInteger(numeric) ? networkName(numeric) : String(chainId),
  };
}
