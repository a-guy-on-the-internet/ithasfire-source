// The icon registry — the swap seam.
//
// `Icon` renders glyphs by NAME, and this file is the only place a name is
// bound to a concrete drawing. That indirection is the whole point: the design
// system's Gate 1 pick is Material Symbols Sharp (square caps, mitred joins —
// the only maintained set that agrees with `radius: 0`), and Lucide's rounded
// caps are the last curve left in a zero-radius system. Swapping sets should be
// an edit to this file, not a sweep of 455 call sites.
//
// Names are set-agnostic and describe the THING, not the drawing: `calendar`,
// not `CalendarDays`. When the swap happens, the right-hand side changes and
// nothing else does.
//
// Adding a name: import the Lucide component, add the entry, done. Names are
// deliberately curated rather than exhaustive — a registry that re-exports all
// of Lucide would defeat tree-shaking and stop being a decision record. For a
// glyph that has no name yet, `Icon`'s `as` prop takes the component directly;
// see the note on migration in `Icon.tsx`.
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  ArrowUpRight,
  Ban,
  Banknote,
  Bell,
  Calendar,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Clock,
  Copy,
  CreditCard,
  Download,
  ExternalLink,
  Eye,
  EyeOff,
  Filter,
  Info,
  Link as LinkGlyph,
  ListFilter,
  MapPin,
  Menu,
  MessageCircle,
  Minus,
  MoreHorizontal,
  MoreVertical,
  Pencil,
  Plus,
  QrCode,
  RefreshCw,
  Search,
  Settings,
  Share2,
  ShoppingCart,
  Ticket,
  Trash2,
  Upload,
  User,
  Users,
  X,
} from "lucide-react";

import type { ComponentType } from "react";

/** The shape every registry entry satisfies, on any icon set. */
export type IconGlyph = ComponentType<{
  size?: number | string;
  strokeWidth?: number;
  color?: string;
  fill?: string;
  "aria-hidden"?: boolean | "true" | "false";
  focusable?: boolean | "true" | "false";
  className?: string;
}>;

export const iconRegistry = {
  // ── Objects and context (LEADING icons) ──────────────────────────────────
  // "This is about a thing." Per the button grammar, these sit before a label.
  calendar: Calendar,
  clock: Clock,
  ticket: Ticket,
  user: User,
  users: Users,
  venue: MapPin,
  search: Search,
  money: Banknote,
  card: CreditCard,
  cart: ShoppingCart,
  qr: QrCode,
  bell: Bell,
  message: MessageCircle,
  settings: Settings,
  filter: Filter,
  filterList: ListFilter,

  // ── Direction and progression (TRAILING icons) ───────────────────────────
  // "This takes you somewhere." These sit after a label, and never with a
  // leading icon in the same control — one icon max per button.
  arrowLeft: ArrowLeft,
  arrowRight: ArrowRight,
  arrowUpRight: ArrowUpRight,
  chevronUp: ChevronUp,
  chevronDown: ChevronDown,
  chevronLeft: ChevronLeft,
  chevronRight: ChevronRight,
  externalLink: ExternalLink,

  // ── Actions ──────────────────────────────────────────────────────────────
  add: Plus,
  remove: Minus,
  edit: Pencil,
  delete: Trash2,
  copy: Copy,
  link: LinkGlyph,
  share: Share2,
  upload: Upload,
  download: Download,
  refresh: RefreshCw,
  close: X,
  check: Check,
  menu: Menu,
  more: MoreHorizontal,
  moreVertical: MoreVertical,
  show: Eye,
  hide: EyeOff,

  // ── Status ───────────────────────────────────────────────────────────────
  // Never the sole carrier of a status — the word travels with it. See D-074.
  info: Info,
  warning: AlertTriangle,
  blocked: Ban,
} satisfies Record<string, IconGlyph>;

export type IconName = keyof typeof iconRegistry;

/** Every registered name, for tests and story fixtures. */
export const iconNames = Object.keys(iconRegistry) as IconName[];
