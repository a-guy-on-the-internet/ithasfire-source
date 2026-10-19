"use client";

import { useCallback, useMemo, useRef, useState } from "react";
import { useParams, useSearchParams } from "next/navigation";
import { useRouter } from "@bprogress/next/app";
import { YStack, XStack } from "tamagui";
import {
  DataTable,
  type DataTableColumn,
  Button,
  Text,
  TextInput,
  Spinner,
  FormErrorBanner,
  useNotify,
} from "@th/ui";
import { ArrowLeft, Upload, CheckCircle, AlertTriangle } from "lucide-react";

import { trpc } from "@/trpc";
import { useFormErrors } from "@/hooks/useFormErrors";
import { useCurrentAdminOwner } from "@/hooks/useCurrentAdminOwner";
import { useTranslations } from "@th/ui";

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const CHUNK_SIZE = 5_000;

const KNOWN_EMAIL_HEADERS = [
  "email",
  "e-mail",
  "email_address",
  "emailaddress",
  "contact_email",
  "contactemail",
];
const KNOWN_PHONE_HEADERS = [
  "phone",
  "telephone",
  "phone_number",
  "phonenumber",
  "mobile",
  "contact_phone",
  "contactphone",
];
const KNOWN_NAME_HEADERS = [
  "name",
  "display_name",
  "displayname",
  "full_name",
  "fullname",
  "first_name",
  "firstname",
];
const KNOWN_NOTES_HEADERS = ["notes", "note", "comment", "comments"];

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

type MappableField =
  | "contactEmail"
  | "contactPhone"
  | "displayName"
  | "notes"
  | "skip";

interface ColumnMapping {
  sourceHeader: string;
  targetField: MappableField;
}

interface ParsedRow {
  [header: string]: string;
}

interface ContactEntry {
  contactEmail?: string | null;
  contactPhone?: string | null;
  displayName?: string | null;
  notes?: string | null;
}

type ImportStep = "upload" | "mapping" | "preview" | "uploading" | "done";

interface UploadProgress {
  currentChunk: number;
  totalChunks: number;
  importedCount: number;
  skippedCount: number;
  linkedCount: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// CSV parser (simple, handles quoted fields)
// ─────────────────────────────────────────────────────────────────────────────

function parseCSV(text: string): { headers: string[]; rows: ParsedRow[] } {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length === 0) return { headers: [], rows: [] };

  const parseLine = (line: string): string[] => {
    const result: string[] = [];
    let current = "";
    let inQuotes = false;

    for (let i = 0; i < line.length; i++) {
      const char = line[i];
      if (inQuotes) {
        if (char === '"') {
          if (i + 1 < line.length && line[i + 1] === '"') {
            current += '"';
            i++;
          } else {
            inQuotes = false;
          }
        } else {
          current += char;
        }
      } else if (char === '"') {
        inQuotes = true;
      } else if (char === ",") {
        result.push(current.trim());
        current = "";
      } else {
        current += char;
      }
    }
    result.push(current.trim());
    return result;
  };

  const headers = parseLine(lines[0]);
  const rows: ParsedRow[] = [];

  for (let i = 1; i < lines.length; i++) {
    const values = parseLine(lines[i]);
    const row: ParsedRow = {};
    for (let j = 0; j < headers.length; j++) {
      row[headers[j]] = values[j] ?? "";
    }
    rows.push(row);
  }

  return { headers, rows };
}

// ─────────────────────────────────────────────────────────────────────────────
// Auto-detect column mappings
// ─────────────────────────────────────────────────────────────────────────────

