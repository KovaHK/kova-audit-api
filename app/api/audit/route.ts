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
  `You are a JSON API. You must respond with ONLY a raw JSON object. No markdown. No code fences. No explanation. No preamble. Start your response with { and end with }. Nothing else.

Audit the UK healthcare recruitment agency website content provided. Return this exact JSON structure:
{"company":"string","score":35,"locations":"string","specialisms":"string","summary":"string","issues":[{"severity":"CRITICAL","title":"string","detail":"string","impact":"string"},{"severity":"CRITICAL","title":"string","detail":"string","impact":"string"},{"severity":"SIGNIFICANT","title":"string","detail":"string","impact":"string"},{"severity":"SIGNIFICANT","title":"string","detail":"string","impact":"string"},{"severity":"NOTABLE","title":"string","detail":"string","impact":"string"}],"strengths":[{"title":"string","detail":"string"},{"title":"string","detail":"string"},{"title":"string","detail":"string"},{"title":"string","detail":"string"}],"journeySteps":[{"label":"string","status":"ok","note":null},{"label":"string","status":"warn","note":"string"},{"label":"string","status":"gap","note":"string"},{"label":"string","status":"gap","note":"string"},{"label":"string","status":"warn","note":"string"}],"opportunities":[{"icon":"⚡","title":"string","desc":"string","impact":"string"},{"icon":"🎯","title":"string","desc":"string","impact":"string"},{"icon":"📡","title":"string","desc":"string","impact":"string"}],"timeToContact":"string","candidateLoss":"string","monthlyApps":"string","impactStatement":"string"}`;

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
      messages: [{ role: "user", content: `RESPOND WITH JSON ONLY. NO MARKDOWN. Audit this agency website content:\n\n${truncated}` }],
    });
  } catch (e) {
    return err(e instanceof Error ? e.message : "Claude API error");
  }

  const textBlock = claudeResponse.content.find((b) => b.type === "text");
  if (!textBlock || textBlock.type !== "text") return err("No text response from Claude");

  let claudeText = textBlock.text.trim();

  // Strip opening code fence (e.g. ```json\n or ```\n)
  if (claudeText.startsWith("```")) {
    const newline = claudeText.indexOf("\n");
    claudeText = newline !== -1 ? claudeText.slice(newline + 1).trim() : claudeText.slice(3).trim();
  }
  // Strip closing code fence
  if (claudeText.endsWith("```")) claudeText = claudeText.slice(0, claudeText.lastIndexOf("```")).trim();
  // Find the first { in case there's any remaining preamble
  const firstBrace = claudeText.indexOf("{");
  if (firstBrace > 0) claudeText = claudeText.slice(firstBrace);
  // Find the last } in case there's any trailing content
  const lastBrace = claudeText.lastIndexOf("}");
  if (lastBrace !== -1 && lastBrace < claudeText.length - 1) claudeText = claudeText.slice(0, lastBrace + 1);

  console.log('CLAUDE RAW:', JSON.stringify(claudeText.substring(0, 500)));

  try {
    const parsed = JSON.parse(claudeText);
    return NextResponse.json(parsed, { status: 200, headers: CORS_HEADERS });
  } catch (e) {
    console.log('PARSE ERROR on text starting with:', JSON.stringify(claudeText.substring(0, 200)));
    return NextResponse.json(
      { error: "Claude returned non-JSON", raw: claudeText },
      { status: 500, headers: CORS_HEADERS }
    );
  }
}
