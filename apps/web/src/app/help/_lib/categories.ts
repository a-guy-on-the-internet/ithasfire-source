import type { CategoryMeta } from "./types";

export const CATEGORIES: CategoryMeta[] = [
  {
    slug: "getting-started",
    title: "Getting started",
    description: "Set up your account and buy your first ticket.",
    iconName: "Rocket",
  },
  {
    slug: "buying-tickets",
    title: "Buying tickets",
    description: "Find events, purchase, and manage your orders.",
    iconName: "Ticket",
  },
  {
    slug: "organising-events",
    title: "Organising events",
    description: "Create events, manage sales, and get paid.",
    iconName: "Calendar",
  },
  {
    slug: "account",
    title: "Account & settings",
    description: "Profile, security, and notifications.",
    iconName: "User",
  },
  {
    slug: "troubleshooting",
    title: "Troubleshooting",
    description: "Common issues and quick fixes.",
    iconName: "HelpCircle",
  },
];

export const getCategoryBySlug = (slug: string): CategoryMeta | undefined =>
  CATEGORIES.find((c) => c.slug === slug);
