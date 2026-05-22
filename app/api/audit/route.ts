import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";

export const maxDuration = 60;

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Accept",
  "Access-Control-Max-Age": "86400",
};

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36";

const SUB_PATHS = ["/jobs", "/careers", "/vacancies", "/work-with-us"];

const SYSTEM_PROMPT =
  `You are a senior recruitment technology consultant auditing UK healthcare staffing agencies for Kova. You have real scraped content from their website. Produce a specific evidence-based audit referencing actual details found — locations, role types, pay rates, application process steps. Do not invent details not present. Respond ONLY with valid JSON, no markdown. Return ONLY a JSON object with these fields: company, score (20-55), locations, specialisms, summary (2 sentences), issues (array of 5 objects each with severity, title, detail (MAX 1 sentence), impact (3 words)), strengths (array of 4 objects each with title, detail (MAX 1 sentence)), journeySteps (array of 5 objects each with label, status ok/warn/gap, note (MAX 8 words or null)), opportunities (array of 3 objects each with icon, title, desc (MAX 2 sentences), impact (3 words)), timeToContact, candidateLoss, monthlyApps, impactStatement (MAX 1 sentence). Every string must be under 100 characters except detail and desc fields which must be under 200 characters.`;

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

function err(message: string, status = 500): NextResponse {
  return NextResponse.json({ error: message }, { status, headers: CORS_HEADERS });
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
    return err("url is required");
  }

  const main = await fetchText(url);
  if (!main) return err("Failed to fetch the provided URL");

  let origin: string;
  try {
    origin = new URL(url).origin;
  } catch {
    return err("Invalid URL");
  }

  const subPages = await Promise.all(SUB_PATHS.map((p) => fetchText(`${origin}${p}`)));
  const combined = [main, ...subPages.filter(Boolean)].join("\n\n");
  const truncated = combined.length > 4000 ? combined.slice(0, 4000) : combined;

  let claudeResponse: Anthropic.Message;
  try {
    claudeResponse = await client.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 2000,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: `Scraped content from ${url}:\n\n${truncated}` }],
    });
  } catch (e) {
    return err(e instanceof Error ? e.message : "Claude API error");
  }

  const textBlock = claudeResponse.content.find((b) => b.type === "text");
  if (!textBlock || textBlock.type !== "text") return err("No text response from Claude");

  let rawText = textBlock.text
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```\s*$/, "")
    .trim();

  try {
    const parsed = JSON.parse(rawText);
    return NextResponse.json(parsed, { status: 200, headers: CORS_HEADERS });
  } catch (e) {
    console.error("JSON parse failed:", e);
    console.error("Raw Claude response:", rawText);
    return NextResponse.json(
      { error: "Claude returned non-JSON", raw: rawText },
      { status: 500, headers: CORS_HEADERS }
    );
  }
}
