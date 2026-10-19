export interface ArticleFrontmatter {
  title: string;
  description: string;
  category: string;
  order: number;
  tags?: string[];
  related?: string[];
  faqs?: Array<{ q: string; a: string }>;
}

export interface ArticleMeta extends ArticleFrontmatter {
  slug: string;
  path: string;
}

export interface Article extends ArticleMeta {
  content: string;
}

export interface CategoryMeta {
  slug: string;
  title: string;
  description: string;
  iconName: string;
}

export interface Category extends CategoryMeta {
  articles: ArticleMeta[];
}
