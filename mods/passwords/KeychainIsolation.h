#ifndef ARCMOD_KEYCHAIN_ISOLATION_H
#define ARCMOD_KEYCHAIN_ISOLATION_H
#import <Foundation/Foundation.h>
// Decides once per process, using the same rules as resolveSecretStorage() in
// tools/password-keychain.ts. Login mode rewrites Chromium's safe-storage lookup
// onto this app's own keychain item so Arc's item is left alone.
BOOL ArcModResolveSecretStorage(void);
BOOL ArcModUsesLoginKeychain(void);
#endif
