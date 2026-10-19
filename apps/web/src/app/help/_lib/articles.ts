import "server-only";

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import matter from "gray-matter";

import type {
  Article,
  ArticleFrontmatter,
  ArticleMeta,
  Category,
} from "./types";
import { CATEGORIES, getCategoryBySlug } from "./categories";

const CONTENT_ROOT = join(process.cwd(), "content", "help");

const parseFrontmatter = (
  raw: string,
): { data: ArticleFrontmatter; content: string } => {
  const parsed = matter(raw);
  return {
    data: parsed.data as ArticleFrontmatter,
    content: parsed.content,
  };
};

const readArticleFile = (category: string, file: string): Article | null => {
  const path = join(CONTENT_ROOT, category, file);
  if (!existsSync(path)) return null;
  const raw = readFileSync(path, "utf8");
  const { data, content } = parseFrontmatter(raw);
  const slug = file.replace(/\.md$/, "");
  return {
    ...data,
    slug,
    path: `/help/${category}/${slug}`,
    content,
  };
};

export const getAllArticles = (): ArticleMeta[] => {
  const articles: ArticleMeta[] = [];
  for (const category of CATEGORIES) {
    const dir = join(CONTENT_ROOT, category.slug);
    if (!existsSync(dir)) continue;
    const files = readdirSync(dir).filter((f) => f.endsWith(".md"));
    for (const file of files) {
      const article = readArticleFile(category.slug, file);
      if (article) {
        // Strip content from the meta-only list
        const { content: _content, ...meta } = article;
        articles.push(meta);
      }
    }
  }
  return articles.sort((a, b) => a.order - b.order);
};

export const getArticlesByCategory = (categorySlug: string): ArticleMeta[] =>
  getAllArticles()
    .filter((a) => a.category === categorySlug)
    .sort((a, b) => a.order - b.order);

export const getArticle = (
  categorySlug: string,
  slug: string,
): Article | null => readArticleFile(categorySlug, `${slug}.md`);

export const getCategories = (): Category[] =>
  CATEGORIES.map((c) => ({
    ...c,
    articles: getArticlesByCategory(c.slug),
  }));

export const getCategory = (slug: string): Category | null => {
  const meta = getCategoryBySlug(slug);
  if (!meta) return null;
  return { ...meta, articles: getArticlesByCategory(slug) };
};

export const getRelatedArticles = (article: Article): ArticleMeta[] => {
  if (!article.related || article.related.length === 0) return [];
  const all = getAllArticles();
  return article.related
    .map((ref) => {
      // ref format: "category/slug"
      const [cat, slug] = ref.split("/");
      return all.find((a) => a.category === cat && a.slug === slug);
    })
    .filter((a): a is ArticleMeta => Boolean(a));
};
