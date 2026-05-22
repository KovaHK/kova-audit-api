'use strict';

const express = require('express');
const cors = require('cors');
const Anthropic = require('@anthropic-ai/sdk').default;

const app = express();
app.use(cors());
app.use(express.json());

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';
const SUB_PATHS = ['/jobs', '/careers', '/vacancies', '/work-with-us'];

const SYSTEM_PROMPT =
  `You are a JSON API. Output ONLY a JSON object starting with { and ending with }. No markdown.

Rules: Every field value must be SHORT. detail fields: max 20 words. desc fields: max 25 words. summary: max 25 words. All other strings: max 15 words. Strictly enforce these limits.

Return this structure:
{"company":"","score":0,"locations":"","specialisms":"","summary":"","issues":[{"severity":"CRITICAL","title":"","detail":"","impact":""},{"severity":"CRITICAL","title":"","detail":"","impact":""},{"severity":"SIGNIFICANT","title":"","detail":"","impact":""},{"severity":"SIGNIFICANT","title":"","detail":"","impact":""},{"severity":"NOTABLE","title":"","detail":"","impact":""}],"strengths":[{"title":"","detail":""},{"title":"","detail":""},{"title":"","detail":""},{"title":"","detail":""}],"journeySteps":[{"label":"","status":"ok","note":null},{"label":"","status":"warn","note":""},{"label":"","status":"gap","note":""},{"label":"","status":"gap","note":""},{"label":"","status":"warn","note":""}],"opportunities":[{"icon":"⚡","title":"","desc":"","impact":""},{"icon":"🎯","title":"","desc":"","impact":""},{"icon":"📡","title":"","desc":"","impact":""}],"timeToContact":"","candidateLoss":"","monthlyApps":"","impactStatement":""}`;

function stripHtml(html) {
  let text = html.replace(/<script[\s\S]*?<\/script>/gi, ' ');
  text = text.replace(/<style[\s\S]*?<\/style>/gi, ' ');
  text = text.replace(/<[^>]+>/g, ' ');
  text = text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&nbsp;/g, ' ');
  return text.replace(/\s+/g, ' ').trim();
}

async function fetchText(url) {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;
    return stripHtml(await res.text());
  } catch {
    return null;
  }
}

app.post('/api/audit', async (req, res) => {
  const { url } = req.body || {};
  if (!url || typeof url !== 'string') {
    return res.status(400).json({ error: 'url is required' });
  }

  const main = await fetchText(url);
  if (!main) return res.status(500).json({ error: 'Failed to fetch the provided URL' });

  let origin;
  try {
    origin = new URL(url).origin;
  } catch {
    return res.status(500).json({ error: 'Invalid URL' });
  }

  const subPages = await Promise.all(SUB_PATHS.map((p) => fetchText(`${origin}${p}`)));
  const combined = [main, ...subPages.filter(Boolean)].join('\n\n');
  const truncated = combined.length > 3000 ? combined.slice(0, 3000) : combined;

  let claudeResponse;
  try {
    claudeResponse = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 2048,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: `RESPOND WITH JSON ONLY. NO MARKDOWN. Audit this agency website content:\n\n${truncated}` }],
    });
  } catch (e) {
    return res.status(500).json({ error: e instanceof Error ? e.message : 'Claude API error' });
  }

  const textBlock = claudeResponse.content.find((b) => b.type === 'text');
  if (!textBlock) return res.status(500).json({ error: 'No text response from Claude' });

  let claudeText = textBlock.text.trim();

  if (claudeText.startsWith('```')) {
    const newline = claudeText.indexOf('\n');
    claudeText = newline !== -1 ? claudeText.slice(newline + 1).trim() : claudeText.slice(3).trim();
  }
  if (claudeText.endsWith('```')) claudeText = claudeText.slice(0, claudeText.lastIndexOf('```')).trim();
  const firstBrace = claudeText.indexOf('{');
  if (firstBrace > 0) claudeText = claudeText.slice(firstBrace);
  const lastBrace = claudeText.lastIndexOf('}');
  if (lastBrace !== -1 && lastBrace < claudeText.length - 1) claudeText = claudeText.slice(0, lastBrace + 1);

  console.log('CLAUDE RAW:', JSON.stringify(claudeText.substring(0, 500)));

  try {
    const parsed = JSON.parse(claudeText);
    return res.status(200).json(parsed);
  } catch (e) {
    console.log('PARSE ERROR on text starting with:', JSON.stringify(claudeText.substring(0, 200)));
    return res.status(500).json({ error: 'Claude returned non-JSON', raw: claudeText });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`kova-audit-api listening on port ${PORT}`));
