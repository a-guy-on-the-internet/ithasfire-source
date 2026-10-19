# Cloudflare R2 File Storage Adapter (DEPRECATED)

> **This adapter path is deprecated.** Import from `@th/adapters/file-storage/s3` instead.
> See [`../s3/README.md`](../s3/README.md) for the current documentation.
>
> The `cloudflare-r2/` directory only exists as a backward-compatibility shim that
> re-exports `S3FileStorageAdapter` under the old name. It will be removed in a future release.
>
> `index.ts` is the shim. `r2-adapter.ts` in this folder is an older standalone copy of the adapter that `index.ts` does not export. Only tests still import it: `../__tests__/request-timeouts.test.ts`, `./__tests__/r2-adapter.contract.test.ts` and `./__tests__/r2-not-found-orphans-moderation.test.ts`. A doc comment in `packages/core/src/use-cases/moderation/get-moderation-queue-snapshot.ts` also cites it.
