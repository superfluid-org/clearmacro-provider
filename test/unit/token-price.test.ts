import { describe, expect, it, vi } from "vitest";
import { NATIVE_TOKEN_PRICE_ADDRESS, TokenPriceClient } from "../../src/chain/tokenPrice.js";

function fetchReturning(body: unknown, status = 200): typeof fetch {
  return vi.fn(async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
}

describe("TokenPriceClient", () => {
  it("fetches the native price from /v1/<network>/<zero address>", async () => {
    const fetchImpl = fetchReturning({ price: 2500.5 });
    const client = new TokenPriceClient({ baseUrl: "https://prices.test/", fetchImpl });

    expect(await client.getNativePrice("base-mainnet")).toBe(2500.5);
    const [url] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [string];
    expect(url).toBe(`https://prices.test/v1/base-mainnet/${NATIVE_TOKEN_PRICE_ADDRESS}`);
  });

  it("accepts numeric-string prices", async () => {
    const client = new TokenPriceClient({ fetchImpl: fetchReturning({ price: "1.25" }) });
    expect(await client.getNativePrice("xdai-mainnet")).toBe(1.25);
  });

  it("returns null and warns on HTTP error", async () => {
    const warn = vi.fn();
    const client = new TokenPriceClient({ fetchImpl: fetchReturning({ error: "upstream down" }, 502), logger: { warn } });
    expect(await client.getNativePrice("polygon-mainnet")).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("returns null on an invalid price payload", async () => {
    const client = new TokenPriceClient({ fetchImpl: fetchReturning({ price: "not-a-number" }) });
    expect(await client.getNativePrice("eth-mainnet")).toBeNull();
  });

  it("aborts requests that exceed the timeout", async () => {
    const fetchImpl = vi.fn(
      (_url: unknown, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    ) as unknown as typeof fetch;
    const client = new TokenPriceClient({ fetchImpl, timeoutMs: 5 });
    expect(await client.getNativePrice("eth-mainnet")).toBeNull();
  });
});
