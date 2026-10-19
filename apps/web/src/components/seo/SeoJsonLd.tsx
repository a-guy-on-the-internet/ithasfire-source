type JsonLdInput = Record<string, unknown> | Array<Record<string, unknown>>;

export type SeoJsonLdProps = {
  data: JsonLdInput;
  id?: string;
  nonce?: string;
};

const serialize = (value: JsonLdInput): string => {
  // JSON.stringify doesn't prevent the literal substring "</script>" from appearing inside
  // string values. When this JSON is embedded into a <script type="application/ld+json"> tag,
  // a literal "</script>" would terminate the tag early and can enable XSS.
  //
  // Escaping '<' is the key mitigation (prevents "</script>"). Escaping '>' and '&' is a common
  // additional hardening step.
  return JSON.stringify(value, null, 2)
    .replaceAll("&", "\\u0026")
    .replaceAll("<", "\\u003c")
    .replaceAll(">", "\\u003e");
};

export function SeoJsonLd({ data, id, nonce }: SeoJsonLdProps) {
  const json = serialize(data);

  return (
    <script
      type="application/ld+json"
      suppressHydrationWarning
      {...(id ? { id } : {})}
      {...(nonce ? { nonce } : {})}
      dangerouslySetInnerHTML={{ __html: json }}
    />
  );
}
