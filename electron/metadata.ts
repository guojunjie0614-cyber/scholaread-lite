import type { PaperMeta } from '../shared/types.js';
import { appFetch } from './http.js';

const UA = 'ScholarLite/0.1 (mailto:noreply@example.com)';

const stripTags = (s: string) =>
  s
    .replace(/<[^>]+>/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();

async function getJson(url: string): Promise<any> {
  const res = await appFetch(url, {
    headers: { 'user-agent': UA, accept: 'application/json' },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function getText(url: string): Promise<string> {
  const res = await appFetch(url, {
    headers: { 'user-agent': UA },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

async function fromCrossref(doi: string): Promise<PaperMeta | null> {
  const json = await getJson(`https://api.crossref.org/works/${encodeURIComponent(doi)}`);
  const m = json?.message;
  if (!m) return null;
  return {
    title: Array.isArray(m.title) ? m.title[0] : m.title,
    authors: (m.author ?? []).map((a: any) =>
      [a.given, a.family].filter(Boolean).join(' ') || a.name || '',
    ).filter(Boolean),
    year: m.issued?.['date-parts']?.[0]?.[0] ?? null,
    doi: m.DOI ?? doi,
    venue: Array.isArray(m['container-title']) ? m['container-title'][0] : m['container-title'] ?? null,
    abstract: m.abstract ? stripTags(m.abstract) : null,
  };
}

async function searchCrossref(title: string): Promise<PaperMeta | null> {
  const url = `https://api.crossref.org/works?rows=1&query.bibliographic=${encodeURIComponent(title)}`;
  const json = await getJson(url);
  const m = json?.message?.items?.[0];
  if (!m) return null;
  return {
    title: Array.isArray(m.title) ? m.title[0] : m.title,
    authors: (m.author ?? []).map((a: any) =>
      [a.given, a.family].filter(Boolean).join(' ') || a.name || '',
    ).filter(Boolean),
    year: m.issued?.['date-parts']?.[0]?.[0] ?? null,
    doi: m.DOI ?? null,
    venue: Array.isArray(m['container-title']) ? m['container-title'][0] : m['container-title'] ?? null,
    abstract: m.abstract ? stripTags(m.abstract) : null,
  };
}

async function fromArxiv(id: string): Promise<PaperMeta | null> {
  const clean = id.replace(/^arxiv:/i, '').trim();
  const xml = await getText(
    `https://export.arxiv.org/api/query?id_list=${encodeURIComponent(clean)}&max_results=1`,
  );
  const entry = xml.match(/<entry>([\s\S]*?)<\/entry>/)?.[1];
  if (!entry) return null;
  const pick = (tag: string) => {
    const m = entry.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`));
    return m ? stripTags(m[1]) : null;
  };
  const authors = [...entry.matchAll(/<author>[\s\S]*?<name>([\s\S]*?)<\/name>[\s\S]*?<\/author>/g)].map(
    (m) => stripTags(m[1]),
  );
  const published = pick('published');
  return {
    title: pick('title') ?? undefined,
    authors,
    year: published ? Number(published.slice(0, 4)) : undefined,
    arxivId: clean ?? undefined,
    doi: pick('arxiv:doi') ?? undefined,
    venue: pick('arxiv:journal_ref') ?? 'arXiv',
    abstract: pick('summary') ?? undefined,
  };
}

export async function lookupMeta(q: {
  doi?: string;
  arxivId?: string;
  title?: string;
}): Promise<PaperMeta | null> {
  try {
    if (q.doi) return await fromCrossref(q.doi);
    if (q.arxivId) return await fromArxiv(q.arxivId);
    if (q.title) {
      const byTitle = await searchCrossref(q.title);
      if (byTitle) return byTitle;
      return await fromArxiv(q.title);
    }
  } catch (err) {
    throw new Error(`元数据查询失败：${err instanceof Error ? err.message : String(err)}`);
  }
  return null;
}

/** 从文件名猜 DOI / arXiv 号 / 标题 */
export function guessFromFileName(fileName: string): { doi?: string; arxivId?: string; title: string } {
  const base = fileName.replace(/\.pdf$/i, '').replace(/[_]+/g, ' ').trim();
  const doi = base.match(/10\.\d{4,9}\/[^\s"<>]+/)?.[0];
  const arxiv = base.match(/(?:arxiv[:\s-]*)?(\d{4}\.\d{4,5})(v\d+)?/i)?.[1];
  let title = base;
  if (doi) title = base.replace(doi, '').replace(/[,\s]+$/, '').trim();
  if (!title) title = base;
  // 去掉常见的下载站前缀
  title = title.replace(/^(sci-hub[.\w-]*|download|fulltext)[\s-]*/i, '').trim();
  return { doi: doi ?? undefined, arxivId: arxiv ?? undefined, title: title || '未命名文献' };
}
