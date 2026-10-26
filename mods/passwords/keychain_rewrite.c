#include "keychain_rewrite.h"
#include "ArcModKeychainRewrite.h"
#include <string.h>

static bool ArcModSameName(const char *value, size_t length, const char *literal) {
	size_t literalLength = strlen(literal);
	return value != NULL && length == literalLength && memcmp(value, literal, literalLength) == 0;
}

bool ArcModBrowserSafeStoragePair(const char *service, size_t service_len, const char *account, size_t account_len) {
	if (service == NULL || account == NULL) return false;
	for (size_t i = 0; i < kArcModSafeStoragePairCount; i++) {
		if (ArcModSameName(service, service_len, kArcModSafeStoragePairs[i].service) &&
			ArcModSameName(account, account_len, kArcModSafeStoragePairs[i].account)) return true;
	}
	return false;
}
