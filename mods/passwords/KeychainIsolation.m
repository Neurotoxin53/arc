#import "KeychainIsolation.h"
#import "keychain_rewrite.h"
#import <Security/Security.h>
#include <string.h>

// gLogin is set once in ArcModResolveSecretStorage, which ArcModInit runs before Chromium
// starts. Dyld installs the interpose before initializers; OSCrypt runs later, from main.
static BOOL gResolved;
static BOOL gLogin;
static NSString *gService;
static NSString *gAccount;
static const char *gServiceUTF8;
static const char *gAccountUTF8;

BOOL ArcModResolveSecretStorage(void) {
	if (gResolved) return gLogin;
	gResolved = YES;
	id rawName = [NSBundle.mainBundle objectForInfoDictionaryKey:@"CFBundleName"];
	BOOL named = [rawName isKindOfClass:NSString.class] && ((NSString *)rawName).length > 0;
	NSString *app = named ? (NSString *)rawName : @"ArcMod";
	// "<CFBundleName> Safe Storage" / "<CFBundleName>": ownSafeStorage() in tools/password-keychain.ts.
	gService = [[app stringByAppendingString:@" Safe Storage"] copy];
	gAccount = [app copy];
	gServiceUTF8 = gService.UTF8String;
	gAccountUTF8 = gAccount.UTF8String;
	// Everyday ArcMod only. Validation and agent builds stay on --use-mock-keychain and must not
	// rewrite lookups onto the login keychain. Never Arc's, Chrome's, or Chromium's item.
	BOOL everyday = [NSBundle.mainBundle.bundleIdentifier isEqualToString:@"company.thebrowser.Browser.mod"];
	BOOL foreign = [app isEqualToString:@"Arc"] || [app isEqualToString:@"Chrome"] || [app isEqualToString:@"Chromium"];
	gLogin = everyday && !foreign;
	fprintf(stderr, "[ArcMod] secret storage: %s (%s)\n", gLogin ? "login-keychain" : "mock-keychain", gServiceUTF8);
	return gLogin;
}

BOOL ArcModUsesLoginKeychain(void) {
	return ArcModResolveSecretStorage();
}

static void ArcModNoteRewrite(void) {
	static dispatch_once_t once;
	dispatch_once(&once, ^{
		fprintf(stderr, "[ArcMod] keychain: browser safe storage uses %s\n", gServiceUTF8);
	});
}

// Returns the dictionary to pass through. *owned is true when the caller must CFRelease it.
static CFDictionaryRef ArcModRewriteQuery(CFDictionaryRef query, Boolean *owned) {
	*owned = false;
	if (!gLogin || !query || CFGetTypeID(query) != CFDictionaryGetTypeID()) return query;
	NSDictionary *original = (__bridge NSDictionary *)query;
	id service = original[(__bridge id)kSecAttrService];
	id account = original[(__bridge id)kSecAttrAccount];
	if (![service isKindOfClass:NSString.class] || ![account isKindOfClass:NSString.class]) return query;
	const char *serviceBytes = ((NSString *)service).UTF8String;
	const char *accountBytes = ((NSString *)account).UTF8String;
	if (!serviceBytes || !accountBytes || !ArcModBrowserSafeStoragePair(serviceBytes, strlen(serviceBytes), accountBytes, strlen(accountBytes))) return query;
	NSMutableDictionary *rewritten = [original mutableCopy];
	if (!rewritten) return query;
	rewritten[(__bridge id)kSecAttrService] = gService;
	rewritten[(__bridge id)kSecAttrAccount] = gAccount;
	*owned = true;
	ArcModNoteRewrite();
	return (CFDictionaryRef)CFBridgingRetain(rewritten);
}

static OSStatus ArcModSecItemCopyMatching(CFDictionaryRef query, CFTypeRef *result) {
	Boolean owned = false;
	CFDictionaryRef used = ArcModRewriteQuery(query, &owned);
	OSStatus status = SecItemCopyMatching(used, result);
	if (owned) CFRelease(used);
	return status;
}

static OSStatus ArcModSecItemAdd(CFDictionaryRef attributes, CFTypeRef *result) {
	Boolean owned = false;
	CFDictionaryRef used = ArcModRewriteQuery(attributes, &owned);
	OSStatus status = SecItemAdd(used, result);
	if (owned) CFRelease(used);
	return status;
}

static OSStatus ArcModSecItemUpdate(CFDictionaryRef query, CFDictionaryRef attributes) {
	Boolean queryOwned = false;
	Boolean attributesOwned = false;
	CFDictionaryRef usedQuery = ArcModRewriteQuery(query, &queryOwned);
	CFDictionaryRef usedAttributes = ArcModRewriteQuery(attributes, &attributesOwned);
	OSStatus status = SecItemUpdate(usedQuery, usedAttributes);
	if (queryOwned) CFRelease(usedQuery);
	if (attributesOwned) CFRelease(usedAttributes);
	return status;
}

static OSStatus ArcModSecItemDelete(CFDictionaryRef query) {
	Boolean owned = false;
	CFDictionaryRef used = ArcModRewriteQuery(query, &owned);
	OSStatus status = SecItemDelete(used);
	if (owned) CFRelease(used);
	return status;
}

#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wdeprecated-declarations"
static void ArcModRewriteLegacy(const char **service, UInt32 *serviceLen, const char **account, UInt32 *accountLen) {
	if (!gLogin || !ArcModBrowserSafeStoragePair(*service, *serviceLen, *account, *accountLen)) return;
	*service = gServiceUTF8;
	*account = gAccountUTF8;
	*serviceLen = (UInt32)strlen(gServiceUTF8);
	*accountLen = (UInt32)strlen(gAccountUTF8);
	ArcModNoteRewrite();
}

static OSStatus ArcModFindGenericPassword(SecKeychainRef keychain, UInt32 serviceLen, const char *service, UInt32 accountLen,
	const char *account, UInt32 *passwordLen, void **passwordData, SecKeychainItemRef *item) {
	ArcModRewriteLegacy(&service, &serviceLen, &account, &accountLen);
	return SecKeychainFindGenericPassword(keychain, serviceLen, service, accountLen, account, passwordLen, passwordData, item);
}

static OSStatus ArcModAddGenericPassword(SecKeychainRef keychain, UInt32 serviceLen, const char *service, UInt32 accountLen,
	const char *account, UInt32 passwordLen, const void *passwordData, SecKeychainItemRef *item) {
	ArcModRewriteLegacy(&service, &serviceLen, &account, &accountLen);
	return SecKeychainAddGenericPassword(keychain, serviceLen, service, accountLen, account, passwordLen, passwordData, item);
}
#define ARCMOD_INTERPOSE(replacement, replacee) \
	__attribute__((used)) static const struct { const void *replacement; const void *original; } \
	kArcModInterpose_##replacee __attribute__((section("__DATA,__interpose"))) = { (const void *)(replacement), (const void *)(replacee) }

ARCMOD_INTERPOSE(ArcModSecItemCopyMatching, SecItemCopyMatching);
ARCMOD_INTERPOSE(ArcModSecItemAdd, SecItemAdd);
ARCMOD_INTERPOSE(ArcModSecItemUpdate, SecItemUpdate);
ARCMOD_INTERPOSE(ArcModSecItemDelete, SecItemDelete);
ARCMOD_INTERPOSE(ArcModFindGenericPassword, SecKeychainFindGenericPassword);
ARCMOD_INTERPOSE(ArcModAddGenericPassword, SecKeychainAddGenericPassword);
#pragma clang diagnostic pop
