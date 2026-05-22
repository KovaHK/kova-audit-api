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
  `You are a senior recruitment technology consultant auditing UK healthcare staffing agencies for Kova. You have real scraped content from their website. Produce a specific evidence-based audit referencing actual details found — locations, role types, pay rates, application process steps. Do not invent details not present. Respond ONLY with valid JSON, no markdown. Schema: {"company":"string","score":number 20-55,"locations":"string","specialisms":"string","summary":"2 sentences specific to what you found","issues":[{"severity":"CRITICAL","title":"string","detail":"2-3 sentences referencing actual site content","impact":"string"},{"severity":"CRITICAL","title":"string","detail":"string","impact":"string"},{"severity":"SIGNIFICANT","title":"string","detail":"string","impact":"string"},{"severity":"SIGNIFICANT","title":"string","detail":"string","impact":"string"},{"severity":"NOTABLE","title":"string","detail":"string","impact":"string"}],"strengths":[{"title":"string","detail":"1 sentence from their actual site"},{"title":"string","detail":"string"},{"title":"string","detail":"string"},{"title":"string","detail":"string"}],"journeySteps":[{"label":"string","status":"ok","note":null},{"label":"string","status":"warn","note":"string"},{"label":"string","status":"gap","note":"string"},{"label":"string","status":"gap","note":"string"},{"label":"string","status":"warn","note":"string"}],"opportunities":[{"icon":"⚡","title":"string","desc":"2-3 sentences specific to this agency","impact":"string"},{"icon":"🎯","title":"string","desc":"string","impact":"string"},{"icon":"📡","title":"string","desc":"string","impact":"string"}],"timeToContact":"string","candidateLoss":"string","monthlyApps":"string","impactStatement":"1 sentence with their company name and specific situation"}`;

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
  const truncated = combined.length > 8000 ? combined.slice(0, 8000) : combined;

  let claudeResponse: Anthropic.Message;
  try {
    claudeResponse = await client.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 4000,
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

  // If truncated mid-JSON, trim to the last complete closing brace
  if (!rawText.endsWith("}")) {
    const lastBrace = rawText.lastIndexOf("}");
    if (lastBrace !== -1) rawText = rawText.slice(0, lastBrace + 1);
  }

  try {
    const parsed = JSON.parse(rawText);
    return NextResponse.json(parsed, { status: 200, headers: CORS_HEADERS });
  } catch (e) {
    console.error("JSON parse failed:", e);
    console.error("Raw Claude response:", rawText);
    return err("Claude returned non-JSON");
  }
}
