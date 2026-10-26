#include "keychain_rewrite.h"
#include <stdio.h>
#include <string.h>

static int expect(int id, int condition) {
	if (condition) return 0;
	fprintf(stderr, "keychain rewrite check %d failed\n", id);
	return id;
}

int main(void) {
	const char *arc = "Arc Safe Storage";
	const char *chrome = "Chrome Safe Storage";
	const char *chromium = "Chromium Safe Storage";
	int failed = 0;
	failed += expect(1, ArcModBrowserSafeStoragePair(arc, strlen(arc), "Arc", 3));
	failed += expect(2, ArcModBrowserSafeStoragePair(chrome, strlen(chrome), "Chrome", 6));
	failed += expect(3, ArcModBrowserSafeStoragePair(chromium, strlen(chromium), "Chromium", 8));
	failed += expect(4, !ArcModBrowserSafeStoragePair(arc, strlen(arc), "Chrome", 6));
	failed += expect(5, !ArcModBrowserSafeStoragePair(chrome, strlen(chrome), "Arc", 3));
	failed += expect(6, !ArcModBrowserSafeStoragePair(arc, 3, "Arc", 3));
	failed += expect(7, !ArcModBrowserSafeStoragePair("ArcMod Safe Storage", 18, "ArcMod", 6));
	failed += expect(8, !ArcModBrowserSafeStoragePair(NULL, 0, "Arc", 3));
	failed += expect(9, !ArcModBrowserSafeStoragePair(arc, strlen(arc), NULL, 0));
	failed += expect(10, !ArcModBrowserSafeStoragePair(arc, strlen(arc), "Arc", 2));
	return failed == 0 ? 0 : 1;
}
