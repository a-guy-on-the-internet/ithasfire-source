/**
 * Maps server-side error codes/messages to operator-friendly copy
 * suitable for surfacing in toasts, banners, or accessibility
 * announcements.
 *
 * Strings are inlined per-locale below. The scanner does not yet have
 * an i18n runtime — `getMessages()` defaults to English. When the
 * proper i18n layer lands, replace `detectLanguage()` with a hook
 * into it; the public API (`friendlyError`) and the message table
 * stay as-is.
 */

type Lang = "en" | "es";

const detectLanguage = (): Lang => "en";

type ErrorEntry = { title: string; message: string };

const TABLE: Record<Lang, Record<string, ErrorEntry>> = {
  en: {
    // ── Generic ───────────────────────────────────────────────
    fallback: {
      title: "Something went wrong",
      message: "Please try again. If it keeps happening, ask an admin.",
    },
    network: {
      title: "Network error",
      message: "Check your connection and try again.",
    },
    unauthorized: {
      title: "Signed out",
      message: "Your session expired. Please sign in again.",
    },
    forbidden: {
      title: "Not allowed",
      message: "You don't have permission to do that here.",
    },
    not_authorized: {
      title: "Not allowed",
      message: "You don't have permission to do that here.",
    },

    // ── Tickets / scan ────────────────────────────────────────
    event_not_found: {
      title: "Event missing",
      message: "This event isn't available. Pick another from the home screen.",
    },
    ticket_not_found: {
      title: "Ticket not found",
      message: "We couldn't find this ticket for the selected event.",
    },
    already_scanned: {
      title: "Already scanned",
      message: "This ticket was already used to enter.",
    },
    wrong_event: {
      title: "Wrong event",
      message: "This ticket is for a different event.",
    },
    idempotency_key_conflict: {
      title: "Duplicate scan",
      message: "We already processed this scan.",
    },

    // ── Volunteer ────────────────────────────────────────────
    signup_not_found: {
      title: "Volunteer not found",
      message: "We couldn't find this volunteer signup.",
    },
    signup_not_approved: {
      title: "Not approved",
      message: "This volunteer signup hasn't been approved yet.",
    },
    role_not_found: {
      title: "Role missing",
      message: "That volunteer role no longer exists.",
    },
    shift_not_found: {
      title: "Shift missing",
      message: "That shift no longer exists.",
    },

    // ── POS ──────────────────────────────────────────────────
    payee_not_connected: {
      title: "Payouts not set up",
      message: "Ask an admin to finish Stripe Connect onboarding for this org.",
    },
    payee_missing_stripe_account: {
      title: "Payouts not set up",
      message: "Ask an admin to finish Stripe Connect onboarding for this org.",
    },
    event_not_org_owned: {
      title: "Personal event",
      message: "POS is only available for org-owned events.",
    },
    no_scanner_role_on_event_org: {
      title: "Not allowed",
      message: "You don't have a scanner role for this event's organization.",
    },
  },
  es: {
    fallback: {
      title: "Algo salió mal",
      message: "Inténtalo de nuevo. Si persiste, contacta a un administrador.",
    },
    network: {
      title: "Error de red",
      message: "Revisa tu conexión e inténtalo de nuevo.",
    },
    unauthorized: {
      title: "Sesión cerrada",
      message: "Tu sesión expiró. Inicia sesión de nuevo.",
    },
    forbidden: {
      title: "No permitido",
      message: "No tienes permiso para hacer eso aquí.",
    },
    not_authorized: {
      title: "No permitido",
      message: "No tienes permiso para hacer eso aquí.",
    },

    event_not_found: {
      title: "Evento no encontrado",
      message:
        "Este evento no está disponible. Elige otro en la pantalla principal.",
    },
    ticket_not_found: {
      title: "Boleto no encontrado",
      message: "No encontramos este boleto para el evento seleccionado.",
    },
    already_scanned: {
      title: "Ya escaneado",
      message: "Este boleto ya se usó para entrar.",
    },
    wrong_event: {
      title: "Evento equivocado",
      message: "Este boleto es para otro evento.",
    },
    idempotency_key_conflict: {
      title: "Escaneo duplicado",
      message: "Ya procesamos este escaneo.",
    },

    signup_not_found: {
      title: "Voluntario no encontrado",
      message: "No encontramos este registro de voluntario.",
    },
    signup_not_approved: {
      title: "No aprobado",
      message: "Este registro de voluntario aún no ha sido aprobado.",
    },
    role_not_found: {
      title: "Rol no encontrado",
      message: "Ese rol de voluntario ya no existe.",
    },
    shift_not_found: {
      title: "Turno no encontrado",
      message: "Ese turno ya no existe.",
    },

    payee_not_connected: {
      title: "Pagos no configurados",
      message:
        "Pide a un administrador que complete la configuración de Stripe Connect.",
    },
    payee_missing_stripe_account: {
      title: "Pagos no configurados",
      message:
        "Pide a un administrador que complete la configuración de Stripe Connect.",
    },
    event_not_org_owned: {
      title: "Evento personal",
      message: "El POS solo está disponible para eventos de organizaciones.",
    },
    no_scanner_role_on_event_org: {
      title: "No permitido",
      message: "No tienes rol de escáner para la organización de este evento.",
    },
  },
};

/**
 * Best-effort extraction of a stable error code from arbitrary throwables.
 * Recognises:
 *   - tRPC-shaped errors with `data.code` (UNAUTHORIZED, FORBIDDEN, etc.)
 *   - Use-case throws of `{ code, message }`
 *   - Plain `Error` whose `.message` matches a known key
 *   - Fetch failures (network)
 */
const extractKey = (err: unknown): string => {
  if (!err) return "fallback";

  // tRPC client error: { data: { code: "UNAUTHORIZED" }, message: "unauthorized" }
  const trpcCode = (err as { data?: { code?: string } }).data?.code;
  if (typeof trpcCode === "string") {
    const lower = trpcCode.toLowerCase();
    if (lower === "unauthorized") return "unauthorized";
    if (lower === "forbidden") return "forbidden";
  }

  // Use-case throws: `{ code, message }` plain objects
  const useCaseMessage = (err as { message?: string }).message;
  if (typeof useCaseMessage === "string" && useCaseMessage in TABLE.en) {
    return useCaseMessage;
  }

  // Network failures from fetch
  if (
    typeof useCaseMessage === "string" &&
    /network|fetch/i.test(useCaseMessage)
  ) {
    return "network";
  }

  return "fallback";
};

let cachedLang: Lang | null = null;
const getMessages = (): Record<string, ErrorEntry> => {
  if (cachedLang === null) cachedLang = detectLanguage();
  return TABLE[cachedLang];
};

export function friendlyError(err: unknown): ErrorEntry {
  const key = extractKey(err);
  const messages = getMessages();
  return messages[key] ?? messages.fallback;
}
