export * from "./account-state.js";
export * from "./client.js";
export * from "./config.js";
export * from "./directory-reader.js";
export * from "./errors.js";
export * from "./filter.js";
export * from "./identity.js";
export * from "./register.js";
export * from "./roles.js";
export * from "./transport.js";

/**
 * `ldapts-client.ts` is intentionally NOT re-exported.
 *
 * It is the only module that opens a socket, and exporting it would invite a
 * caller to construct a client with its own TLS options — which is exactly the
 * decision this package refuses to delegate (there is no way to disable
 * certificate verification here, and that must stay true from the outside too).
 * The composition root reaches it through `createLdapIdentityProvider` /
 * `createLdapDirectoryReader` in `register.ts`, which always vet the transport.
 */