function autoDetectMappings(headers: string[]): ColumnMapping[] {
  return headers.map((h) => {
    const lower = h.toLowerCase().replace(/[^a-z0-9]/g, "");
    if (
      KNOWN_EMAIL_HEADERS.some((k) => k.replace(/[^a-z0-9]/g, "") === lower)
    ) {
      return { sourceHeader: h, targetField: "contactEmail" as const };
    }
    if (
      KNOWN_PHONE_HEADERS.some((k) => k.replace(/[^a-z0-9]/g, "") === lower)
    ) {
      return { sourceHeader: h, targetField: "contactPhone" as const };
    }
    if (KNOWN_NAME_HEADERS.some((k) => k.replace(/[^a-z0-9]/g, "") === lower)) {
      return { sourceHeader: h, targetField: "displayName" as const };
    }
    if (
      KNOWN_NOTES_HEADERS.some((k) => k.replace(/[^a-z0-9]/g, "") === lower)
    ) {
      return { sourceHeader: h, targetField: "notes" as const };
    }
    return { sourceHeader: h, targetField: "skip" as const };
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Component
// ─────────────────────────────────────────────────────────────────────────────

export function AudienceImport() {
  const t = useTranslations();
  const { toast } = useNotify();
  const { formError, setError, clearAll } = useFormErrors();
  const router = useRouter();
  const { slug } = useParams<{ slug: string }>();
  const searchParams = useSearchParams();
  const preselectedListId = searchParams.get("listId");
  const { currentOwner, isLoading: ownerLoading } = useCurrentAdminOwner(slug);

  const ownerInput = useMemo(() => {
    if (!currentOwner) return null;
    return currentOwner.kind === "human"
      ? { kind: "HUMAN" as const, id: currentOwner.humanId }
      : { kind: "ORG" as const, id: currentOwner.orgId };
  }, [currentOwner]);

  // ── Audience list for target picker ───────────────────────────────────

  const { data: audiences } = trpc.comms.listAudiences.useQuery(
    { owner: ownerInput! },
    { enabled: !!ownerInput, staleTime: 30_000 },
  );

  // ── State machine ─────────────────────────────────────────────────────

  const [step, setStep] = useState<ImportStep>("upload");
  const [fileName, setFileName] = useState("");
  const [fileFormat, setFileFormat] = useState<"CSV" | "XLSX">("CSV");
  const [headers, setHeaders] = useState<string[]>([]);
  const [parsedRows, setParsedRows] = useState<ParsedRow[]>([]);
  const [mappings, setMappings] = useState<ColumnMapping[]>([]);
  const [targetListId, setTargetListId] = useState(preselectedListId ?? "");
  const [newListName, setNewListName] = useState("");
  const [clearExisting, setClearExisting] = useState(false);
  const [progress, setProgress] = useState<UploadProgress | null>(null);
  const [resultListId, setResultListId] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const abortRef = useRef(false);

  const importMutation = trpc.comms.importContacts.useMutation({
    meta: { silent: true },
  });

  // ── File selection ────────────────────────────────────────────────────

  const handleFileSelect = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;

      const name = file.name;
      setFileName(name);

      const ext = name.split(".").pop()?.toLowerCase();

      if (ext === "csv" || ext === "tsv" || ext === "txt") {
        setFileFormat("CSV");
        const text = await file.text();
        const { headers: h, rows } = parseCSV(text);
        if (h.length === 0) {
          toast.danger({
            id: "import-parse-error",
            title: t("admin.importParseError") as string,
            message: t("admin.importParseErrorMessage") as string,
          });
          return;
        }
        setHeaders(h);
        setParsedRows(rows);
        setMappings(autoDetectMappings(h));
        setStep("mapping");
      } else if (ext === "xlsx" || ext === "xls") {
        setFileFormat("XLSX");
        toast.danger({
          id: "import-xlsx-unsupported",
          title: t("admin.importXlsxTitle") as string,
          message: t("admin.importXlsxMessage") as string,
        });
      } else {
        toast.danger({
          id: "import-unsupported-format",
          title: t("admin.importUnsupportedTitle") as string,
          message: t("admin.importUnsupportedMessage") as string,
        });
      }
    },
    [toast],
  );

  // ── Mapping changes ───────────────────────────────────────────────────

  const updateMapping = useCallback((index: number, field: MappableField) => {
    setMappings((prev) => {
      const next = [...prev];
      next[index] = { ...next[index], targetField: field };
      return next;
    });
  }, []);

  const hasEmailMapping = mappings.some(
    (m) => m.targetField === "contactEmail",
  );
  const hasPhoneMapping = mappings.some(
    (m) => m.targetField === "contactPhone",
  );
  const hasContactField = hasEmailMapping || hasPhoneMapping;

  // ── Map rows to contacts ──────────────────────────────────────────────

  const mappedContacts = useMemo<ContactEntry[]>(() => {
    return parsedRows.map((row) => {
      const entry: ContactEntry = {};
      for (const m of mappings) {
        if (m.targetField === "skip") continue;
        const val = row[m.sourceHeader]?.trim() || null;
        if (val) {
          entry[m.targetField] = val;
        }
      }
      return entry;
    });
  }, [parsedRows, mappings]);

  // ── Validation counts ─────────────────────────────────────────────────

  const validContacts = useMemo(
    () => mappedContacts.filter((c) => c.contactEmail || c.contactPhone),
    [mappedContacts],
  );

  const invalidCount = mappedContacts.length - validContacts.length;

  // ── Preview columns ───────────────────────────────────────────────────

  const previewColumns = useMemo<DataTableColumn<ContactEntry>[]>(() => {
    const cols: DataTableColumn<ContactEntry>[] = [];
    if (hasEmailMapping) {
      cols.push({
        id: "contactEmail",
        header: String(t("admin.importFieldEmail")),
        cell: (row) => (
          <Text fontSize="$2">{row.contactEmail ?? "\u2014"}</Text>
        ),
      });
    }
    if (hasPhoneMapping) {
      cols.push({
        id: "contactPhone",
        header: String(t("admin.importFieldPhone")),
        cell: (row) => (
          <Text fontSize="$2">{row.contactPhone ?? "\u2014"}</Text>
        ),
      });
    }
    const hasName = mappings.some((m) => m.targetField === "displayName");
    if (hasName) {
      cols.push({
        id: "displayName",
        header: String(t("admin.importFieldName")),
        cell: (row) => <Text fontSize="$2">{row.displayName ?? "\u2014"}</Text>,
      });
    }
    return cols;
  }, [mappings, hasEmailMapping, hasPhoneMapping]);

  // ── Chunked upload ────────────────────────────────────────────────────

  const startUpload = useCallback(async () => {
    if (!ownerInput) return;
    clearAll();
    abortRef.current = false;

    const contacts = validContacts;
    const totalChunks = Math.ceil(contacts.length / CHUNK_SIZE);
    const clientKey = `import-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

    setStep("uploading");
    setProgress({
      currentChunk: 0,
      totalChunks,
      importedCount: 0,
      skippedCount: 0,
      linkedCount: 0,
    });

    let importId: string | undefined;
    let inviteListId: string | undefined;
    let runningImported = 0;
    let runningSkipped = 0;
    let runningLinked = 0;

    try {
      for (let i = 0; i < totalChunks; i++) {
        if (abortRef.current) break;

        const chunk = contacts.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE);
        const isFinal = i === totalChunks - 1;

        const result = await importMutation.mutateAsync({
          owner: ownerInput,
          importId,
          targetListId: targetListId || undefined,
          targetListName: !targetListId
            ? newListName.trim() || fileName.replace(/\.[^.]+$/, "")
            : undefined,
          fileName,
          fileFormat,
          contacts: chunk,
          totalRows: contacts.length,
          totalChunks,
          chunkIndex: i,
          isFinalChunk: isFinal,
          clientKey: `${clientKey}-chunk-${i}`,
          ...(i === 0 && clearExisting && targetListId
            ? { clearExisting: true }
            : {}),
        });

        importId = result.importId;
        inviteListId = result.inviteListId;
        runningImported = result.runningImportedCount;
        runningSkipped = result.runningSkippedCount;
        runningLinked += result.linkedToAuthUserCount;

        setProgress({
          currentChunk: i + 1,
          totalChunks,
          importedCount: runningImported,
          skippedCount: runningSkipped,
          linkedCount: runningLinked,
        });
      }

      if (!abortRef.current && inviteListId) {
        setResultListId(inviteListId);
        setStep("done");
        toast.success({
          id: "import-complete",
          title: t("admin.importComplete") as string,
          message: t("admin.importCompleteMessage", {
            imported: runningImported.toLocaleString(),
            skipped: runningSkipped.toLocaleString(),
          }) as string,
        });
      }
    } catch (err) {
      setError(err);
      setStep("preview");
    }
  }, [
    ownerInput,
    validContacts,
    targetListId,
    newListName,
    clearExisting,
    fileName,
    fileFormat,
    importMutation,
    toast,
    clearAll,
    setError,
  ]);

  // ── Render ────────────────────────────────────────────────────────────

  if (ownerLoading) {
    return (
      <YStack flex={1} alignItems="center" justifyContent="center" padding="$8">
        <Spinner size="lg" />
      </YStack>
    );
  }

  if (!ownerInput) {
    return (
      <YStack padding="$4">
        <Text>{String(t("admin.importUnableToDetermineOwner"))}</Text>
      </YStack>
    );
  }

  return (
    <YStack flex={1} gap="$4" padding="$4">
      {/* Header */}
      <XStack gap="$3" alignItems="center">
        <Button
          size="$2"
          variant="ghost"
          icon
          onPress={() => router.push(`/admin/${slug}/audiences`)}
        >
          <ArrowLeft size={16} />
        </Button>
        <Text variant="h5" weight="bold">
          {String(t("admin.importContactsHeading"))}
        </Text>
      </XStack>

      <FormErrorBanner message={formError} onDismiss={clearAll} />

      {/* ── Step: Upload ─────────────────────────────────────────── */}
      {step === "upload" && (
        <YStack
          alignItems="center"
          justifyContent="center"
          padding="$8"
          gap="$4"
          borderWidth={2}
          borderColor="$borderColor"
          borderRadius="$0"
          borderStyle="dashed"
          maxWidth={600}
          alignSelf="center"
          width="100%"
        >
          <Upload size={40} color="var(--colorMuted)" />
          <Text weight="bold" variant="h6">
            {String(t("admin.importUploadTitle"))}
          </Text>
          <Text tone="muted" textAlign="center" fontSize="$2">
            {String(t("admin.importUploadDescription"))}
          </Text>
          <input
            ref={fileInputRef}
            type="file"
            accept=".csv,.tsv,.txt,.xlsx,.xls"
            onChange={handleFileSelect}
            style={{ display: "none" }}
          />
          <Button size="$3" onPress={() => fileInputRef.current?.click()}>
            {String(t("admin.importChooseFile"))}
          </Button>
        </YStack>
      )}

      {/* ── Step: Column mapping ─────────────────────────────────── */}
      {step === "mapping" && (
        <YStack gap="$4" maxWidth={700}>
          <YStack gap="$1">
            <Text variant="h6" weight="bold">
              {String(t("admin.importMapColumns"))}
            </Text>
            <Text fontSize="$2" tone="muted">
              {String(
                t("admin.importMapDescription", {
                  fileName,
                  rowCount: parsedRows.length.toLocaleString(),
                }),
              )}
            </Text>
          </YStack>

          <YStack
            gap="$2"
            borderWidth={2}
            borderColor="$borderColor"
            borderRadius={0}
            padding="$3"
          >
            {mappings.map((m, idx) => (
              <XStack
                key={m.sourceHeader}
                gap="$3"
                alignItems="center"
                paddingVertical="$1"
              >
                <Text variant="bodySmall" weight="medium" width={160} truncate>
                  {m.sourceHeader}
                </Text>
                <Text fontSize="$2" tone="muted">
                  {"\u2192"}
                </Text>
                <XStack gap="$1" flexWrap="wrap">
                  {(
                    [
                      "contactEmail",
                      "contactPhone",
                      "displayName",
                      "notes",
                      "skip",
                    ] as MappableField[]
                  ).map((field) => (
                    <Button
                      key={field}
                      size="$1"
                      variant={m.targetField === field ? "primary" : "subtle"}
                      onPress={() => updateMapping(idx, field)}
                    >
                      {field === "contactEmail"
                        ? String(t("admin.importFieldEmail"))
                        : field === "contactPhone"
                          ? String(t("admin.importFieldPhone"))
                          : field === "displayName"
                            ? String(t("admin.importFieldName"))
                            : field === "notes"
                              ? String(t("admin.importFieldNotes"))
                              : String(t("admin.importFieldSkip"))}
                    </Button>
                  ))}
                </XStack>
              </XStack>
            ))}
          </YStack>

          {!hasContactField && (
            <XStack gap="$2" alignItems="center">
              <AlertTriangle size={16} color="var(--danger)" />
              <Text tone="error" fontSize="$2">
                {String(t("admin.importMustMapWarning"))}
              </Text>
            </XStack>
          )}

          <XStack gap="$2" justifyContent="flex-end">
            <Button
              size="$2"
              variant="ghost"
              onPress={() => {
                setStep("upload");
                setHeaders([]);
                setParsedRows([]);
                setMappings([]);
              }}
            >
              {String(t("admin.importStartOver"))}
            </Button>
            <Button
              size="$2"
              onPress={() => setStep("preview")}
              disabled={!hasContactField}
            >
              {String(t("admin.importContinue"))}
            </Button>
          </XStack>
        </YStack>
      )}

      {/* ── Step: Preview + target ───────────────────────────────── */}
      {step === "preview" && (
        <YStack gap="$4">
          {/* Target selection */}
          <YStack gap="$2" maxWidth={500}>
            <Text variant="h6" weight="bold">
              {String(t("admin.importDestination"))}
            </Text>
            <Text fontSize="$2" tone="muted">
              {String(t("admin.importDestinationDescription"))}
            </Text>

            <XStack gap="$2" flexWrap="wrap" paddingTop="$1">
              <Button
                size="$1"
                variant={!targetListId ? "primary" : "subtle"}
                onPress={() => setTargetListId("")}
              >
                {String(t("admin.importNewAudience"))}
              </Button>
              {(audiences ?? []).map((a) => (
                <Button
                  key={a.id}
                  size="$1"
                  variant={targetListId === a.id ? "primary" : "subtle"}
                  onPress={() => setTargetListId(a.id)}
                >
                  {a.name}
                </Button>
              ))}
            </XStack>

            {!targetListId && (
              <TextInput
                value={newListName}
                onChangeText={setNewListName}
                placeholder={
                  t("admin.importAudienceNamePlaceholder", {
                    fallback: fileName.replace(/\.[^.]+$/, ""),
                  }) as string
                }
              />
            )}
          </YStack>

          {/* Import mode (only relevant for existing audiences) */}
          {targetListId && (
            <YStack gap="$2" maxWidth={500}>
              <Text variant="h6" weight="bold">
                {String(t("admin.importMode"))}
              </Text>
              <Text fontSize="$2" tone="muted">
                {String(t("admin.importModeDescription"))}
              </Text>
              <XStack gap="$2" paddingTop="$1">
                <Button
                  size="$1"
                  variant={!clearExisting ? "primary" : "subtle"}
                  onPress={() => setClearExisting(false)}
                >
                  {String(t("admin.importModeAppend"))}
                </Button>
                <Button
                  size="$1"
                  variant={clearExisting ? "primary" : "subtle"}
                  onPress={() => setClearExisting(true)}
                >
                  {String(t("admin.importModeReplace"))}
                </Button>
              </XStack>
              <Text fontSize="$1" tone="muted">
                {clearExisting
                  ? String(t("admin.importReplaceWarning"))
                  : String(t("admin.importAppendInfo"))}
              </Text>
            </YStack>
          )}

          {/* Stats */}
          <XStack gap="$4" flexWrap="wrap">
            <YStack gap="$1">
              <Text fontSize="$2" tone="muted">
                {String(t("admin.importTotalRows"))}
              </Text>
              <Text weight="bold">{parsedRows.length.toLocaleString()}</Text>
            </YStack>
            <YStack gap="$1">
              <Text fontSize="$2" tone="muted">
                {String(t("admin.importValidContacts"))}
              </Text>
              <Text weight="bold" tone="success">
                {validContacts.length.toLocaleString()}
              </Text>
            </YStack>
            {invalidCount > 0 && (
              <YStack gap="$1">
                <Text fontSize="$2" tone="muted">
                  {String(t("admin.importSkippedNoContact"))}
                </Text>
                <Text weight="bold" tone="warning">
                  {invalidCount.toLocaleString()}
                </Text>
              </YStack>
            )}
          </XStack>

          {/* Preview table (first 20) */}
          {previewColumns.length > 0 && validContacts.length > 0 && (
            <YStack gap="$2">
              <Text variant="label" weight="medium">
                {String(t("admin.importPreviewLabel"))}
              </Text>
              <DataTable
                rows={validContacts.slice(0, 20)}
                columns={previewColumns}
                getRowKey={(_row, i) => String(i)}
                // Borderless wizard preview with no scrolling ancestor —
                // scoped horizontal panning via DataTable's own wrapper.
                scrollContainer
              />
            </YStack>
          )}

          {/* Actions */}
          <XStack gap="$2" justifyContent="flex-end">
            <Button
              size="$2"
              variant="ghost"
              onPress={() => setStep("mapping")}
            >
              {String(t("admin.importBack"))}
            </Button>
            <Button
              size="$2"
              onPress={startUpload}
              disabled={validContacts.length === 0}
              variant={clearExisting ? "destructive" : undefined}
            >
              {clearExisting
                ? String(
                    t("admin.importReplaceAction", {
                      count: validContacts.length.toLocaleString(),
                    }),
                  )
                : String(
                    t("admin.importAction", {
                      count: validContacts.length.toLocaleString(),
                    }),
                  )}
            </Button>
          </XStack>
        </YStack>
      )}

      {/* ── Step: Uploading ──────────────────────────────────────── */}
      {step === "uploading" && progress && (
        <YStack
          alignItems="center"
          justifyContent="center"
          padding="$8"
          gap="$4"
          maxWidth={500}
          alignSelf="center"
          width="100%"
        >
          <Spinner size="lg" />
          <Text weight="bold" variant="h6">
            {String(t("admin.importImporting"))}
          </Text>
          <Text tone="muted" textAlign="center">
            {String(
              t("admin.importChunkProgress", {
                current: progress.currentChunk,
                total: progress.totalChunks,
              }),
            )}
          </Text>

          {/* Simple progress bar */}
          <YStack
            width="100%"
            height={8}
            borderRadius="$0"
            backgroundColor="$surfaceMuted"
            overflow="hidden"
          >
            <YStack
              height="100%"
              borderRadius="$0"
              backgroundColor="$accent"
              width={`${Math.round((progress.currentChunk / progress.totalChunks) * 100)}%`}
              animation="fast"
            />
          </YStack>

          <XStack gap="$4">
            <YStack alignItems="center">
              <Text weight="bold">
                {progress.importedCount.toLocaleString()}
              </Text>
              <Text fontSize="$1" tone="muted">
                {String(t("admin.importProgressImported"))}
              </Text>
            </YStack>
            <YStack alignItems="center">
              <Text weight="bold">
                {progress.skippedCount.toLocaleString()}
              </Text>
              <Text fontSize="$1" tone="muted">
                {String(t("admin.importProgressSkipped"))}
              </Text>
            </YStack>
            <YStack alignItems="center">
              <Text weight="bold">{progress.linkedCount.toLocaleString()}</Text>
              <Text fontSize="$1" tone="muted">
                {String(t("admin.importProgressLinked"))}
              </Text>
            </YStack>
          </XStack>
        </YStack>
      )}

      {/* ── Step: Done ───────────────────────────────────────────── */}
      {step === "done" && progress && (
        <YStack
          alignItems="center"
          justifyContent="center"
          padding="$8"
          gap="$4"
          maxWidth={500}
          alignSelf="center"
          width="100%"
        >
          <CheckCircle size={48} color="var(--success)" />
          <Text weight="bold" variant="h5">
            {String(t("admin.importCompleteTitle"))}
          </Text>

          <XStack gap="$4">
            <YStack alignItems="center">
              <Text weight="bold" variant="h6">
                {progress.importedCount.toLocaleString()}
              </Text>
              <Text fontSize="$2" tone="muted">
                {String(t("admin.importProgressImported"))}
              </Text>
            </YStack>
            <YStack alignItems="center">
              <Text weight="bold" variant="h6">
                {progress.skippedCount.toLocaleString()}
              </Text>
              <Text fontSize="$2" tone="muted">
                {String(t("admin.importDuplicatesSkipped"))}
              </Text>
            </YStack>
            <YStack alignItems="center">
              <Text weight="bold" variant="h6">
                {progress.linkedCount.toLocaleString()}
              </Text>
              <Text fontSize="$2" tone="muted">
                {String(t("admin.importLinkedToAccounts"))}
              </Text>
            </YStack>
          </XStack>

          <XStack gap="$2" paddingTop="$2">
            {resultListId && (
              <Button
                size="$3"
                onPress={() =>
                  router.push(`/admin/${slug}/audiences/${resultListId}`)
                }
              >
                {String(t("admin.importViewAudience"))}
              </Button>
            )}
            <Button
              size="$3"
              variant="secondary"
              onPress={() => {
                setStep("upload");
                setFileName("");
                setHeaders([]);
                setParsedRows([]);
                setMappings([]);
                setProgress(null);
                setResultListId(null);
                setClearExisting(false);
              }}
            >
              {String(t("admin.importAnother"))}
            </Button>
          </XStack>
        </YStack>
      )}
    </YStack>
  );
}
