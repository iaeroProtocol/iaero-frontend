export const runtime = 'edge';

// src/app/api/0x/quote/route.ts
import { type NextRequest, NextResponse } from "next/server";
import { getRequestContext } from '@cloudflare/next-on-pages';

export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams;
  const { env } = getRequestContext();
  const ZERO_EX_API_KEY = env.ZERO_EX_API_KEY;

  if (!ZERO_EX_API_KEY) {
    return NextResponse.json({ error: "Missing API Key" }, { status: 500 });
  }

  const url = `https://api.0x.org/swap/allowance-holder/quote?${searchParams.toString()}`;

  try {
    const res = await fetch(url, {
      headers: {
        "0x-api-key": ZERO_EX_API_KEY,
        "0x-version": "v2",
      },
    });

    const data = await res.json();

    if (!res.ok) {
      return NextResponse.json(data, { status: res.status });
    }

    return NextResponse.json(data);
  } catch (error) {
    return NextResponse.json({ error: "Failed to fetch quote" }, { status: 500 });
  }
}
