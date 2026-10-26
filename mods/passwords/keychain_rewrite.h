#ifndef ARCMOD_KEYCHAIN_REWRITE_H
#define ARCMOD_KEYCHAIN_REWRITE_H
#include <stddef.h>
#include <stdbool.h>
// True when Chromium is asking for Arc's, Chrome's, or Chromium's OSCrypt keychain item.
// Lengths are explicit: SecKeychain callers do not promise a trailing NUL.
bool ArcModBrowserSafeStoragePair(const char *service, size_t service_len, const char *account, size_t account_len);
#endif
