import type { Metadata } from "next";
import { notFound } from "next/navigation";

import {
  getAllArticles,
  getArticle,
  getCategory,
  getRelatedArticles,
} from "../../_lib/articles";
import { Breadcrumbs } from "../../_components/Breadcrumbs";
import { ArticleRenderer } from "../../_components/ArticleRenderer";
import { RelatedArticles } from "../../_components/RelatedArticles";
import { FaqJsonLd } from "@/components/seo/FaqJsonLd";

const BORDER = "var(--borderColorSoft, rgba(33,28,22,0.3))";

interface PageProps {
  params: Promise<{ category: string; slug: string }>;
}

export function generateStaticParams() {
  return getAllArticles().map((a) => ({ category: a.category, slug: a.slug }));
}

export async function generateMetadata({
  params,
}: PageProps): Promise<Metadata> {
  const { category, slug } = await params;
  const article = getArticle(category, slug);
  if (!article) return { title: "Help" };
  return {
    title: `${article.title} — Help Centre`,
    description: article.description,
  };
}

export default async function HelpArticlePage({ params }: PageProps) {
  const { category, slug } = await params;
  const article = getArticle(category, slug);
  if (!article) notFound();
  const cat = getCategory(category);
  if (!cat) notFound();

  const related = getRelatedArticles(article);

  return (
    <article style={{ display: "flex", flexDirection: "column", gap: 32 }}>
      {article.faqs && article.faqs.length > 0 ? (
        <FaqJsonLd entries={article.faqs} />
      ) : null}
      <Breadcrumbs
        items={[
          { label: "Help", href: "/help" },
          { label: cat.title, href: `/help/${cat.slug}` },
          { label: article.title },
        ]}
      />

      <header
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 16,
          paddingBottom: 24,
          borderBottom: `2px solid ${BORDER}`,
        }}
      >
        {/* Eyebrow — same overline treatment as the help landing/category
            heroes (was a bespoke mono-ish span). */}
        <span className="swiss-overline">{cat.title}</span>
        <h1
          className="swiss-display-md"
          style={{ color: "var(--foreground)", maxWidth: 720 }}
        >
          {article.title}
        </h1>
        <p
          style={{
            fontSize: 17,
            lineHeight: 1.6,
            color: "var(--colorMuted, #5C544A)",
            maxWidth: 640,
          }}
        >
          {article.description}
        </p>
      </header>

      <ArticleRenderer content={article.content} />

      <RelatedArticles articles={related} />
    </article>
  );
}
