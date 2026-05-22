import { NextRequest, NextResponse } from "next/server";

export const runtime = 'nodejs';
export const maxDuration = 60;

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Accept",
  "Access-Control-Max-Age": "86400",
};

const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36";
const SUB_PATHS = ["/jobs", "/careers", "/vacancies", "/work-with-us"];

function stripHtml(html: string): string {
  let text = html.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, " ");
  text = text.replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, " ");
  text = text.replace(/<[^>]+>/g, " ");
  text = text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&nbsp;/g, " ");
  return text.replace(/\s+/g, " ").trim();
}

async function fetchText(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": USER_AGENT },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;
    return stripHtml(await res.text());
  } catch {
    return null;
  }
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS_HEADERS });
}

export async function POST(req: NextRequest) {
  let url: string;
  try {
    const body = await req.json();
    if (!body?.url || typeof body.url !== "string") throw new Error();
    url = body.url;
  } catch {
    return NextResponse.json({ error: "url is required" }, { status: 400, headers: CORS_HEADERS });
  }

  const main = await fetchText(url);
  if (!main) {
    return NextResponse.json({ error: "Failed to fetch the provided URL" }, { status: 422, headers: CORS_HEADERS });
  }

  let origin: string;
  try {
    origin = new URL(url).origin;
  } catch {
    return NextResponse.json({ error: "Invalid URL" }, { status: 400, headers: CORS_HEADERS });
  }

  const subPages = await Promise.all(SUB_PATHS.map((p) => fetchText(`${origin}${p}`)));
  const combined = [main, ...subPages.filter(Boolean)].join("\n\n");
  const text = combined.length > 3000 ? combined.slice(0, 3000) : combined;

  return NextResponse.json({ text }, { status: 200, headers: CORS_HEADERS });
}
